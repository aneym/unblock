import type { VoiceProvider, VoiceSpend } from '../../src/voice.js'
import { Icon } from './icons'
import type { TranscriptLine, VoiceState } from './lib/voice-live'

export function TalkButton({ active, onClick }: { active: boolean; onClick(): void }) {
  return <button className="talk-button" type="button" onClick={onClick} disabled={active} aria-label="Talk to unblock">
    <Icon name="mic" size={17} /> Talk
  </button>
}

export function VoiceBar({ state, transcript, onEnd, onRetry, provider, bothConfigured, onSwitch, spend, minutesLeft, blockedLink }: {
  state: VoiceState | null; transcript: TranscriptLine[]; onEnd(): void; onRetry(): void
  provider?: VoiceProvider; bothConfigured: boolean; onSwitch(): void; spend?: VoiceSpend
  minutesLeft: boolean; blockedLink: { url: string; label: string } | null
}) {
  if (!state || state.name === 'ended') return null
  if (state.name === 'unconfigured') return <div className="voice-bar" role="status">
    <div className="voice-bar-inner">Voice needs an API key. It's waiting in the queue.</div>
  </div>
  if (state.name === 'capped') return <div className="voice-bar" role="status">
    <div className="voice-bar-inner">Voice hit this month's{state.cap ? ` $${state.cap} cap` : ' cap'}.</div>
  </div>
  if (state.name === 'error') return <div className="voice-bar" role="alert">
    <div className="voice-bar-inner"><span className="voice-message">{state.message}</span>
      <button className="voice-action" type="button" onClick={onRetry}>Retry</button></div>
  </div>
  const label = { connecting: 'Connecting…', listening: 'Listening', speaking: 'Speaking' }[state.name]
  return <div className="voice-bar" role="status" aria-live="polite">
    <div className="voice-bar-inner">
      <span className={`voice-state voice-${state.name}`}><span className="voice-dot" />{label}</span>
      <div className="voice-transcript" aria-label="Call transcript">
        {transcript.slice(-2).map((line, index) => <p key={index}>
          <strong>{line.who === 'you' ? 'You' : 'Unblock'}</strong> {line.text}
        </p>)}
        {blockedLink && <a href={blockedLink.url} target="_blank" rel="noopener noreferrer">Open {blockedLink.label} ↗</a>}
        {(spend || minutesLeft) && <small className="voice-meta">
          {spend && `$${spend.spent_usd.toFixed(2)} of $${spend.cap_usd} this month`}
          {minutesLeft && <span>1 min left</span>}
        </small>}
      </div>
      {bothConfigured && provider && <button className="voice-action voice-provider" type="button" onClick={onSwitch}
        title="Switch voice provider">{provider === 'xai' ? 'Grok' : 'Gemini'}</button>}
      <button className="voice-action" type="button" onClick={onEnd}>End</button>
    </div>
  </div>
}
