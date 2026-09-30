import { VOICE_SYSTEM_PROMPT, VOICE_TOOLS, type VoiceSessionToken, type VoiceToolDeclaration } from '../../../src/voice.js'
import { ApiError } from './api'
import type { VoiceAdapter, VoiceAdapterCallbacks } from './voice-live'

export function connectGptLive(token: VoiceSessionToken, callbacks: VoiceAdapterCallbacks, profile: { prompt: string; tools: VoiceToolDeclaration[]; kickoff?: string } = { prompt: VOICE_SYSTEM_PROMPT, tools: VOICE_TOOLS }, options: { signal?: AbortSignal } = {}): Promise<VoiceAdapter> {
  return new Promise((resolve, reject) => {
    const peer = new RTCPeerConnection()
    const channel = peer.createDataChannel('oai-events')
    const audio = new Audio()
    audio.autoplay = true
    document.body.append(audio)
    let stream: MediaStream | undefined
    let opened = false
    let closed = false
    let activeResponse = ''
    let turnTimer: number | undefined
    const delegatedResponses = new Set<string>()
    const tools = new Map<string, { calls: Promise<void>[]; done: boolean; responded: boolean }>()
    const send = (event: object) => { if (channel.readyState === 'open') channel.send(JSON.stringify(event)) }
    const controller = new AbortController()
    const close = () => {
      if (closed) return
      send({ type: 'session.close' })
      closed = true
      window.clearTimeout(timer)
      window.clearTimeout(turnTimer)
      controller.abort()
      options.signal?.removeEventListener('abort', abort)
      stream?.getTracks().forEach((track) => track.stop())
      channel.close()
      peer.close()
      audio.pause()
      audio.srcObject = null
      audio.remove()
    }
    const fail = (error: Error = new Error('Voice connection failed. Please try again.')) => {
      if (closed) return
      close()
      if (!opened) reject(error)
      else callbacks.onError(error.message)
    }
    const abort = () => fail()
    const timer = window.setTimeout(() => fail(), 10_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    const adapter: VoiceAdapter = {
      sampleRate: 24000, media: true,
      sendAudio: () => {},
      sendToolResults: (results) => {
        for (const result of results) send({ type: 'response.item.create', event_id: crypto.randomUUID(), item: {
          type: 'function_call_output', call_id: result.id,
          output: JSON.stringify({ ok: result.ok, speech: result.speech, ...(result.context ? { context: result.context } : {}) }),
        } })
      },
      close,
    }
    const finishTools = (id: string) => {
      const response = tools.get(id)
      if (!response || !response.done || response.responded) return
      response.responded = true
      void Promise.all(response.calls).then(() => { if (!closed) send({ type: 'response.create', event_id: crypto.randomUUID() }) })
        .catch(() => fail(new Error('Voice tool failed.')))
        .finally(() => tools.delete(id))
    }
    peer.ontrack = (event) => {
      if (closed) return
      audio.srcObject = event.streams[0] || new MediaStream([event.track])
      void audio.play().catch(() => fail())
    }
    peer.onconnectionstatechange = () => {
      if (!closed && peer.connectionState === 'failed') fail()
    }
    channel.onerror = () => fail()
    channel.onclose = () => {
      if (closed) return
      if (!opened) fail()
      else { close(); callbacks.onClose(false, 'Voice connection closed. Please try again.') }
    }
    channel.onmessage = (message) => {
      if (closed) return
      let event: Record<string, any>
      try { event = JSON.parse(message.data) } catch { return }
      switch (event.type) {
        case 'session.started':
          if (opened) return
          opened = true
          window.clearTimeout(timer)
          callbacks.onOpen()
          resolve(adapter)
          break
        case 'session.input_transcript.delta':
          if (typeof event.delta === 'string') callbacks.onTranscript('you', event.delta, 'append')
          break
        case 'session.output_transcript.delta':
          if (typeof event.delta === 'string') {
            callbacks.onSpeaking?.()
            callbacks.onTranscript('agent', event.delta, 'append')
            window.clearTimeout(turnTimer)
            turnTimer = window.setTimeout(() => {
              if (!closed && !delegatedResponses.size) callbacks.onTurnDone()
            }, 1200)
          }
          break
        case 'session.output_transcript.done':
        case 'session.output_audio.done':
          window.clearTimeout(turnTimer)
          callbacks.onTurnDone()
          break
        case 'response.event': {
          const wrapped = event.event
          if (!wrapped || typeof wrapped !== 'object') break
          const id = String(wrapped.response?.id || wrapped.response_id || activeResponse || event.delegation_id || '')
          if (wrapped.type === 'response.created') { activeResponse = id; delegatedResponses.add(id) }
          if (wrapped.type === 'response.output_item.done' && wrapped.item?.type === 'function_call') {
            const item = wrapped.item
            let args: Record<string, unknown> = {}
            try {
              const parsed: unknown = JSON.parse(typeof item.arguments === 'string' ? item.arguments : '{}')
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
            } catch { /* Invalid arguments become an empty object. */ }
            const response = tools.get(id) || { calls: [], done: false, responded: false }
            response.calls.push(callbacks.onToolCalls([{ id: String(item.call_id || ''), name: String(item.name || ''), args }]))
            tools.set(id, response)
            finishTools(id)
          }
          if (wrapped.type === 'response.completed') {
            delegatedResponses.delete(id)
            window.clearTimeout(turnTimer)
            callbacks.onTurnDone()
            const response = tools.get(id)
            if (response) { response.done = true; finishTools(id) }
          }
          break
        }
        case 'session.closed':
          if (!opened) { fail(); break }
          close()
          callbacks.onClose(true, '')
          break
        case 'error': fail(); break
      }
    }
    void (async () => {
      try {
        if (options.signal?.aborted) { fail(); return }
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (closed) { stream.getTracks().forEach((track) => track.stop()); return }
        for (const track of stream.getTracks()) peer.addTrack(track, stream)
        await peer.setLocalDescription(await peer.createOffer())
        if (closed) return
        if (peer.iceGatheringState !== 'complete') await new Promise<void>((done) => {
          const finish = () => { window.clearTimeout(iceTimer); peer.removeEventListener('icegatheringstatechange', change); controller.signal.removeEventListener('abort', finish); done() }
          const change = () => { if (peer.iceGatheringState === 'complete') finish() }
          const iceTimer = window.setTimeout(finish, 3000)
          peer.addEventListener('icegatheringstatechange', change)
          controller.signal.addEventListener('abort', finish, { once: true })
        })
        if (closed) return
        const response = await fetch('/api/voice/live/connect', {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ session_id: token.session_id, sdp: peer.localDescription?.sdp, prompt: profile.prompt, tools: profile.tools }),
        })
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          if (response.status === 503 && body.code === 'VOICE_NOT_CONFIGURED') throw new ApiError('Voice is not configured', body.code)
          throw new Error('Voice connection failed. Please try again.')
        }
        const body = await response.json()
        if (typeof body.sdp !== 'string' || !body.sdp) throw new Error('Voice connection failed. Please try again.')
        if (!closed) await peer.setRemoteDescription({ type: 'answer', sdp: body.sdp })
      } catch (error) {
        fail(error instanceof ApiError ? error : undefined)
      }
    })()
  })
}
