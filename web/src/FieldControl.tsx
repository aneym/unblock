import { useState } from 'react'
import { Chip, ChipText, PlainText } from './ChipText'
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
                <span><PlainText text={choice.label} /></span>
                {recommended && <span className="recommend-badge">Recommended</span>}
              </span>
              {recommended && field.recommend?.why && (
                <span className="recommend-why"><ChipText text={field.recommend.why} /></span>
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

function SecretControl({ id, name, value, onChange, disabled }: {
  id: string; name: string; value: FieldValue | undefined; onChange: ChangeFn; disabled: boolean
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
          onChange={(event) => onChange(name, event.target.value, true)}
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

export function FieldControl({
  field,
  ticket,
  value,
  onChange,
  disabled,
  topUrl,
}: {
  field: Field
  ticket: string
  value: FieldValue | undefined
  onChange: ChangeFn
  disabled: boolean
  topUrl?: string
}) {
  const id = `f_${ticket}_${field.name}`

  const declared = new Set((field.choices || []).map((choice) => choice.value))
  const [showOther, setShowOther] = useState(() => Array.isArray(value)
    ? value.some((item) => !declared.has(item))
    : typeof value === 'string' && !!value && !declared.has(value))
  const hero = field.type === 'secret'

  return (
    <div className={`question${hero ? ' secret-hero' : ''}`}>
      <div className="question-heading">
        <label htmlFor={id}><ChipText text={field.label} /></label>
        {!field.required && <span className="muted">optional</span>}
        {field.must_decide && (
          <span className="muted decide"><Icon name="diamond" /> You decide</span>
        )}
        {field.url && field.url !== topUrl && <Chip url={field.url} className="screen-link" />}
      </div>
      {field.help && field.type !== 'confirm' && (
        <p className="field-help"><ChipText text={field.help} /></p>
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
        <SecretControl id={id} name={field.name} value={value} onChange={onChange} disabled={disabled} />
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
          Recommended: {recommendLabel(field)} · <ChipText text={field.recommend.why} />
        </p>
      )}
      {field.type === 'choice' && (
        <button className="text-button other-link" type="button" onClick={() => setShowOther(!showOther)}>
          Other answer
        </button>
      )}
    </div>
  )
}
