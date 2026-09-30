import { createVoiceSession, type VoiceProvider, type VoiceSessionToken, type VoiceSpend, type VoiceUi, type VoiceToolDeclaration, VOICE_SYSTEM_PROMPT, VOICE_TOOLS } from '../../../src/voice.js'
import type { Ask } from '../deck'
import { api, ApiError } from './api'
import { createPlayer, startMic, voiceAudioError } from './voice-audio'
import { connectGemini } from './voice-gemini'
import { connectXai } from './voice-xai'
import { connectOpenAi } from './voice-openai'
import { connectGptLive } from './voice-gptlive'

export type VoiceState =
  | { name: 'connecting' | 'listening' | 'speaking' | 'ended' | 'unconfigured' }
  | { name: 'capped'; cap?: number }
  | { name: 'error'; message: string }
export type TranscriptLine = { who: 'you' | 'agent'; text: string }

export interface VoiceAdapter {
  sampleRate: 16000 | 24000
  media?: boolean
  sendAudio(audio: string): void
  setSpeed?(v: number): void
  sendToolResults(results: { id: string; name: string; ok: boolean; speech: string; context?: string }[]): void
  close(): void
}
export interface VoiceAdapterCallbacks {
  onOpen(): void
  onSpeaking?(): void
  onAudio(data: string): void
  onInterrupted(): void
  onTranscript(who: TranscriptLine['who'], text: string, mode: 'append' | 'replace'): void
  onTurnDone(): void
  onToolCalls(calls: { id: string; name: string; args: Record<string, unknown> }[]): Promise<void>
  onCancelled(ids: string[]): void
  onError(message: string): void
  onClose(clean: boolean, reason: string): void
}

export interface VoiceProfile {
  kickoff?: string
  prompt: string
  tools: VoiceToolDeclaration[]
  rules: { handle(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; speech: string; context?: string; ui?: any; changed?: boolean }> }
  session?: Record<string, unknown>
}

interface VoiceCallbacks {
  onState(state: VoiceState): void
  onTranscript(line: TranscriptLine): void
  onAssistantSaid?(text: string): void
  onUi(ui: VoiceUi): void
  onChanged(): void
  onSession(session: { provider: VoiceProvider; spend: VoiceSpend; maxMinutes: number }): void
}

function messageOf(error: unknown): string {
  return voiceAudioError(error)
}

/** The AudioContext must be created and resumed by the tap handler before import(). */
export function startVoiceCall(audio: AudioContext, { onState, onTranscript, onAssistantSaid, onUi, onChanged, onSession }: VoiceCallbacks,
  options: { provider?: VoiceProvider; profile?: VoiceProfile } = {}): { stop(): void; setSpeed(v: number): void } {
  const clampSpeed = (v: number) => Math.round(Math.max(0.7, Math.min(1.5, Number.isFinite(v) ? v : 1.5)) * 10) / 10
  let speed = 1.5
  try {
    const saved = localStorage.getItem('unblock.voice.speed')
    if (saved !== null) speed = clampSpeed(Number(saved))
  } catch { /* Storage may be unavailable. */ }
  let stopped = false
  let live: VoiceAdapter | undefined
  let mic: { stop(): void } | undefined
  let pendingTools = Promise.resolve()
  let session: VoiceSessionToken | undefined
  let startedAt = 0
  let fetchStartedAt = 0
  let firstAudioMs: number | null = null
  let toolCalls = 0
  let toolOk = 0
  const metrics = () => ({ first_audio_ms: firstAudioMs, tool_calls: toolCalls, tool_ok: toolOk, profile: options.profile ? 'scope' : 'queue' })
  let endTimer: number | undefined
  let goodbyeTimer: number | undefined
  let endingTurn: number | undefined
  let endingRequested = false
  let completedTurns = 0
  let audioEpoch = 0
  let toolResponsesPending = 0
  let awaitingToolTurn = false
  let toolsTurnDone = false
  let toolTurn = 0
  let awaitingGoodbyeAudio = false
  const cancelledCalls = new Set<string>()
  const player = createPlayer(audio)
  const connecting = new AbortController()
  let rules = options.profile?.rules
  const tellSpeed = () => window.dispatchEvent(new CustomEvent('unblock:voice-speed', { detail: speed }))
  const setSpeed = (v: number) => {
    if (stopped || session?.provider === 'gemini' || session?.provider === 'live') return
    speed = clampSpeed(v)
    try { localStorage.setItem('unblock.voice.speed', String(speed)) } catch { /* Storage may be unavailable. */ }
    live?.setSpeed?.(speed)
    tellSpeed()
  }
  const onSpeedRequest = (event: Event) => setSpeed((event as CustomEvent<number>).detail)
  window.addEventListener('unblock:voice-set-speed', onSpeedRequest)
  const transcripts: Record<TranscriptLine['who'], string> = { you: '', agent: '' }
  const release = () => {
    if (stopped) return
    stopped = true
    connecting.abort()
    window.removeEventListener('unblock:voice-set-speed', onSpeedRequest)
    window.clearTimeout(endTimer)
    window.clearTimeout(goodbyeTimer)
    mic?.stop()
    if (!live?.media) player.flush()
    live?.close()
    void audio.close()
    if (session) void fetch('/api/voice/end', {
      method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ session_id: session.session_id, seconds: Math.max(0, Math.ceil((Date.now() - startedAt) / 1000)), metrics: metrics() }),
    }).catch(() => undefined)
  }
  const fail = (message: string) => {
    if (stopped) return
    release()
    onState({ name: 'error', message })
  }
  const end = () => { if (!stopped) { release(); onState({ name: 'ended' }) } }
  const afterPlayback = (turn: number, toolResponse = false) => {
    const epoch = audioEpoch
    const drained = () => {
      if (stopped || epoch !== audioEpoch) return
      if (endingTurn !== undefined && turn >= endingTurn) {
        if (!awaitingGoodbyeAudio) end()
      } else if (!endingRequested && (toolResponse || turn !== toolTurn)) onState({ name: 'listening' })
    }
    if (live?.media) drained()
    else player.whenDrained(drained)
  }
  const callbacks: VoiceAdapterCallbacks = {
    onOpen: () => { if (!stopped) onState({ name: 'listening' }) },
    onSpeaking: () => {
      if (stopped) return
      if (firstAudioMs === null) firstAudioMs = Math.max(0, Date.now() - fetchStartedAt)
      awaitingGoodbyeAudio = false
      onState({ name: 'speaking' })
    },
    onAudio: (data) => {
      if (stopped) return
      if (firstAudioMs === null) firstAudioMs = Math.max(0, Date.now() - fetchStartedAt)
      if (awaitingGoodbyeAudio) awaitingGoodbyeAudio = false
      audioEpoch++
      if (!live?.media) player.enqueue(data)
      onState({ name: 'speaking' })
    },
    onInterrupted: () => {
      if (stopped) return
      audioEpoch++
      if (!live?.media) player.flush()
      onState({ name: 'listening' })
    },
    onTranscript: (who, text, mode) => {
      if (stopped || !text) return
      transcripts[who] = mode === 'replace' ? text : transcripts[who] + text
      onTranscript({ who, text: transcripts[who] })
    },
    onTurnDone: () => {
      if (stopped) return
      if (transcripts.agent) onAssistantSaid?.(transcripts.agent)
      transcripts.you = ''
      transcripts.agent = ''
      const turn = ++completedTurns
      if (awaitingToolTurn) { toolsTurnDone = true; toolTurn = turn }
      if (endingRequested && endingTurn === undefined) {
        endingTurn = awaitingToolTurn ? turn + 1 : turn
        if (awaitingToolTurn) awaitingGoodbyeAudio = true
      }
      if (endingTurn !== undefined && turn >= endingTurn) awaitingGoodbyeAudio = false
      if (!toolResponsesPending) afterPlayback(turn, awaitingToolTurn && !endingRequested)
      awaitingToolTurn = false
    },
    onToolCalls: (calls) => {
      awaitingToolTurn = true
      toolsTurnDone = false
      toolTurn = 0
      toolResponsesPending++
      pendingTools = pendingTools.then(async () => {
        for (const call of calls) {
          if (stopped) return
          if (call.id && cancelledCalls.has(call.id)) continue
          const result = await rules!.handle(call.name, call.args)
          toolCalls++
          if (result.ok) toolOk++
          if (stopped) return
          if (result.ui) {
            if (result.ui.do === 'end_call' && !endingRequested) {
              endingRequested = true
              if (toolsTurnDone) {
                endingTurn = completedTurns + 1
                awaitingGoodbyeAudio = true
              }
              goodbyeTimer = window.setTimeout(end, 6000)
            }
            if (result.ui.do === 'speed') {
              const ui = result.ui as Extract<VoiceUi, { do: 'speed' }>
              setSpeed(ui.value ?? (ui.change === 'normal' ? 1 : speed + (ui.change === 'faster' ? 0.1 : ui.change === 'slower' ? -0.1 : 0)))
            }
            if (result.ui.do === 'filed') {
              window.dispatchEvent(new CustomEvent('unblock:voice-filed', { detail: result.ui }))
            }
            onUi(result.ui)
          }
          if (result.changed) onChanged()
          if (call.id && cancelledCalls.has(call.id)) continue
          live?.sendToolResults([{ id: call.id, name: call.name, ok: result.ok, speech: result.speech, ...(typeof result.context === 'string' ? { context: result.context.slice(0, 12000) } : {}) }])
        }
        toolResponsesPending--
        if (!toolResponsesPending && toolTurn && (endingTurn === undefined || toolTurn >= endingTurn)) afterPlayback(toolTurn, true)
      }).catch((error) => fail(messageOf(error)))
      return pendingTools
    },
    onCancelled: (ids) => { for (const id of ids) cancelledCalls.add(id) },
    onError: fail,
    onClose: (clean, reason) => {
      if (stopped) return
      if (clean) end()
      else fail(reason || 'Voice connection closed. Please try again.')
    },
  }
  onState({ name: 'connecting' })
  void (async () => {
    try {
      // Fetch directly to retain the spend cap in a 402 response.
      fetchStartedAt = Date.now()
      const response = await fetch('/api/voice/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: options.provider, speed, ...options.profile?.session }), cache: 'no-store',
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { code?: string; error?: string; cap_usd?: number; spend?: VoiceSpend }
        if (response.status === 402 && body.code === 'VOICE_SPEND_CAP') {
          release()
          onState({ name: 'capped', cap: body.cap_usd ?? body.spend?.cap_usd })
          return
        }
        throw new ApiError(body.error || `HTTP ${response.status}`, body.code)
      }
      const token = await response.json() as VoiceSessionToken
      session = token
      rules ??= createVoiceSession<Ask>({
        getAsks: async () => (await api<{ asks: Ask[] }>('/api/queue')).asks,
        postAnswer: (body) => api('/api/answer', body),
        fileIssue: (issue) => api('/api/voice/issue', issue),
        provider: token.provider,
      })
      startedAt = Date.now()
      if (stopped) {
        void fetch('/api/voice/end', {
          method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
          body: JSON.stringify({ session_id: token.session_id, seconds: 0, metrics: metrics() }),
        }).catch(() => undefined)
        return
      }
      onSession({ provider: token.provider, spend: token.spend, maxMinutes: token.max_minutes })
      endTimer = window.setTimeout(end, token.max_minutes * 60_000)
      const profile = options.profile || { prompt: VOICE_SYSTEM_PROMPT, tools: VOICE_TOOLS }
      live = token.provider === 'live' ? await connectGptLive(token, callbacks, profile, { signal: connecting.signal }) : token.provider === 'openai' ? await connectOpenAi(token, callbacks, profile, { speed }) : token.provider === 'xai' ? await connectXai(token, callbacks, profile, { speed }) : await connectGemini(token, callbacks, profile)
      if (stopped) { live.close(); return }
      if (token.provider !== 'gemini' && token.provider !== 'live') { live.setSpeed?.(speed); tellSpeed() }
      await audio.resume()
      if (stopped) return
      if (live.media) return
      mic = await startMic(audio, live.sampleRate, (data) => { if (!stopped) live?.sendAudio(data) }, () => stopped)
      if (stopped) { mic.stop(); return }
    } catch (error) {
      if (stopped) return
      if (error instanceof ApiError && error.code === 'VOICE_NOT_CONFIGURED') {
        release()
        onState({ name: 'unconfigured' })
      } else fail(messageOf(error))
    }
  })()
  return { stop: end, setSpeed }
}
