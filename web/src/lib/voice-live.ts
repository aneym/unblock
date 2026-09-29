import { createVoiceSession, type VoiceProvider, type VoiceSessionToken, type VoiceSpend, type VoiceUi, type VoiceToolDeclaration, VOICE_SYSTEM_PROMPT, VOICE_TOOLS } from '../../../src/voice.js'
import type { Ask } from '../deck'
import { api, ApiError } from './api'
import { createPlayer, startMic, voiceAudioError } from './voice-audio'
import { connectGemini } from './voice-gemini'
import { connectXai } from './voice-xai'

export type VoiceState =
  | { name: 'connecting' | 'listening' | 'speaking' | 'ended' | 'unconfigured' }
  | { name: 'capped'; cap?: number }
  | { name: 'error'; message: string }
export type TranscriptLine = { who: 'you' | 'agent'; text: string }

export interface VoiceAdapter {
  sampleRate: 16000 | 24000
  sendAudio(audio: string): void
  sendToolResults(results: { id: string; name: string; ok: boolean; speech: string }[]): void
  close(): void
}
export interface VoiceAdapterCallbacks {
  onOpen(): void
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
  prompt: string
  tools: VoiceToolDeclaration[]
  rules: { handle(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; speech: string; ui?: any; changed?: boolean }> }
  session?: Record<string, unknown>
}

interface VoiceCallbacks {
  onState(state: VoiceState): void
  onTranscript(line: TranscriptLine): void
  onUi(ui: VoiceUi): void
  onChanged(): void
  onSession(session: { provider: VoiceProvider; spend: VoiceSpend; maxMinutes: number }): void
}

function messageOf(error: unknown): string {
  return voiceAudioError(error)
}

/** The AudioContext must be created and resumed by the tap handler before import(). */
export function startVoiceCall(audio: AudioContext, { onState, onTranscript, onUi, onChanged, onSession }: VoiceCallbacks,
  options: { provider?: VoiceProvider; profile?: VoiceProfile } = {}): { stop(): void } {
  let stopped = false
  let live: VoiceAdapter | undefined
  let mic: { stop(): void } | undefined
  let pendingTools = Promise.resolve()
  let session: VoiceSessionToken | undefined
  let startedAt = 0
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
  const rules = options.profile?.rules ?? createVoiceSession<Ask>({
    getAsks: async () => (await api<{ asks: Ask[] }>('/api/queue')).asks,
    postAnswer: (body) => api('/api/answer', body),
    fileIssue: (issue) => api('/api/voice/issue', issue),
  })
  const transcripts: Record<TranscriptLine['who'], string> = { you: '', agent: '' }
  const release = () => {
    if (stopped) return
    stopped = true
    window.clearTimeout(endTimer)
    window.clearTimeout(goodbyeTimer)
    mic?.stop()
    player.flush()
    live?.close()
    void audio.close()
    if (session) void fetch('/api/voice/end', {
      method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ session_id: session.session_id, seconds: Math.max(0, Math.ceil((Date.now() - startedAt) / 1000)) }),
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
    player.whenDrained(() => {
      if (stopped || epoch !== audioEpoch) return
      if (endingTurn !== undefined && turn >= endingTurn) {
        if (!awaitingGoodbyeAudio) end()
      } else if (!endingRequested && (toolResponse || turn !== toolTurn)) onState({ name: 'listening' })
    })
  }
  const callbacks: VoiceAdapterCallbacks = {
    onOpen: () => { if (!stopped) onState({ name: 'listening' }) },
    onAudio: (data) => {
      if (stopped) return
      if (awaitingGoodbyeAudio) awaitingGoodbyeAudio = false
      audioEpoch++
      player.enqueue(data)
      onState({ name: 'speaking' })
    },
    onInterrupted: () => {
      if (stopped) return
      audioEpoch++
      player.flush()
      onState({ name: 'listening' })
    },
    onTranscript: (who, text, mode) => {
      if (stopped || !text) return
      transcripts[who] = mode === 'replace' ? text : transcripts[who] + text
      onTranscript({ who, text: transcripts[who] })
    },
    onTurnDone: () => {
      if (stopped) return
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
          const result = await rules.handle(call.name, call.args)
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
            if (result.ui.do === 'filed') {
              window.dispatchEvent(new CustomEvent('unblock:voice-filed', { detail: result.ui }))
            }
            onUi(result.ui)
          }
          if (result.changed) onChanged()
          if (call.id && cancelledCalls.has(call.id)) continue
          live?.sendToolResults([{ id: call.id, name: call.name, ok: result.ok, speech: result.speech }])
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
      const response = await fetch('/api/voice/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: options.provider, ...options.profile?.session }), cache: 'no-store',
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
      startedAt = Date.now()
      if (stopped) {
        void fetch('/api/voice/end', {
          method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
          body: JSON.stringify({ session_id: token.session_id, seconds: 0 }),
        }).catch(() => undefined)
        return
      }
      onSession({ provider: token.provider, spend: token.spend, maxMinutes: token.max_minutes })
      endTimer = window.setTimeout(end, token.max_minutes * 60_000)
      const profile = options.profile || { prompt: VOICE_SYSTEM_PROMPT, tools: VOICE_TOOLS }
      live = token.provider === 'xai' ? await connectXai(token, callbacks, profile) : await connectGemini(token, callbacks, profile)
      if (stopped) { live.close(); return }
      await audio.resume()
      if (stopped) return
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
  return { stop: end }
}
