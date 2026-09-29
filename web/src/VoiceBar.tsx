import { Icon } from './icons'
import type { TranscriptLine, VoiceState } from './lib/voice-live'

export function TalkButton({ active, onClick }: { active: boolean; onClick(): void }) {
  return <button className="talk-button" type="button" onClick={onClick} disabled={active} aria-label="Talk to unblock">
    <Icon name="mic" size={17} /> Talk
  </button>
}

export function VoiceBar({ state, transcript, onEnd, onRetry }: {
  state: VoiceState | null; transcript: TranscriptLine[]; onEnd(): void; onRetry(): void
}) {
  if (!state || state.name === 'ended') return null
  if (state.name === 'unconfigured') return <div className="voice-bar" role="status">
    <div className="voice-bar-inner">Voice needs its Gemini key. It's waiting in the queue.</div>
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
      </div>
      <button className="voice-action" type="button" onClick={onEnd}>End</button>
    </div>
  </div>
}
