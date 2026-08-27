import { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import { Input } from './components/ui/input'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group'
import { Textarea } from './components/ui/textarea'
import { cn } from './lib/utils'
import type { Field, FieldValue } from './deck'

export function CopyBlock({ text }: { text: string }) {
  const [label, setLabel] = useState('copy')
  const resetRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(resetRef.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setLabel('copied')
    } catch {
      setLabel('select it')
    }
    window.clearTimeout(resetRef.current)
    resetRef.current = window.setTimeout(() => setLabel('copy'), 1600)
  }
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 select-all whitespace-pre-wrap break-all rounded-[var(--radius-sm)] border border-[var(--rule)] bg-[var(--surface2)] px-3 py-2 font-mono text-[13px] leading-5 text-[var(--ink)]">{text}</pre>
      <Button variant="ghost" className="h-9" onClick={copy}>{label}</Button>
    </div>
  )
}

export function RecommendedBadge() {
  return (
    <span className="ml-2 inline-block rounded-full border border-[var(--accent)] px-2 py-[2px] align-[2px] text-[11px] font-medium leading-none text-[var(--accent)]">
      Recommended
    </span>
  )
}

interface FieldControlProps {
  field: Field
  ticket: string
  value: FieldValue | undefined
  note: string | undefined
  bounceNote: string | undefined
  onChange: (name: string, value: FieldValue, isSecret?: boolean) => void
  onNoteChange: (name: string, note: string) => void
  onBounce: (name: string, note: string | null) => void
  disabled: boolean
}

export function FieldControl({ field, ticket, value, note, bounceNote, onChange, onNoteChange, onBounce, disabled }: FieldControlProps) {
  const id = `f_${ticket}_${field.name}`
  const [isVisible, setIsVisible] = useState(false)
  const [showNote, setShowNote] = useState(Boolean(note))
  const isBounced = bounceNote !== undefined
  const isRecommendedChoice = (choiceValue: string) => {
    if (!field.recommend || field.must_decide) return false
    const target = field.recommend.value
    return Array.isArray(target) ? target.includes(choiceValue) : target === choiceValue
  }
  const label = (
    <label htmlFor={id} className="mb-2 block text-[13.5px] font-semibold leading-5 text-[var(--ink)]">
      {field.label}
      {field.required ? <span className="text-[var(--accent)]"> *</span> : <span className="font-normal text-[var(--faint)]"> · optional</span>}
    </label>
  )

  // A field sent back stops being a question. The control disappears; what is
  // left is a note box for saying why, and a way to change your mind.
  if (isBounced) {
    return (
      <div className="border-t border-[var(--rule)] py-5 first:border-t">
        {label}
        <div className="rounded-[var(--radius)] border border-dashed border-[var(--danger)] px-3.5 py-3">
          <p className="text-[13.5px] leading-5 text-[var(--danger)]">Going back to the agent unanswered — it will rework this question.</p>
          <Textarea value={bounceNote} placeholder="What's wrong with this question? (optional)" spellCheck={false} disabled={disabled} className="mt-2 min-h-14" onChange={(event) => onBounce(field.name, event.target.value)} />
          <button type="button" className="mt-2 block text-[12.5px] leading-5 text-[var(--faint)] hover:text-[var(--accent)]" disabled={disabled} onClick={() => onBounce(field.name, null)}>Keep the question</button>
        </div>
      </div>
    )
  }

  let control
  if (field.type === 'secret') {
    // A real <form> keeps password managers and the browser's own heuristics
    // calm about a bare password input; submit is neutered.
    control = (
      <form className="flex items-stretch gap-2" onSubmit={(event) => event.preventDefault()}>
        <Input id={id} type={isVisible ? 'text' : 'password'} value={typeof value === 'string' ? value : ''} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="paste it here" className="min-w-0 flex-1 font-mono text-[13.5px]" disabled={disabled} onChange={(event) => onChange(field.name, event.target.value, true)} />
        <Button variant="ghost" onClick={() => setIsVisible((current) => !current)} disabled={disabled}>{isVisible ? 'hide' : 'show'}</Button>
      </form>
    )
  } else if (field.type === 'choice' && field.multi) {
    const selected = Array.isArray(value) ? value : []
    const declared = new Set((field.choices || []).map((choice) => choice.value))
    const otherValue = selected.find((item) => !declared.has(item)) ?? ''
    const withOther = (next: string[], other: string) => {
      const kept = next.filter((item) => declared.has(item))
      return other.trim() ? [...kept, other] : kept
    }
    control = <div className="grid gap-1.5">
      {(field.choices || []).map((choice) => {
        const checked = selected.includes(choice.value)
        return <label key={choice.value} className={cn('flex cursor-pointer items-start gap-3 rounded-[var(--radius)] border border-[var(--input-border)] bg-[var(--surface)] px-3.5 py-3 text-[15px] leading-snug', checked && 'border-[var(--accent)] bg-[var(--accent-soft)]')}><Checkbox checked={checked} disabled={disabled} onCheckedChange={(next) => onChange(field.name, withOther(next === true ? [...selected, choice.value] : selected.filter((item) => item !== choice.value), otherValue))} /><span>{choice.label}{isRecommendedChoice(choice.value) && <RecommendedBadge />}</span></label>
      })}
      <div className={cn('flex items-center gap-3 rounded-[var(--radius)] border border-[var(--input-border)] bg-[var(--surface)] px-3.5 py-2.5 text-[15px]', otherValue && 'border-[var(--accent)] bg-[var(--accent-soft)]')}>
        <span className="text-[var(--dim)]">Other:</span>
        <Input value={otherValue} placeholder="your own answer" disabled={disabled} className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-[16px]" onChange={(event) => onChange(field.name, withOther(selected, event.target.value))} />
      </div>
    </div>
  } else if (field.type === 'choice') {
    const declared = new Set((field.choices || []).map((choice) => choice.value))
    const isOther = typeof value === 'string' && value !== '' && !declared.has(value)
    const radioValue = value === null ? '__skip__' : isOther ? '__other__' : typeof value === 'string' ? value : ''
    control = <div className="grid gap-1.5">
      <RadioGroup value={radioValue} onValueChange={(next) => onChange(field.name, next === '__skip__' ? null : next === '__other__' ? (isOther ? value : '') : next)} disabled={disabled}>
        {(field.choices || []).map((choice) => <label key={choice.value} className={cn('flex cursor-pointer items-start gap-3 rounded-[var(--radius)] border border-[var(--input-border)] bg-[var(--surface)] px-3.5 py-3 text-[15px] leading-snug', value === choice.value && 'border-[var(--accent)] bg-[var(--accent-soft)]')}><RadioGroupItem value={choice.value} /><span>{choice.label}{isRecommendedChoice(choice.value) && <RecommendedBadge />}</span></label>)}
        <label className={cn('flex cursor-pointer items-center gap-3 rounded-[var(--radius)] border border-[var(--input-border)] bg-[var(--surface)] px-3.5 py-2.5 text-[15px]', isOther && 'border-[var(--accent)] bg-[var(--accent-soft)]')}>
          <RadioGroupItem value="__other__" />
          <span className="text-[var(--dim)]">Other:</span>
          <Input value={isOther ? value : ''} placeholder="your own answer" disabled={disabled} className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-[16px]" onFocus={() => { if (!isOther) onChange(field.name, '') }} onChange={(event) => onChange(field.name, event.target.value)} />
        </label>
        <label className={cn('flex cursor-pointer items-start gap-3 rounded-[var(--radius)] border border-dashed border-[var(--input-border)] px-3.5 py-2.5 text-[14px] text-[var(--dim)]', value === null && 'border-solid border-[var(--accent)] bg-[var(--accent-soft)]')}>
          <RadioGroupItem value="__skip__" />
          <span>Skip — no answer{field.recommend ? ' (the agent proceeds on its recommendation)' : ''}</span>
        </label>
      </RadioGroup>
    </div>
  } else if (field.type === 'confirm') {
    control = <label className="flex cursor-pointer items-start gap-3 text-[15px]"><Checkbox id={id} checked={value === true} disabled={disabled} onCheckedChange={(next) => onChange(field.name, next === true)} /><span>{field.help || 'Done'}</span></label>
  } else if (field.type === 'paste') {
    control = <div className="grid gap-2"><CopyBlock text={field.command || ''} /><Textarea id={id} value={typeof value === 'string' ? value : ''} placeholder="paste the output here" spellCheck={false} disabled={disabled} className="font-mono" onChange={(event) => onChange(field.name, event.target.value)} /></div>
  } else if (field.multiline) {
    control = <Textarea id={id} value={typeof value === 'string' ? value : ''} spellCheck={false} disabled={disabled} onChange={(event) => onChange(field.name, event.target.value)} />
  } else {
    control = <Input id={id} type="text" value={typeof value === 'string' ? value : ''} placeholder={field.placeholder || ''} disabled={disabled} onChange={(event) => onChange(field.name, event.target.value)} />
  }
  return (
    <div className="border-t border-[var(--rule)] py-5 first:border-t">
      {label}{control}
      {field.url && <a className="mt-2 block break-all text-[15px] text-[var(--ink)] underline decoration-[var(--accent)] underline-offset-[3px] hover:text-[var(--accent)]" href={field.url} target="_blank" rel="noreferrer noopener">{field.url}</a>}
      {field.help && field.type !== 'confirm' && <p className="mt-2 text-[13.5px] leading-5 text-[var(--dim)]">{field.help}</p>}
      {field.type === 'secret' && <p className="mt-2 text-[13.5px] leading-5 text-[var(--dim)]">Stored on your machine. The agent receives a reference, never the value.</p>}
      {field.recommend && !field.must_decide && <p className="mt-2 text-[13.5px] leading-5 text-[var(--dim)]"><span className="font-medium text-[var(--ink)]">Recommended</span>{field.type !== 'choice' && <>: {String(field.recommend.value)}</>} · {field.recommend.why}</p>}
      {field.must_decide && <p className="mt-2 text-[13.5px] leading-5 text-[var(--dim)]">This one needs your decision.</p>}
      <div className="mt-2 flex flex-wrap gap-x-4">
        {!showNote && <button type="button" className="block text-[12.5px] leading-5 text-[var(--faint)] hover:text-[var(--accent)]" disabled={disabled} onClick={() => setShowNote(true)}>Add context</button>}
        <button type="button" className="block text-[12.5px] leading-5 text-[var(--faint)] hover:text-[var(--danger)]" disabled={disabled} title="Reject just this question; the rest of your answers still go through" onClick={() => onBounce(field.name, '')}>Send back this question</button>
      </div>
      {showNote && <Textarea id={`${id}_ctx`} value={note ?? ''} placeholder="Context for this answer" spellCheck={false} disabled={disabled} className="mt-2 min-h-14" onChange={(event) => onNoteChange(field.name, event.target.value)} />}
    </div>
  )
}
