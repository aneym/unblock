import { GoogleGenAI, Modality, type FunctionDeclaration, type Session } from '@google/genai'
import { VOICE_SYSTEM_PROMPT, VOICE_TOOLS, type VoiceSessionToken, type VoiceToolDeclaration } from '../../../src/voice.js'
import type { VoiceAdapter, VoiceAdapterCallbacks } from './voice-live'

export async function connectGemini(token: VoiceSessionToken, callbacks: VoiceAdapterCallbacks, profile: { prompt: string; tools: VoiceToolDeclaration[]; kickoff?: string } = { prompt: VOICE_SYSTEM_PROMPT, tools: VOICE_TOOLS }): Promise<VoiceAdapter> {
  const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: 'v1alpha' } })
  const live: Session = await ai.live.connect({
    model: token.model,
    config: {
      responseModalities: [Modality.AUDIO], systemInstruction: profile.prompt,
      tools: [{ functionDeclarations: profile.tools.map(({ name, description, parameters }) =>
        ({ name, description, parameters: parameters as FunctionDeclaration['parameters'] }) satisfies FunctionDeclaration) }],
      inputAudioTranscription: {}, outputAudioTranscription: {},
    },
    callbacks: {
      onopen: callbacks.onOpen,
      onmessage: (event) => {
        const content = event.serverContent
        if (content?.interrupted) callbacks.onInterrupted()
        for (const part of content?.modelTurn?.parts ?? []) {
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) callbacks.onAudio(part.inlineData.data)
        }
        if (content?.inputTranscription?.text) callbacks.onTranscript('you', content.inputTranscription.text, 'append')
        if (content?.outputTranscription?.text) callbacks.onTranscript('agent', content.outputTranscription.text, 'append')
        if (content?.turnComplete) callbacks.onTurnDone()
        if (event.toolCallCancellation?.ids?.length) callbacks.onCancelled(event.toolCallCancellation.ids)
        if (event.toolCall?.functionCalls?.length) callbacks.onToolCalls(event.toolCall.functionCalls.map((call) => ({
          id: call.id || '', name: call.name || '', args: call.args || {},
        })))
      },
      onerror: (event) => callbacks.onError(event.message || 'Voice connection failed. Please try again.'),
      onclose: (event) => callbacks.onClose(event.wasClean, event.reason),
    },
  })
  live.sendClientContent({ turns: profile.kickoff ?? 'Start the call.', turnComplete: true })
  return {
    sampleRate: 16000,
    sendAudio: (audio) => live.sendRealtimeInput({ audio: { data: audio, mimeType: 'audio/pcm;rate=16000' } }),
    sendToolResults: (results) => {
      for (const result of results) live.sendToolResponse({ functionResponses: [{
        id: result.id, name: result.name, response: { ok: result.ok, speech: result.speech },
      }] })
    },
    close: () => live.close(),
  }
}
