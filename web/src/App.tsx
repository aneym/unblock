import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import { Input } from './components/ui/input'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group'
import { Textarea } from './components/ui/textarea'
import { cn } from './lib/utils'

declare global {
  interface Window {
    __UNBLOCK_TOKEN__?: string
    __UNBLOCK_BOOT__?: { token: string | null; viewer: { login: string; name: string } | null }
  }
}

type Scalar = string | boolean
/** null is an explicit "no answer" — a real response, distinct from untouched. */
type FieldValue = Scalar | string[] | null
type Values = Record<string, FieldValue>
/** ticket-scoped map of field name → send-back note ('' = no note yet). */
type Bounced = Record<string, string>

interface Choice { value: string; label: string }
interface Field {
  name: string
  type: 'text' | 'secret' | 'choice' | 'confirm' | 'paste'
  label: string
  required?: boolean
  multiline?: boolean
  multi?: boolean
  choices?: Choice[]
  help?: string
  url?: string
  command?: string
  placeholder?: string
  recommend?: { value: FieldValue; why: string }
  must_decide?: boolean
}
interface Ask {
  ticket: string
  kind: 'file' | 'park'
  purpose: 'blocker' | 'decision'
  gating: boolean
  status: string
  title: string
  why: string
  fields: Field[]
  steps?: string[]
  links?: { label: string; url: string }[]
  origin: { agent?: string; workspace_name?: string; pane_id?: string; tab_id?: string; workspace_id?: string; repo?: string; cwd?: string; detected?: boolean }
  answers?: Record<string, unknown>
  draft?: Values
  draft_reply?: string
  draft_updated_at?: number
  field_context?: Record<string, string>
  missing?: string[]
  created_at: number
}
interface QueueData { asks: Ask[]; hidden: number; profile: string }

const BOOT = window.__UNBLOCK_BOOT__ ?? {
  token: window.__UNBLOCK_TOKEN__ || null,
  viewer: null,
}

/**
 * The page is reachable two ways and speaks the same API from both.
 *
 *   /u/<token>  a shared link; the token IS the capability, so it prefixes.
 *   /           the canonical page; a trusted proxy already identified the
 *               viewer, so there is no token and no prefix.
 *
 * Concatenating an empty token gave `/u//api/queue`, which rendered the shell
 * and then failed every fetch — a blank-looking queue rather than an error.
 */
const BASE = BOOT.token ? `/u/${BOOT.token}` : ''
const VIEWER = BOOT.viewer
class FinishedError extends Error {}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  if (response.status === 410) throw new FinishedError('finished')
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

/**
 * The local mirror: every keystroke lands in localStorage synchronously,
 * BEFORE the debounced server draft. This is what makes a reload lossless
 * even when the tab dies, the daemon is briefly down, or the draft POST never
 * got to fire — the exact failure that used to eat a whole answered grill.
 * Secrets never enter it; they stay in component state only.
 */
interface LocalDraft { values: Values; notes: Record<string, string>; reply: string; bounced: Bounced; t: number }
const localKey = (ticket: string) => `ub_local_${ticket}`
function readLocal(ticket: string): LocalDraft | null {
  try { return JSON.parse(localStorage.getItem(localKey(ticket)) || 'null') } catch { return null }
}
function writeLocal(ticket: string, draft: Omit<LocalDraft, 't'>) {
  try { localStorage.setItem(localKey(ticket), JSON.stringify({ ...draft, t: Date.now() })) } catch { /* private mode etc. */ }
}
function clearLocal(ticket: string) {
  try { localStorage.removeItem(localKey(ticket)) } catch { /* ignore */ }
}

/**
 * Navigate to a custom-scheme URL without touching the page. A plain anchor
 * click makes some Chromium shells open an about:blank tab when no OS handler
 * answers; a throwaway iframe fires the handler with no navigation either way.
 */
function openHerdr(href: string) {
  const frame = document.createElement('iframe')
  frame.style.display = 'none'
  frame.src = href
  document.body.appendChild(frame)
  window.setTimeout(() => frame.remove(), 2000)
}

function ago(createdAt: number) {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

/** The project/grouping an ask belongs to, best label first. */
function groupOf(ask: Ask) {
  return (
    ask.origin.workspace_name ||
    ask.origin.repo ||
    (ask.origin.cwd ? ask.origin.cwd.split('/').filter(Boolean).pop() : undefined) ||
    ask.origin.agent ||
    'elsewhere'
  )
}

function isMissing(value: FieldValue | undefined) {
  if (value === undefined) return true
  if (value === null) return false // explicitly skipped — answered
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return value === false
}

function CopyBlock({ text }: { text: string }) {
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

function RecommendedBadge() {
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

function FieldControl({ field, ticket, value, note, bounceNote, onChange, onNoteChange, onBounce, disabled }: FieldControlProps) {
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
    control = (
      <div className="flex items-stretch gap-2">
        <Input id={id} type={isVisible ? 'text' : 'password'} value={typeof value === 'string' ? value : ''} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="paste it here" className="min-w-0 flex-1 font-mono text-[13.5px]" disabled={disabled} onChange={(event) => onChange(field.name, event.target.value, true)} />
        <Button variant="ghost" onClick={() => setIsVisible((current) => !current)} disabled={disabled}>{isVisible ? 'hide' : 'show'}</Button>
      </div>
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

function AskCard({ ask, onFinished }: { ask: Ask; onFinished: () => void }) {
  /**
   * Seed once per ticket: server draft first, then the local mirror on top
   * when it is newer than what the daemon has. Later polls replace the `ask`
   * prop but must never clobber what is being typed.
   */
  const seeded = useMemo(() => {
    const base = {
      values: { ...(ask.draft || {}) } as Values,
      notes: { ...(ask.field_context || {}) },
      reply: ask.draft_reply || '',
      bounced: {} as Bounced,
    }
    const local = readLocal(ask.ticket)
    if (local && local.t > (ask.draft_updated_at || 0)) {
      return {
        values: { ...base.values, ...(local.values || {}) },
        notes: { ...base.notes, ...(local.notes || {}) },
        reply: local.reply || base.reply,
        bounced: local.bounced || {},
      }
    }
    return base
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.ticket])
  const [values, setValues] = useState<Values>(seeded.values)
  const [notes, setNotes] = useState<Record<string, string>>(seeded.notes)
  const [reply, setReply] = useState(seeded.reply)
  const [bounced, setBounced] = useState<Bounced>(seeded.bounced)
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [draftState, setDraftState] = useState<'idle' | 'saving' | 'saved' | 'offline'>('idle')
  const draftTimer = useRef<number | undefined>(undefined)
  const latest = useRef({ values: seeded.values, notes: seeded.notes, reply: seeded.reply, bounced: seeded.bounced })
  const secretNames = useMemo(() => new Set(ask.fields.filter((field) => field.type === 'secret').map((field) => field.name)), [ask.fields])
  const unanswered = ask.fields.filter((field) => !(field.name in (ask.answers || {})))
  const missing = unanswered.filter((field) => !(field.name in bounced) && field.required && isMissing(values[field.name])).map((field) => field.label)
  // Only must_decide fields hard-block the submit — and sending one back
  // counts as engaging with it. Everything else left blank is sent as an
  // explicit skip (null), a real "no answer" the agent acts on.
  const hardMissing = unanswered.filter((field) => field.must_decide && !(field.name in bounced) && isMissing(values[field.name])).map((field) => field.label)
  const detected = ask.origin.detected === true
  const isDecision = ask.purpose === 'decision'

  const safeValues = (raw: Values) => Object.fromEntries(Object.entries(raw).filter(([key]) => !secretNames.has(key)))

  /**
   * Every change lands in localStorage synchronously, then the server draft
   * follows on a short debounce. The old shape — a trailing 700ms POST with a
   * silent catch and no local copy — lost the whole form whenever the tab
   * froze or the POST failed before firing.
   */
  const persist = (next: Partial<typeof latest.current>) => {
    const merged = { ...latest.current, ...next }
    latest.current = merged
    writeLocal(ask.ticket, { values: safeValues(merged.values), notes: merged.notes, reply: merged.reply, bounced: merged.bounced })
    window.clearTimeout(draftTimer.current)
    setDraftState('saving')
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = undefined
      api('/api/draft', { ticket: ask.ticket, values: safeValues(merged.values), field_context: merged.notes, reply: merged.reply })
        .then(() => setDraftState('saved'))
        .catch(() => setDraftState('offline'))
    }, 500)
  }

  /** Leaving the page flushes a pending draft without waiting on the network. */
  useEffect(() => {
    const flush = () => {
      if (draftTimer.current === undefined) return
      window.clearTimeout(draftTimer.current)
      draftTimer.current = undefined
      const merged = latest.current
      const body = new Blob(
        [JSON.stringify({ ticket: ask.ticket, values: safeValues(merged.values), field_context: merged.notes, reply: merged.reply })],
        { type: 'application/json' },
      )
      try { navigator.sendBeacon(`${BASE}/api/draft`, body) } catch { /* the local mirror already has it */ }
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearTimeout(draftTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.ticket])

  const onChange = (name: string, value: FieldValue, isSecret = false) => {
    const next = { ...latest.current.values, [name]: value }
    setValues(next)
    setState('idle')
    setMessage('')
    if (isSecret) {
      // A secret exists only in this component's memory until submit.
      latest.current = { ...latest.current, values: next }
      return
    }
    persist({ values: next })
  }
  const onNoteChange = (name: string, noteText: string) => {
    const next = { ...latest.current.notes, [name]: noteText }
    setNotes(next)
    setState('idle')
    setMessage('')
    persist({ notes: next })
  }
  const onReplyChange = (text: string) => {
    setReply(text)
    setState('idle')
    setMessage('')
    persist({ reply: text })
  }
  /** Mark one question as rejected (note may be ''), or null to un-reject it. */
  const onBounce = (name: string, note: string | null) => {
    const next = { ...latest.current.bounced }
    if (note === null) delete next[name]
    else next[name] = note
    setBounced(next)
    setState('idle')
    setMessage('')
    persist({ bounced: next })
  }

  const submit = async () => {
    setState('sending'); setMessage('sending…')
    const payload: Values = {}
    for (const [name, value] of Object.entries(values)) {
      if (!(name in bounced)) payload[name] = value
    }
    for (const field of unanswered) {
      if (field.name in bounced) continue
      if (field.required && !field.must_decide && isMissing(payload[field.name])) payload[field.name] = null
    }
    try {
      const output = await api<{ complete: boolean }>('/api/answer', { ticket: ask.ticket, values: payload, reply, field_context: notes, field_bounce: bounced })
      setState('done')
      setMessage(output.complete ? ask.gating ? `sent · waking ${ask.origin.agent || 'agent'}` : 'sent' : 'saved, still incomplete')
      if (output.complete) {
        clearLocal(ask.ticket)
        window.setTimeout(onFinished, 1200)
      }
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setMessage(error instanceof Error ? error.message : 'Could not send answer')
    }
  }
  /**
   * The third exit, for the whole ask. Sending it back is a real response: it
   * carries the note (optional), releases the agent, and tells it to ask again
   * properly. Never disabled — rejecting a bad ask must be the easiest action
   * on the card, not one gated behind writing an essay first.
   */
  const sendBack = async () => {
    setState('sending'); setMessage('sending back…')
    try {
      await api('/api/answer', { ticket: ask.ticket, reply, bounce: true })
      setState('done')
      setMessage('sent back — the agent will rework it')
      clearLocal(ask.ticket)
      window.setTimeout(onFinished, 1400)
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setMessage(error instanceof Error ? error.message : 'Could not send it back')
    }
  }
  /** Cmd+Enter (or Ctrl+Enter) anywhere inside the ask submits it. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (isBusy || detected || hardMissing.length > 0) return
    event.preventDefault()
    void submit()
  }
  const herdrHref = ask.origin.pane_id
    ? `herdr://focus?pane=${encodeURIComponent(ask.origin.pane_id)}` +
      (ask.origin.tab_id ? `&tab=${encodeURIComponent(ask.origin.tab_id)}` : '') +
      (ask.origin.workspace_id ? `&workspace=${encodeURIComponent(ask.origin.workspace_id)}` : '')
    : undefined
  const isBusy = state === 'sending' || state === 'done'
  const bounceCount = Object.keys(bounced).length
  const statusHint = message
    || (hardMissing.length ? `still needs: ${hardMissing.join(', ')}` : '')
    || [
      missing.length ? `${missing.length} unanswered ${missing.length === 1 ? 'field goes' : 'fields go'} back as skipped` : '',
      bounceCount ? `${bounceCount} ${bounceCount === 1 ? 'question goes' : 'questions go'} back for rework` : '',
    ].filter(Boolean).join(' · ')
  return (
    <article onKeyDown={onKeyDown} className={cn('py-8 transition-opacity duration-300', detected && 'opacity-70', state === 'done' && 'opacity-45')}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-5 text-[var(--dim)]">
        {ask.gating ? <span className="font-medium text-[var(--accent)]">● waiting</span> : detected ? <span>detected</span> : <span>filed</span>}
        <span aria-hidden>·</span>
        <span>{ask.origin.agent || 'agent'}</span>
        {ask.origin.workspace_name && <><span aria-hidden>·</span><span>{ask.origin.workspace_name}</span></>}
        {ask.origin.pane_id && herdrHref && <><span aria-hidden>·</span><a href={herdrHref} onClick={(event) => { event.preventDefault(); openHerdr(herdrHref) }} title="Jump to this pane in Herdr" className="font-mono text-[12px] underline decoration-[var(--faint)] underline-offset-2 hover:text-[var(--accent)] hover:decoration-[var(--accent)]">{ask.origin.pane_id}</a></>}
        <span aria-hidden>·</span>
        <span className="text-[var(--faint)]">{ago(ask.created_at)}</span>
        {draftState !== 'idle' && <><span aria-hidden>·</span><span className={cn('text-[var(--faint)]', draftState === 'offline' && 'text-[var(--danger)]')}>{draftState === 'saving' ? 'saving draft…' : draftState === 'saved' ? 'draft saved' : 'daemon unreachable — draft kept in this browser'}</span></>}
      </div>
      <h2 className="text-balance text-[19px] font-semibold leading-[1.3] tracking-[-.01em]">{ask.title}</h2>
      <p className="mt-1.5 text-pretty text-[15px] leading-relaxed text-[var(--dim)]">{ask.why}</p>
      {!!ask.steps?.length && <ol className="my-4 list-decimal space-y-1.5 pl-6 text-[15px] leading-relaxed marker:text-[var(--faint)]">{ask.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      {!!ask.links?.length && <div className="my-4 grid gap-1.5">{ask.links.map((link) => <a key={link.url} className="break-all text-[15px] text-[var(--ink)] underline decoration-[var(--accent)] underline-offset-[3px] hover:text-[var(--accent)]" href={link.url} target="_blank" rel="noreferrer noopener">{link.label}</a>)}</div>}
      <div className="mt-4">{unanswered.map((field) => <FieldControl key={field.name} field={field} ticket={ask.ticket} value={values[field.name]} note={notes[field.name]} bounceNote={bounced[field.name]} onChange={onChange} onNoteChange={onNoteChange} onBounce={onBounce} disabled={isBusy} />)}</div>
      <div className="border-t border-[var(--rule)] py-5">
        <label htmlFor={`reply_${ask.ticket}`} className="mb-2 block text-[13.5px] font-semibold leading-5 text-[var(--ink)]">Anything else <span className="font-normal text-[var(--faint)]">· or why you're sending it back</span></label>
        <Textarea id={`reply_${ask.ticket}`} value={reply} placeholder="Add context the fields don't cover, or say what's wrong with this ask" disabled={isBusy} className="min-h-20" onChange={(event) => onReplyChange(event.target.value)} />
      </div>
      {!detected && <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 border-t border-[var(--rule)] bg-[var(--bg)] px-4 py-4 sm:-mx-5 sm:px-5">
        <Button disabled={hardMissing.length > 0 || isBusy} onClick={() => void submit()}>{isDecision ? 'Submit' : ask.gating ? 'Answer & wake' : 'Answer'}</Button>
        <Button variant="secondary" disabled={isBusy} title="Send the whole ask back unanswered — a note above goes with it" onClick={() => void sendBack()}>Send back all</Button>
        <span className={cn('text-[13px] leading-5 text-[var(--faint)]', state === 'error' && 'text-[var(--danger)]', state === 'done' && 'text-[var(--ok)]')}>{statusHint}</span>
      </div>}
    </article>
  )
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="px-5 py-16 text-center text-[15px] leading-relaxed text-[var(--dim)]"><strong className="mb-1.5 block text-[17px] font-semibold text-[var(--ink)]">{title}</strong>{detail}</div>
}

function GroupChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border border-[var(--input-border)] px-3 py-1 text-[13px] leading-5 text-[var(--dim)] transition-colors duration-150 hover:border-[var(--ink)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
        active && 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--ink)]',
      )}
    >
      {children}
    </button>
  )
}

export default function App() {
  const [data, setData] = useState<QueueData | null>(null)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)
  const [activeTab, setActiveTab] = useState<'blocker' | 'decision'>(() => window.location.hash === '#grill' ? 'decision' : 'blocker')
  const [group, setGroup] = useState<string | null>(() => {
    try { return localStorage.getItem('ub_group') } catch { return null }
  })
  const load = useCallback(async () => {
    try { setData(await api<QueueData>('/api/queue')); setError('') }
    catch (cause) { if (cause instanceof FinishedError) setFinished(true); else setError(cause instanceof Error ? cause.message : 'Unknown error') }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return
      void load()
    }, 6000)
    return () => window.clearInterval(timer)
  }, [load])
  useEffect(() => {
    const onHashChange = () => setActiveTab(window.location.hash === '#grill' ? 'decision' : 'blocker')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const openAsks = (data?.asks || []).filter((ask) => ask.status === 'open').sort((a, b) => Number(b.gating) - Number(a.gating) || Number(a.origin.detected === true) - Number(b.origin.detected === true) || a.created_at - b.created_at)

  // Delineation by project: one chip per workspace/repo grouping, so a queue
  // fed by many projects can be answered one project at a time.
  const groups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const ask of openAsks) {
      const key = groupOf(ask) as string
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])
  const effectiveGroup = group && groups.some(([name]) => name === group) ? group : null
  const setGroupPersist = (next: string | null) => {
    setGroup(next)
    try {
      if (next) localStorage.setItem('ub_group', next)
      else localStorage.removeItem('ub_group')
    } catch { /* ignore */ }
  }

  const allAsks = effectiveGroup ? openAsks.filter((ask) => groupOf(ask) === effectiveGroup) : openAsks
  const blockerAsks = allAsks.filter((ask) => ask.purpose === 'blocker')
  const decisionAsks = allAsks.filter((ask) => ask.purpose === 'decision')
  useEffect(() => {
    if (!data || window.location.hash === '#unblock' || window.location.hash === '#grill') return
    // Land on the tab with something to do: a gating decision when no blocker
    // gates, or the only non-empty side (a scoped link to a filed decision
    // used to open on an empty Unblock tab and look broken).
    const next =
      (decisionAsks.some((ask) => ask.gating) && !blockerAsks.some((ask) => ask.gating)) ||
      (blockerAsks.length === 0 && decisionAsks.length > 0)
        ? 'decision'
        : 'blocker'
    window.location.replace(next === 'decision' ? '#grill' : '#unblock')
    setActiveTab(next)
  }, [data, blockerAsks, decisionAsks])
  if (finished) return <main className="mx-auto max-w-[580px] px-4 py-20"><EmptyState title="This link is finished" detail="Ask for a fresh one, or answer in the herdr pane." /></main>
  const asks = activeTab === 'blocker' ? blockerAsks : decisionAsks
  const setTab = (tab: 'blocker' | 'decision') => { window.location.hash = tab === 'blocker' ? 'unblock' : 'grill'; setActiveTab(tab) }
  const tabCopy = activeTab === 'blocker'
    ? { title: asks.length ? 'What only you can do' : 'Nothing needs doing', detail: asks.length ? 'Supply access, complete a step, or confirm you did it.' : 'No agent is waiting on an action from you.' }
    : { title: asks.length ? 'What only you can decide' : 'No rulings needed', detail: asks.length ? 'Review the agent’s recommendation, then accept it or choose differently.' : 'No agent is waiting on a decision from you.' }
  return (
    <div className="mx-auto max-w-[580px] px-4 pb-20 pt-5 sm:px-5 sm:pb-24 sm:pt-8">
      <header className="mb-8">
        <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] leading-none text-[var(--faint)]"><span className="text-[14px] font-semibold text-[var(--ink)]">unblock</span>{data?.profile && data.profile !== '*' && <span>profile {data.profile}</span>}{!!data?.hidden && <span>{data.hidden} more in other profiles</span>}</div>
        <nav aria-label="Ask type" className="flex items-stretch border-b border-[var(--rule)]">
          <button type="button" aria-current={activeTab === 'blocker' ? 'page' : undefined} onClick={() => setTab('blocker')} onMouseDown={(event) => event.preventDefault()} className={cn('min-w-0 flex-1 border-b-2 border-transparent px-1 py-3 text-left text-[15px] font-semibold text-[var(--dim)] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--accent)]', activeTab === 'blocker' && 'border-[var(--accent)] text-[var(--ink)]')}>Unblock · {data ? blockerAsks.length : '—'}</button>
          <button type="button" aria-current={activeTab === 'decision' ? 'page' : undefined} onClick={() => setTab('decision')} onMouseDown={(event) => event.preventDefault()} className={cn('min-w-0 flex-1 border-b-2 border-transparent px-1 py-3 text-left text-[15px] font-semibold text-[var(--dim)] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[var(--accent)]', activeTab === 'decision' && 'border-[var(--accent)] text-[var(--ink)]')}>Grill · {data ? decisionAsks.length : '—'}</button>
          {VIEWER && <span className="self-center pl-2 text-[12px] leading-4 text-[var(--faint)]" title={VIEWER.login}>{VIEWER.name || VIEWER.login}</span>}
        </nav>
        {groups.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Filter by project">
            <GroupChip active={!effectiveGroup} onClick={() => setGroupPersist(null)}>All · {openAsks.length}</GroupChip>
            {groups.map(([name, count]) => (
              <GroupChip key={name} active={effectiveGroup === name} onClick={() => setGroupPersist(effectiveGroup === name ? null : name)}>{name} · {count}</GroupChip>
            ))}
          </div>
        )}
        <h1 className="mt-7 text-balance text-[24px] font-semibold leading-tight tracking-[-.015em]">{tabCopy.title}</h1>
        <p className="mt-1.5 text-pretty text-[15px] leading-relaxed text-[var(--dim)]">{tabCopy.detail}</p>
      </header>
      <main aria-live="polite">{error ? <EmptyState title="Cannot reach the daemon" detail={error} /> : !data ? <EmptyState title="Loading" detail="Fetching the queue." /> : asks.length === 0 ? null : <div className="divide-y divide-[var(--rule)]">{asks.map((ask) => <AskCard key={ask.ticket} ask={ask} onFinished={load} />)}</div>}</main>
      <footer className="mt-12 border-t border-[var(--rule)] pt-4 text-[13px] leading-5 text-[var(--faint)]">This link expires. Answers go straight to the agent.</footer>
    </div>
  )
}
