import { GoogleGenAI, Modality, type FunctionDeclaration, type Session } from '@google/genai'
import { createVoiceSession, VOICE_SYSTEM_PROMPT, VOICE_TOOLS, type VoiceSessionToken } from '../../../src/voice.js'
import type { Ask } from '../deck'
import { api, ApiError } from './api'
import { createPlayer, startMic } from './voice-audio'

export type VoiceState =
  | { name: 'connecting' | 'listening' | 'speaking' | 'ended' | 'unconfigured' }
  | { name: 'error'; message: string }
export type TranscriptLine = { who: 'you' | 'agent'; text: string }

interface VoiceCallbacks {
  onState(state: VoiceState): void
  onTranscript(line: TranscriptLine): void
  onTicket(ticket: string): void
  onChanged(): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Voice call failed. Please try again.'
}

/** The AudioContext must be created and resumed by the tap handler before import(). */
export function startVoiceCall(audio: AudioContext, { onState, onTranscript, onTicket, onChanged }: VoiceCallbacks): { stop(): void } {
  let stopped = false
  let live: Session | undefined
  let mic: { stop(): void } | undefined
  let pendingTools = Promise.resolve()
  const cancelledCalls = new Set<string>()
  const player = createPlayer(audio)
  const rules = createVoiceSession<Ask>({
    getAsks: async () => (await api<{ asks: Ask[] }>('/api/queue')).asks,
    postAnswer: (body) => api('/api/answer', body),
  })
  const transcripts: Record<TranscriptLine['who'], string> = { you: '', agent: '' }
  const appendTranscript = (who: TranscriptLine['who'], text: string) => {
    if (!text) return
    transcripts[who] += text
    onTranscript({ who, text: transcripts[who] })
  }
  const release = () => {
    if (stopped) return
    stopped = true
    mic?.stop()
    player.flush()
    live?.close()
    void audio.close()
  }
  const fail = (message: string) => {
    if (stopped) return
    release()
    onState({ name: 'error', message })
  }
  onState({ name: 'connecting' })
  void (async () => {
    try {
      const token = await api<VoiceSessionToken>('/api/voice/session', {})
      if (stopped) return
      const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: 'v1alpha' } })
      live = await ai.live.connect({
        model: token.model,
        config: {
          responseModalities: [Modality.AUDIO], systemInstruction: VOICE_SYSTEM_PROMPT,
          // The shared declarations use the SDK's OpenAPI Schema wire format.
          tools: [{ functionDeclarations: VOICE_TOOLS.map(({ name, description, parameters }) =>
            ({ name, description, parameters: parameters as FunctionDeclaration['parameters'] }) satisfies FunctionDeclaration) }],
          inputAudioTranscription: {}, outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => { if (!stopped) onState({ name: 'listening' }) },
          onmessage: (event) => {
            if (stopped) return
            const content = event.serverContent
            if (content?.interrupted) { player.flush(); onState({ name: 'listening' }) }
            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
                player.enqueue(part.inlineData.data)
                onState({ name: 'speaking' })
              }
            }
            if (content?.inputTranscription?.text) appendTranscript('you', content.inputTranscription.text)
            if (content?.outputTranscription?.text) appendTranscript('agent', content.outputTranscription.text)
            if (content?.turnComplete) {
              transcripts.you = ''
              transcripts.agent = ''
              player.whenDrained(() => { if (!stopped) onState({ name: 'listening' }) })
            }
            for (const id of event.toolCallCancellation?.ids ?? []) cancelledCalls.add(id)
            if (event.toolCall?.functionCalls?.length) {
              // Preserve tool order so preview/answer session guards are not raced.
              const calls = event.toolCall.functionCalls
              pendingTools = pendingTools.then(async () => {
                for (const call of calls) {
                  if (stopped) return
                  if (call.id && cancelledCalls.has(call.id)) continue
                  const result = await rules.handle(call.name ?? '', call.args ?? {})
                  if (stopped) return
                  if (result.ticket) onTicket(result.ticket)
                  if (result.changed) onChanged()
                  if (call.id && cancelledCalls.has(call.id)) continue
                  live?.sendToolResponse({ functionResponses: [{ id: call.id, name: call.name,
                    response: { ok: result.ok, speech: result.speech } }] })
                }
              }).catch((error) => fail(messageOf(error)))
            }
          },
          onerror: (event) => fail(event.message || 'Voice connection failed. Please try again.'),
          onclose: (event) => {
            if (stopped) return
            release()
            onState(event.wasClean
              ? { name: 'ended' }
              : { name: 'error', message: event.reason || 'Voice connection closed. Please try again.' })
          },
        },
      })
      if (stopped) { live.close(); return }
      live.sendClientContent({ turns: 'Start the call.', turnComplete: true })
      await audio.resume()
      if (stopped) return
      mic = await startMic(audio, (data) => { if (!stopped) live?.sendRealtimeInput({ audio: { data, mimeType: 'audio/pcm;rate=16000' } }) }, () => stopped)
      if (stopped) { mic.stop(); return }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VOICE_NOT_CONFIGURED') {
        release()
        onState({ name: 'unconfigured' })
      } else fail(messageOf(error))
    }
  })()
  return { stop() { release(); onState({ name: 'ended' }) } }
}
