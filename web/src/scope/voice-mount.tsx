import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VoiceBar } from '../VoiceBar'
import { prepareAudio } from '../lib/voice-audio'
import { startVoiceCall, type TranscriptLine, type VoiceState } from '../lib/voice-live'
import { api } from '../lib/api'
import type { VoiceProvider, VoiceProviders, VoiceSpend } from '../../../src/voice.js'
import { createScopeVoiceSession, SCOPE_VOICE_KICKOFF, SCOPE_VOICE_PROMPT, SCOPE_VOICE_TOOLS, type ScopeVoiceDeps, type ScopeVoiceUi } from '../../../src/scope-voice.js'
import '../voice-capsule.css'

let root: ReturnType<typeof createRoot> | null = null
export function mountVoice(audio: AudioContext, deps: ScopeVoiceDeps, onUi: (ui: ScopeVoiceUi) => void, onActive: (active: boolean) => void) {
  root ??= createRoot(document.getElementById('voiceRoot')!)
  root.render(<ScopeVoice key={Date.now()} audio={audio} deps={deps} onUi={onUi} onActive={onActive} />)
}
function ScopeVoice({ audio, deps, onUi, onActive }: { audio: AudioContext; deps: ScopeVoiceDeps; onUi(ui: ScopeVoiceUi): void; onActive(active: boolean): void }) {
  const [state, setState] = useState<VoiceState | null>({ name: 'connecting' })
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [providers, setProviders] = useState<VoiceProviders | null>(null)
  const [provider, setProvider] = useState<VoiceProvider | undefined>()
  const [spend, setSpend] = useState<VoiceSpend | undefined>()
  const [minutesLeft, setMinutesLeft] = useState(false)
  const [timing, setTiming] = useState<{ startedAt: number; maxMinutes: number } | null>(null)
  const call = useRef<{ stop(): void } | null>(null), attempt = useRef(0)
  const start = (context: AudioContext, picked?: VoiceProvider) => {
    let callProvider: VoiceProvider | undefined
    const current = ++attempt.current
    call.current?.stop(); call.current = null
    setTranscript([]); setMinutesLeft(false); setTiming(null); setSpend(undefined); setState({ name: 'connecting' }); onActive(true)
    const rules = createScopeVoiceSession({ ...deps, getProvider: () => callProvider })
    call.current = startVoiceCall(context, {
      onState: (next) => { if (current !== attempt.current) return; setState(next); if (!['connecting', 'listening', 'speaking'].includes(next.name)) onActive(false) },
      onTranscript: (line) => setTranscript((previous) => previous.at(-1)?.who === line.who ? [...previous.slice(0, -1), line] : [...previous, line]),
      onAssistantSaid: (text) => { if (current === attempt.current) rules.assistantSaid(text) },
      onUi: (ui) => onUi(ui as unknown as ScopeVoiceUi), onChanged: () => {},
      onSession: (session) => { callProvider = session.provider; setProvider(session.provider); setSpend(session.spend); setTiming({ startedAt: Date.now(), maxMinutes: session.maxMinutes }) },
    }, { provider: picked, profile: { kickoff: SCOPE_VOICE_KICKOFF, prompt: SCOPE_VOICE_PROMPT, tools: SCOPE_VOICE_TOOLS, rules, session: { profile: 'scope' } } })
  }
  const retry = (picked = provider) => {
    try { start(prepareAudio(), picked) } catch (error) { setState({ name: 'error', message: error instanceof Error ? error.message : 'Audio is unavailable.' }); onActive(false) }
  }
  useEffect(() => {
    let cancelled = false
    void api<VoiceProviders>('/api/voice/providers').then((result) => {
      if (cancelled) return
      setProviders(result)
      let stored: string | null = null
      try { stored = localStorage.getItem('unblock.voiceProvider.v2') } catch {}
      const picked = result.providers.find((item) => item.id === stored && item.configured)?.id || result.default
      setProvider(picked); start(audio, picked)
    }).catch(() => { if (!cancelled) start(audio) })
    return () => { cancelled = true; attempt.current++; call.current?.stop(); void audio.close() }
  }, [])
  useEffect(() => {
    if (!timing || state?.name === 'ended') return
    const tick = () => setMinutesLeft(Date.now() >= timing.startedAt + (timing.maxMinutes - 1) * 60_000)
    tick(); const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [timing, state?.name])
  return <VoiceBar state={state} transcript={transcript} provider={provider} spend={spend} minutesLeft={minutesLeft} blockedLink={null}
    choices={providers?.providers.filter((item) => item.configured).map(({ id, label }) => ({ id, label })) || []}
    onSwitch={(next) => { try { localStorage.setItem('unblock.voiceProvider.v2', next) } catch {} setProvider(next); retry(next) }}
    onEnd={() => { attempt.current++; call.current?.stop(); call.current = null; setState({ name: 'ended' }); onActive(false) }} onRetry={() => retry()} />
}
