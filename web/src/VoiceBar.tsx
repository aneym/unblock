import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import type { VoiceProvider, VoiceSpend } from '../../src/voice.js'
import { Icon } from './icons'
import { voiceAudioError } from './lib/voice-audio'
import type { TranscriptLine, VoiceState } from './lib/voice-live'

export function TalkButton({ active, onClick }: { active: boolean; onClick(): void }) {
  return <button className="talk-button" type="button" onClick={onClick} disabled={active} aria-label="Talk to unblock">
    <Icon name="mic" size={17} /> Talk
  </button>
}

export function VoiceBar({ state, transcript, onEnd, onRetry, provider, choices, onSwitch, spend, minutesLeft, blockedLink }: {
  state: VoiceState | null; transcript: TranscriptLine[]; onEnd(): void; onRetry(): void
  provider?: VoiceProvider; choices: { id: VoiceProvider; label: string }[]; onSwitch(id: VoiceProvider): void; spend?: VoiceSpend
  minutesLeft: boolean; blockedLink: { url: string; label: string } | null
}) {
  const [speed, setSpeed] = useState(1.5)
  useEffect(() => {
    const onSpeed = (event: Event) => flushSync(() => setSpeed((event as CustomEvent<number>).detail))
    window.addEventListener('unblock:voice-speed', onSpeed)
    return () => window.removeEventListener('unblock:voice-speed', onSpeed)
  }, [])
  const stepSpeed = (step: number) => window.dispatchEvent(new CustomEvent('unblock:voice-set-speed', { detail: Math.round((speed + step) * 10) / 10 }))
  const [filed, setFiled] = useState<{ number: number; url: string } | null>(null)
  const [lastState, setLastState] = useState<VoiceState | null>(null)
  useEffect(() => {
    if (state && state.name !== 'ended') { setLastState(state); return }
    if (lastState) {
      const timer = window.setTimeout(() => setLastState(null), 180)
      return () => window.clearTimeout(timer)
    }
  }, [state, lastState])
  useEffect(() => {
    let timer: number | undefined
    const onFiled = (event: Event) => {
      const detail = (event as CustomEvent<{ number: number; url: string }>).detail
      setFiled(detail)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setFiled(null), 8000)
    }
    window.addEventListener('unblock:voice-filed', onFiled)
    return () => { window.removeEventListener('unblock:voice-filed', onFiled); window.clearTimeout(timer) }
  }, [])

  const exiting = !state || state.name === 'ended'
  const current = exiting ? lastState : state
  if (!current) return null
  const inactive = current.name === 'unconfigured' || current.name === 'capped' || current.name === 'error'
  const label = current.name === 'unconfigured' ? "Voice needs an API key. It's waiting in the queue."
    : current.name === 'capped' ? `Voice hit this month's${current.cap ? ` $${current.cap} cap` : ' cap'}.`
      : current.name === 'error' ? voiceAudioError(new Error(current.message))
        : current.name === 'ended' ? ''
          : { connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking' }[current.name]
  const latest = transcript.at(-1)
  const switchButton = choices.length > 1 && provider ? choices.filter((choice) => choice.id !== provider).map((choice) => <button key={choice.id} className="voice-switch" type="button" onClick={() => onSwitch(choice.id)}
    title={`Switch to ${choice.label}`}>Switch to {choice.label}</button>) : null
  const meta = <>{provider && (choices.find((choice) => choice.id === provider)?.label || { live: 'GPT Live', openai: 'GPT Realtime', xai: 'Grok', gemini: 'Gemini' }[provider])}
    {provider && provider !== 'gemini' && provider !== 'live' && <> · <span className="voice-speed">
      <button type="button" data-voice-speed="down" aria-label="Slower" disabled={speed <= 0.7} onClick={() => stepSpeed(-0.1)}>−</button>
      <span className="voice-speed-value">{speed.toFixed(1)}×</span>
      <button type="button" data-voice-speed="up" aria-label="Faster" disabled={speed >= 1.5} onClick={() => stepSpeed(0.1)}>+</button>
    </span></>}
    {spend && <span className="voice-spend"> · ${spend.spent_usd.toFixed(2)}{spend.cap_usd === null ? ' this month' : ` of $${spend.cap_usd}`}</span>}
    {minutesLeft && <> · 1 min left</>}</>

  return <div className={`voice-capsule${inactive ? ' voice-capsule-inactive' : ''}${exiting ? ' voice-exiting' : ''}`}
    role={current.name === 'error' ? 'alert' : 'status'} aria-live="polite">
    <span className={`voice-orb voice-${inactive ? 'connecting' : current.name}`} aria-hidden="true">
      {current.name === 'speaking' ? <span className="voice-wave"><i /><i /><i /></span> : <span className="voice-dot" />}
    </span>
    <div className="voice-copy">
      <p className="voice-line">{!inactive && latest ? <>{latest.who === 'you' && <span className="voice-speaker">You </span>}{latest.text}</> : label}</p>
      {!inactive && meta && <small className="voice-meta">{meta}{switchButton && <span className="voice-mobile-switch"> · {switchButton}</span>}</small>}
      {(blockedLink || filed) && <span className="voice-chips">
        {blockedLink && <a className="voice-chip" href={blockedLink.url} target="_blank" rel="noopener noreferrer">Open {blockedLink.label} ↗</a>}
        {filed && <a className="voice-chip" href={filed.url} target="_blank" rel="noopener noreferrer">Filed #{filed.number} ↗</a>}
      </span>}
    </div>
    {inactive ? <button className="voice-action" type="button" onClick={onRetry}>Retry</button> : <>
      <span className="voice-desktop-switch">{switchButton}</span>
      <button className="voice-end" type="button" onClick={onEnd} aria-label="End call"><Icon name="phone-down" size={18} /></button>
    </>}
  </div>
}
