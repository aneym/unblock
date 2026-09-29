import { VOICE_SYSTEM_PROMPT, VOICE_TOOLS, xaiTools, type VoiceSessionToken, type VoiceToolDeclaration } from '../../../src/voice.js'
import type { VoiceAdapter, VoiceAdapterCallbacks } from './voice-live'

export function connectXai(token: VoiceSessionToken, callbacks: VoiceAdapterCallbacks, profile: { prompt: string; tools: VoiceToolDeclaration[]; kickoff?: string } = { prompt: VOICE_SYSTEM_PROMPT, tools: VOICE_TOOLS }, options: { speed?: number } = {}): Promise<VoiceAdapter> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://api.x.ai/v1/realtime?model=${encodeURIComponent(token.model)}`,
      [`xai-client-secret.${token.token}`])
    let opened = false
    let closed = false
    const tools = new Map<string, { calls: Promise<void>[]; done: boolean; responded: boolean }>()
    let activeResponse = ''
    const send = (event: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)) }
    const safeMessage = (message: string) => message.replaceAll(token.token, '[redacted]')
    socket.onopen = () => {
      if (closed) { socket.close(); return }
      opened = true
      send({ type: 'session.update', session: {
        voice: token.voice, instructions: profile.prompt, turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'grok-transcribe' } },
          output: { format: { type: 'audio/pcm', rate: 24000 }, speed: options.speed ?? 1 },
        },
        tools: xaiTools(profile.tools),
      } })
      send({ type: 'conversation.item.create', item: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: profile.kickoff ?? 'Start the call.' }],
      } })
      send({ type: 'response.create' })
      callbacks.onOpen()
      resolve({
        sampleRate: 24000,
        setSpeed: (speed) => send({ type: 'session.update', session: { audio: { output: { speed } } } }),
        sendAudio: (audio) => send({ type: 'input_audio_buffer.append', audio }),
        sendToolResults: (results) => {
          for (const result of results) send({ type: 'conversation.item.create', item: {
            type: 'function_call_output', call_id: result.id,
            output: JSON.stringify({ ok: result.ok, speech: result.speech }),
          } })
        },
        close: () => { closed = true; socket.close() },
      })
    }
    socket.onmessage = (message) => {
      if (closed) return
      let event: Record<string, unknown>
      try { event = JSON.parse(message.data) as Record<string, unknown> } catch { return }
      switch (event.type) {
        case 'response.output_audio.delta':
          if (typeof event.delta === 'string') callbacks.onAudio(event.delta)
          break
        case 'response.output_audio_transcript.delta':
          if (typeof event.delta === 'string') callbacks.onTranscript('agent', event.delta, 'append')
          break
        case 'conversation.item.input_audio_transcription.updated': {
          const text = event.transcript ?? event.delta
          if (typeof text === 'string') callbacks.onTranscript('you', text, 'replace')
          break
        }
        case 'input_audio_buffer.speech_started': callbacks.onInterrupted(); break
        case 'response.created':
          activeResponse = (event.response as { id?: string } | undefined)?.id || String(event.response_id || '')
          break
        case 'response.function_call_arguments.done': {
          let args: Record<string, unknown> = {}
          try {
            const parsed: unknown = JSON.parse(typeof event.arguments === 'string' ? event.arguments : '{}')
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
          } catch { /* Invalid arguments become an empty object. */ }
          const responseId = String(event.response_id || activeResponse)
          const response = tools.get(responseId) || { calls: [], done: false, responded: false }
          response.calls.push(callbacks.onToolCalls([{ id: String(event.call_id ?? ''), name: String(event.name ?? ''), args }]))
          tools.set(responseId, response)
          if (response.done && !response.responded) {
            response.responded = true
            void Promise.all(response.calls).then(() => { if (!closed) send({ type: 'response.create' }) })
              .catch((error: unknown) => callbacks.onError(error instanceof Error ? error.message : 'Voice tool failed.'))
              .finally(() => tools.delete(responseId))
          }
          break
        }
        case 'response.done': {
          callbacks.onTurnDone()
          const responseId = (event.response as { id?: string } | undefined)?.id || String(event.response_id || activeResponse)
          const response = tools.get(responseId)
          if (response) {
            response.done = true
            if (!response.responded) {
              response.responded = true
              void Promise.all(response.calls).then(() => { if (!closed) send({ type: 'response.create' }) })
                .catch((error: unknown) => callbacks.onError(error instanceof Error ? error.message : 'Voice tool failed.'))
                .finally(() => tools.delete(responseId))
            }
          }
          break
        }
        case 'error': {
          const detail = event.error as { message?: string } | undefined
          callbacks.onError(safeMessage(detail?.message || 'Voice connection failed. Please try again.'))
          break
        }
      }
    }
    socket.onerror = () => {
      if (!opened) reject(new Error('Voice connection failed. Please try again.'))
      else callbacks.onError('Voice connection failed. Please try again.')
    }
    socket.onclose = (event) => {
      if (!opened) reject(new Error('Voice connection closed. Please try again.'))
      else if (!closed) callbacks.onClose(event.wasClean, safeMessage(event.reason))
    }
  })
}
