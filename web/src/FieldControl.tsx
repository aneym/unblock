import { useState } from 'react'
import { Linkify } from './lib/linkify'
import { Icon } from './icons'
import { isMissing, type Field, type FieldValue } from './deck'

type ChangeFn = (name: string, value: FieldValue, isSecret?: boolean) => void

function recommendLabel(field: Field): string {
  const value = field.recommend?.value
  if (field.type === 'confirm') return value === true ? 'Done' : 'leave it undone'
  return String(value)
}

function isRecommended(field: Field, choice: string): boolean {
  if (field.must_decide || !field.recommend) return false
  const value = field.recommend.value
  return Array.isArray(value) ? value.includes(choice) : value === choice
}

function ChoiceControl({ field, value, onChange, disabled, showOther }: {
  field: Field; value: FieldValue | undefined; onChange: ChangeFn; disabled: boolean; showOther: boolean
}) {
  const choices = field.choices || []
  const declared = new Set(choices.map((choice) => choice.value))
  const selected = Array.isArray(value) ? value : []
  const other = selected.find((item) => !declared.has(item)) || ''
  const isOther = typeof value === 'string' && !!value && !declared.has(value)
  const useOther = (text: string) => {
    if (field.multi) {
      const kept = selected.filter((item) => declared.has(item))
      onChange(field.name, [...kept, ...(text.trim() ? [text] : [])])
    } else {
      onChange(field.name, text)
    }
  }
  const toggle = (choiceValue: string, checked: boolean) => {
    if (field.multi) {
      const next = checked ? selected.filter((item) => item !== choiceValue) : [...selected, choiceValue]
      onChange(field.name, next)
    } else {
      onChange(field.name, choiceValue)
    }
  }
  return (
    <div className="choice-list" role="group" aria-label={field.label}>
      {choices.map((choice) => {
        const checked = field.multi ? selected.includes(choice.value) : value === choice.value
        const recommended = isRecommended(field, choice.value)
        return (
          <label key={choice.value} className={`choice${checked ? ' checked' : ''}`}>
            <input
              type={field.multi ? 'checkbox' : 'radio'}
              name={field.name}
              checked={checked}
              disabled={disabled}
              onChange={() => toggle(choice.value, checked)}
            />
            <span className="choice-content">
              <span className="choice-line">
                <span><Linkify text={choice.label} /></span>
                {recommended && <span className="recommend-badge">Recommended</span>}
              </span>
              {recommended && field.recommend?.why && (
                <span className="recommend-why"><Linkify text={field.recommend.why} /></span>
              )}
            </span>
          </label>
        )
      })}
      {showOther && (
        <input
          className="control"
          aria-label={`Other answer for ${field.label}`}
          placeholder="Your own answer"
          value={field.multi ? other : isOther ? value : ''}
          disabled={disabled}
          onChange={(event) => useOther(event.target.value)}
        />
      )}
    </div>
  )
}

function SecretControl({ id, value, onChange, disabled }: {
  id: string; value: FieldValue | undefined; onChange: ChangeFn; disabled: boolean
}) {
  const [showSecret, setShowSecret] = useState(false)
  return (
    <>
      <form className="secret-row" onSubmit={(event) => event.preventDefault()}>
        <Icon name="lock" />
        <input
          id={id}
          type={showSecret ? 'text' : 'password'}
          value={typeof value === 'string' ? value : ''}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste it here"
          disabled={disabled}
          onChange={(event) => onChange(id, event.target.value, true)}
        />
        <button type="button" className="text-button" onClick={() => setShowSecret(!showSecret)}>
          {showSecret ? 'Hide' : 'Show'}
        </button>
      </form>
      <p className="secret-hint">Stored on this machine. The agent gets a reference, never the value.</p>
    </>
  )
}

function PasteControl({ id, name, command, value, onChange, disabled }: {
  id: string; name: string; command: string; value: FieldValue | undefined
  onChange: ChangeFn; disabled: boolean
}) {
  const [copied, setCopied] = useState(false)
  return (
    <>
      <div className="command">
        <code>{command}</code>
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command)
              setCopied(true)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <textarea
        id={id}
        className="control"
        value={typeof value === 'string' ? value : ''}
        placeholder="Paste the output here"
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </>
  )
}

function QuietActions({
  field, value, note, bounced, onChange, onToggleNote, onToggleOther, onBounce, disabled,
}: {
  field: Field; value: FieldValue | undefined; note: boolean; bounced: boolean
  onChange: ChangeFn; onToggleNote: () => void; onToggleOther: () => void
  onBounce: (name: string, note: string | null) => void; disabled: boolean
}) {
  return (
    <div className="quiet-actions">
      {field.type === 'choice' && (
        <button type="button" onClick={onToggleOther}>Other answer</button>
      )}
      {!field.must_decide && (
        <button type="button" onClick={() => onChange(field.name, value === null ? '' : null)}>
          {value === null ? 'Keep the question' : 'Skip'}
        </button>
      )}
      <button type="button" onClick={onToggleNote}>{note ? 'Hide note' : 'Add a note'}</button>
      <button type="button" disabled={disabled} onClick={() => onBounce(field.name, bounced ? null : '')}>
        {bounced ? 'Keep the question' : 'Send back'}
      </button>
    </div>
  )
}

export function FieldControl({
  field,
  ticket,
  value,
  note,
  bounceNote,
  onChange,
  onNoteChange,
  onBounce,
  disabled,
}: {
  field: Field
  ticket: string
  value: FieldValue | undefined
  note: string | undefined
  bounceNote: string | undefined
  onChange: ChangeFn
  onNoteChange: (name: string, note: string) => void
  onBounce: (name: string, note: string | null) => void
  disabled: boolean
}) {
  const id = `f_${ticket}_${field.name}`
  const [showNote, setShowNote] = useState(!!note)
  const declared = new Set((field.choices || []).map((choice) => choice.value))
  const [showOther, setShowOther] = useState(() => Array.isArray(value)
    ? value.some((item) => !declared.has(item))
    : typeof value === 'string' && !!value && !declared.has(value))
  const bounced = bounceNote !== undefined

  return (
    <div className="question">
      <div className="question-heading">
        <label htmlFor={id}><Linkify text={field.label} /></label>
        {!field.required && <span className="muted">optional</span>}
        {field.must_decide && (
          <span className="muted decide"><Icon name="diamond" /> You decide</span>
        )}
        {field.url && (
          <a href={field.url} target="_blank" rel="noopener noreferrer" className="screen-link">
            Open the screen ↗
          </a>
        )}
      </div>
      {field.help && field.type !== 'confirm' && (
        <p className="field-help"><Linkify text={field.help} /></p>
      )}
      {field.type === 'choice' ? (
        <ChoiceControl
          field={field}
          value={value}
          onChange={onChange}
          disabled={disabled}
          showOther={showOther}
        />
      ) : field.type === 'confirm' ? (
        <label className="choice confirm">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(field.name, event.target.checked)}
          />
          <span>Done</span>
        </label>
      ) : field.type === 'secret' ? (
        <SecretControl id={id} value={value} onChange={onChange} disabled={disabled} />
      ) : field.type === 'paste' ? (
        <PasteControl
          id={id}
          name={field.name}
          command={field.command || ''}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      ) : field.multiline ? (
        <textarea
          id={id}
          className="control"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      ) : (
        <input
          id={id}
          className="control"
          type="text"
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder || ''}
          disabled={disabled}
          onChange={(event) => onChange(field.name, event.target.value)}
        />
      )}
      {field.recommend && !field.must_decide && field.type !== 'choice' && (
        <p className="field-help">
          Recommended: {recommendLabel(field)} · <Linkify text={field.recommend.why} />
        </p>
      )}
      <QuietActions
        field={field}
        value={value}
        note={showNote}
        bounced={bounced}
        onChange={onChange}
        onToggleNote={() => setShowNote(!showNote)}
        onToggleOther={() => setShowOther(!showOther)}
        onBounce={onBounce}
        disabled={disabled}
      />
      {showNote && (
        <textarea
          className="control note"
          aria-label={`Note for ${field.label}`}
          placeholder="Context for this answer (optional)"
          value={note || ''}
          disabled={disabled}
          onChange={(event) => onNoteChange(field.name, event.target.value)}
        />
      )}
      {bounced && (
        <div className="bounce-box">
          <p>
            {isMissing(value)
              ? 'Going back unanswered — the agent will rework this question.'
              : 'Your answer goes with it as a draft. The agent will come back to you before acting on it.'}
          </p>
          <textarea
            className="control"
            aria-label={`Send back note for ${field.label}`}
            placeholder="What should change? (optional)"
            value={bounceNote}
            disabled={disabled}
            onChange={(event) => onBounce(field.name, event.target.value)}
          />
          <button type="button" className="text-button" onClick={() => onBounce(field.name, null)}>
            Keep the question
          </button>
        </div>
      )}
    </div>
  )
}
