import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Card } from './components/ui/card'
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
  origin: { agent?: string; workspace_name?: string; pane_id?: string; tab_id?: string; workspace_id?: string; detected?: boolean }
  answers?: Record<string, unknown>
  draft?: Values
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

function ago(createdAt: number) {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

/**
 * Nothing is pre-selected. A recommendation renders as a badge on the option
 * it names; the human clicks every answer themselves. Only their own saved
 * draft seeds the form.
 */
function initialValues(ask: Ask): Values {
  return { ...(ask.draft || {}) }
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
      <pre className="min-w-0 flex-1 select-all whitespace-pre-wrap break-all rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--surface2)] px-3 py-2 font-mono text-[12.5px] leading-5 text-[var(--ink)]">{text}</pre>
      <Button variant="ghost" className="h-9" onClick={copy}>{label}</Button>
    </div>
  )
}

function RecommendedBadge() {
  return (
    <span className="ml-2 inline-block rounded-sm border border-[var(--accent)] px-1 py-[1px] align-[2px] font-mono text-[9.5px] font-semibold uppercase leading-none tracking-[.08em] text-[var(--accent)]">
      recommended
    </span>
  )
}

interface FieldControlProps {
  field: Field
  ticket: string
  value: FieldValue | undefined
  note: string | undefined
  onChange: (name: string, value: FieldValue, isSecret?: boolean) => void
  onNoteChange: (name: string, note: string) => void
  disabled: boolean
}

function FieldControl({ field, ticket, value, note, onChange, onNoteChange, disabled }: FieldControlProps) {
  const id = `f_${ticket}_${field.name}`
  const [isVisible, setIsVisible] = useState(false)
  const [showNote, setShowNote] = useState(Boolean(note))
  const isRecommendedChoice = (choiceValue: string) => {
    if (!field.recommend || field.must_decide) return false
    const target = field.recommend.value
    return Array.isArray(target) ? target.includes(choiceValue) : target === choiceValue
  }
  const label = (
    <label htmlFor={id} className="mb-2 block font-mono text-[11px] uppercase leading-none tracking-[.12em] text-[var(--dim)]">
      {field.label}
      {field.required ? <span className="text-[var(--accent)]"> *</span> : <span className="normal-case tracking-[.04em] text-[var(--faint)]"> (optional)</span>}
    </label>
  )
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
        return <label key={choice.value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--bg)] px-3 py-2.5 text-[14.5px]', checked && 'border-[var(--accent)] bg-[var(--accent-soft)]')}><Checkbox checked={checked} disabled={disabled} onCheckedChange={(next) => onChange(field.name, withOther(next === true ? [...selected, choice.value] : selected.filter((item) => item !== choice.value), otherValue))} /><span>{choice.label}{isRecommendedChoice(choice.value) && <RecommendedBadge />}</span></label>
      })}
      <div className={cn('flex items-center gap-2.5 rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--bg)] px-3 py-2 text-[14.5px]', otherValue && 'border-[var(--accent)] bg-[var(--accent-soft)]')}>
        <span className="text-[var(--dim)]">Other:</span>
        <Input value={otherValue} placeholder="your own answer" disabled={disabled} className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 text-[14px]" onChange={(event) => onChange(field.name, withOther(selected, event.target.value))} />
      </div>
    </div>
  } else if (field.type === 'choice') {
    const declared = new Set((field.choices || []).map((choice) => choice.value))
    const isOther = typeof value === 'string' && value !== '' && !declared.has(value)
    const radioValue = value === null ? '__skip__' : isOther ? '__other__' : typeof value === 'string' ? value : ''
    control = <div className="grid gap-1.5">
      <RadioGroup value={radioValue} onValueChange={(next) => onChange(field.name, next === '__skip__' ? null : next === '__other__' ? (isOther ? value : '') : next)} disabled={disabled}>
        {(field.choices || []).map((choice) => <label key={choice.value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--bg)] px-3 py-2.5 text-[14.5px]', value === choice.value && 'border-[var(--accent)] bg-[var(--accent-soft)]')}><RadioGroupItem value={choice.value} /><span>{choice.label}{isRecommendedChoice(choice.value) && <RecommendedBadge />}</span></label>)}
        <label className={cn('flex cursor-pointer items-center gap-2.5 rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--bg)] px-3 py-2 text-[14.5px]', isOther && 'border-[var(--accent)] bg-[var(--accent-soft)]')}>
          <RadioGroupItem value="__other__" />
          <span className="text-[var(--dim)]">Other:</span>
          <Input value={isOther ? value : ''} placeholder="your own answer" disabled={disabled} className="h-7 min-w-0 flex-1 border-0 bg-transparent px-1 text-[14px]" onFocus={() => { if (!isOther) onChange(field.name, '') }} onChange={(event) => onChange(field.name, event.target.value)} />
        </label>
        <label className={cn('flex cursor-pointer items-start gap-2.5 rounded-[var(--radius)] border border-dashed border-[var(--rule)] bg-[var(--bg)] px-3 py-2 text-[13.5px] text-[var(--dim)]', value === null && 'border-solid border-[var(--accent)] bg-[var(--accent-soft)]')}>
          <RadioGroupItem value="__skip__" />
          <span>Skip — no answer{field.recommend ? ' (the agent proceeds on its recommendation)' : ''}</span>
        </label>
      </RadioGroup>
    </div>
  } else if (field.type === 'confirm') {
    control = <label className="flex cursor-pointer items-start gap-2.5 text-[14.5px]"><Checkbox id={id} checked={value === true} disabled={disabled} onCheckedChange={(next) => onChange(field.name, next === true)} /><span>{field.help || 'Done'}</span></label>
  } else if (field.type === 'paste') {
    control = <div className="grid gap-2"><CopyBlock text={field.command || ''} /><Textarea id={id} value={typeof value === 'string' ? value : ''} placeholder="paste the output here" spellCheck={false} disabled={disabled} onChange={(event) => onChange(field.name, event.target.value)} /></div>
  } else if (field.multiline) {
    control = <Textarea id={id} value={typeof value === 'string' ? value : ''} spellCheck={false} disabled={disabled} onChange={(event) => onChange(field.name, event.target.value)} />
  } else {
    control = <Input id={id} type="text" value={typeof value === 'string' ? value : ''} placeholder={field.placeholder || ''} disabled={disabled} onChange={(event) => onChange(field.name, event.target.value)} />
  }
  return (
    <div className="border-t border-[var(--rule)] py-4 first:border-t">
      {label}{control}
      {field.url && <a className="mt-2 block break-all text-[14px] text-[var(--ink)] underline decoration-[var(--accent)] underline-offset-[3px] hover:text-[var(--accent)]" href={field.url} target="_blank" rel="noreferrer noopener">{field.url}</a>}
      {field.help && field.type !== 'confirm' && <p className="mt-2 text-[13.5px] text-[var(--faint)]">{field.help}</p>}
      {field.type === 'secret' && <p className="mt-2 text-[13.5px] text-[var(--faint)]">Stored on your machine. The agent receives a reference, never the value.</p>}
      {field.recommend && !field.must_decide && <p className="mt-2 text-[13px] text-[var(--faint)]"><span className="font-mono uppercase tracking-[.08em]">Recommended</span>{field.type !== 'choice' && <>: {String(field.recommend.value)}</>} · {field.recommend.why}</p>}
      {field.must_decide && <p className="mt-2 text-[13px] text-[var(--faint)]">This one needs your decision.</p>}
      {showNote
        ? <Textarea id={`${id}_ctx`} value={note ?? ''} placeholder="Context for this answer" spellCheck={false} disabled={disabled} className="mt-2 min-h-14 text-[13.5px]" onChange={(event) => onNoteChange(field.name, event.target.value)} />
        : <button type="button" className="mt-2 block font-mono text-[11px] uppercase leading-none tracking-[.08em] text-[var(--faint)] hover:text-[var(--accent)]" disabled={disabled} onClick={() => setShowNote(true)}>+ context</button>}
    </div>
  )
}

function AskCard({ ask, onFinished }: { ask: Ask; onFinished: () => void }) {
  const seededValues = useMemo(() => initialValues(ask), [ask])
  const [values, setValues] = useState<Values>(seededValues)
  const [notes, setNotes] = useState<Record<string, string>>(ask.field_context || {})
  const [reply, setReply] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const draftTimer = useRef<number | undefined>(undefined)
  const secretNames = useMemo(() => new Set(ask.fields.filter((field) => field.type === 'secret').map((field) => field.name)), [ask.fields])
  const unanswered = ask.fields.filter((field) => !(field.name in (ask.answers || {})))
  const missing = unanswered.filter((field) => field.required && isMissing(values[field.name])).map((field) => field.label)
  const detected = ask.origin.detected === true
  const isDecision = ask.purpose === 'decision'
  useEffect(() => () => window.clearTimeout(draftTimer.current), [])

  const scheduleDraft = (nextValues: Values, nextNotes: Record<string, string>) => {
    window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => {
      const safe = Object.fromEntries(Object.entries(nextValues).filter(([key]) => !secretNames.has(key)))
      api('/api/draft', { ticket: ask.ticket, values: safe, field_context: nextNotes }).catch(() => undefined)
    }, 700)
  }
  const onChange = (name: string, value: FieldValue, isSecret = false) => {
    const next = { ...values, [name]: value }
    setValues(next)
    setState('idle')
    setMessage('')
    if (isSecret) return
    scheduleDraft(next, notes)
  }
  const onNoteChange = (name: string, noteText: string) => {
    const next = { ...notes, [name]: noteText }
    setNotes(next)
    setState('idle')
    setMessage('')
    scheduleDraft(values, next)
  }
  const submit = async () => {
    setState('sending'); setMessage('sending…')
    try {
      const output = await api<{ complete: boolean }>('/api/answer', { ticket: ask.ticket, values, reply, field_context: notes })
      setState('done')
      setMessage(output.complete ? ask.gating ? `sent · waking ${ask.origin.agent || 'agent'}` : 'sent' : 'saved, still incomplete')
      if (output.complete) window.setTimeout(onFinished, 1200)
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setMessage(error instanceof Error ? error.message : 'Could not send answer')
    }
  }
  /**
   * The third exit. Answering was the only way to release an agent, so a badly
   * formed ask could only be satisfied or abandoned — and abandoning it leaves
   * the agent parked forever. Sending it back is a real response: it carries
   * the note, releases the agent, and tells it to ask again properly.
   *
   * It is deliberately enabled exactly when the primary action is NOT: the
   * whole point is disagreeing with the question rather than answering it.
   */
  const sendBack = async () => {
    setState('sending'); setMessage('sending back…')
    try {
      await api('/api/answer', { ticket: ask.ticket, reply, bounce: true })
      setState('done')
      setMessage('sent back — the agent will rework it')
      window.setTimeout(onFinished, 1400)
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setMessage(error instanceof Error ? error.message : 'Could not send it back')
    }
  }
  const herdrHref = ask.origin.pane_id
    ? `herdr://focus?pane=${encodeURIComponent(ask.origin.pane_id)}` +
      (ask.origin.tab_id ? `&tab=${encodeURIComponent(ask.origin.tab_id)}` : '') +
      (ask.origin.workspace_id ? `&workspace=${encodeURIComponent(ask.origin.workspace_id)}` : '')
    : undefined
  const isBusy = state === 'sending' || state === 'done'
  return (
    <Card className={cn('p-4 sm:p-[18px]', ask.gating && 'border-[var(--accent)]', detected && 'bg-[var(--surface2)] opacity-80', state === 'done' && 'opacity-50')}>
      <div className="mb-2.5 flex flex-wrap gap-x-2.5 gap-y-1 font-mono text-[11px] uppercase leading-4 tracking-[.1em] text-[var(--faint)]">
        {ask.gating ? <span className="text-[var(--accent)]">● gating</span> : detected ? <span>detected</span> : <span>filed</span>}
        <span>{ask.origin.agent || 'agent'}</span>
        {ask.origin.workspace_name && <span>{ask.origin.workspace_name}</span>}
        {ask.origin.pane_id && herdrHref && <a href={herdrHref} title="Jump to this pane in Herdr" className="underline decoration-[var(--rule)] underline-offset-2 hover:text-[var(--accent)] hover:decoration-[var(--accent)]">pane {ask.origin.pane_id}</a>}
        <span>{ago(ask.created_at)}</span>
      </div>
      <h2 className="text-balance text-[17.5px] font-semibold leading-[1.3] tracking-[-.01em]">{ask.title}</h2>
      <p className="mt-1.5 text-pretty text-[14.5px] text-[var(--dim)]">{ask.why}</p>
      {!!ask.steps?.length && <ol className="my-4 list-decimal space-y-1 pl-5 text-[14.5px] text-[var(--dim)] marker:text-[var(--faint)]">{ask.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      {!!ask.links?.length && <div className="my-4 grid gap-1.5">{ask.links.map((link) => <a key={link.url} className="break-all text-[14.5px] text-[var(--ink)] underline decoration-[var(--accent)] underline-offset-[3px] hover:text-[var(--accent)]" href={link.url} target="_blank" rel="noreferrer noopener">{link.label}</a>)}</div>}
      <div className="mt-4">{unanswered.map((field) => <FieldControl key={field.name} field={field} ticket={ask.ticket} value={values[field.name]} note={notes[field.name]} onChange={onChange} onNoteChange={onNoteChange} disabled={isBusy} />)}</div>
      <div className="border-t border-[var(--rule)] py-4">
        <label htmlFor={`reply_${ask.ticket}`} className="mb-2 block font-mono text-[11px] uppercase leading-none tracking-[.12em] text-[var(--dim)]">Anything else <span className="normal-case tracking-[.04em] text-[var(--faint)]">— or why you're sending it back</span></label>
        <Textarea id={`reply_${ask.ticket}`} value={reply} placeholder="Add context the fields don't cover, or say what's wrong with this ask" disabled={isBusy} className="min-h-20 font-sans text-[14.5px]" onChange={(event) => setReply(event.target.value)} />
      </div>
      {!detected && <div className="mt-1 flex flex-wrap items-center gap-2.5 border-t border-[var(--rule)] pt-4">
        <Button disabled={missing.length > 0 || isBusy} onClick={() => void submit()}>{isDecision ? 'Submit' : ask.gating ? 'Answer & wake' : 'Answer'}</Button>
        <Button variant="ghost" className="h-[39px]" disabled={reply.trim() === '' || isBusy} title={reply.trim() === '' ? "Say what's wrong with it first" : 'Send this ask back unanswered'} onClick={() => void sendBack()}>Send back unanswered</Button>
        <span className={cn('font-mono text-[11px] leading-4 tracking-[.04em] text-[var(--faint)]', state === 'error' && 'text-[var(--danger)]', state === 'done' && 'text-[var(--ok)]')}>{message || (missing.length ? `still needs: ${missing.join(', ')}` : '')}</span>
      </div>}
    </Card>
  )
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-[var(--radius)] border border-[var(--rule)] px-5 py-10 text-center text-[15px] text-[var(--dim)]"><strong className="mb-1.5 block text-[17px] font-semibold text-[var(--ink)]">{title}</strong>{detail}</div>
}

export default function App() {
  const [data, setData] = useState<QueueData | null>(null)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)
  const [activeTab, setActiveTab] = useState<'blocker' | 'decision'>(() => window.location.hash === '#grill' ? 'decision' : 'blocker')
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
  const allAsks = (data?.asks || []).filter((ask) => ask.status === 'open').sort((a, b) => Number(b.gating) - Number(a.gating) || Number(a.origin.detected) - Number(b.origin.detected) || a.created_at - b.created_at)
  const blockerAsks = allAsks.filter((ask) => ask.purpose === 'blocker')
  const decisionAsks = allAsks.filter((ask) => ask.purpose === 'decision')
  useEffect(() => {
    if (!data || window.location.hash === '#unblock' || window.location.hash === '#grill') return
    const next = decisionAsks.some((ask) => ask.gating) && !blockerAsks.some((ask) => ask.gating) ? 'decision' : 'blocker'
    window.location.replace(next === 'decision' ? '#grill' : '#unblock')
    setActiveTab(next)
  }, [data, blockerAsks, decisionAsks])
  if (finished) return <main className="mx-auto max-w-[62ch] px-4 py-20"><EmptyState title="This link is finished" detail="Ask for a fresh one, or answer in the herdr pane." /></main>
  const asks = activeTab === 'blocker' ? blockerAsks : decisionAsks
  const setTab = (tab: 'blocker' | 'decision') => { window.location.hash = tab === 'blocker' ? 'unblock' : 'grill'; setActiveTab(tab) }
  const tabCopy = activeTab === 'blocker'
    ? { title: asks.length ? 'What only you can do' : 'Nothing needs doing', detail: asks.length ? 'Supply access, complete a step, or confirm you did it.' : 'No agent is waiting on an action from you.' }
    : { title: asks.length ? 'What only you can decide' : 'No rulings needed', detail: asks.length ? 'Review the agent’s recommendation, then accept it or choose differently.' : 'No agent is waiting on a decision from you.' }
  return (
    <div className="mx-auto max-w-[62ch] px-4 pb-20 pt-5 sm:px-5 sm:pb-24 sm:pt-8">
      <header className="mb-8">
        <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[11px] uppercase leading-none tracking-[.14em] text-[var(--faint)]"><span className="font-semibold tracking-[.1em] text-[var(--ink)]">unblock</span>{data?.profile && data.profile !== '*' && <span>profile {data.profile}</span>}{!!data?.hidden && <span>{data.hidden} more in other profiles</span>}</div>
        <nav aria-label="Ask type" className="flex items-stretch border-b border-[var(--rule)]">
          <button type="button" aria-current={activeTab === 'blocker' ? 'page' : undefined} onClick={() => setTab('blocker')} className={cn('min-w-0 flex-1 border-b-2 border-transparent px-1 py-3 text-left font-mono text-[12px] font-semibold uppercase tracking-[.12em] text-[var(--faint)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]', activeTab === 'blocker' && 'border-[var(--accent)] text-[var(--ink)]')}>Unblock · {data ? blockerAsks.length : '—'}</button>
          <button type="button" aria-current={activeTab === 'decision' ? 'page' : undefined} onClick={() => setTab('decision')} className={cn('min-w-0 flex-1 border-b-2 border-transparent px-1 py-3 text-left font-mono text-[12px] font-semibold uppercase tracking-[.12em] text-[var(--faint)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]', activeTab === 'decision' && 'border-[var(--accent)] text-[var(--ink)]')}>Grill · {data ? decisionAsks.length : '—'}</button>
          {VIEWER && <span className="self-center pl-2 font-mono text-[11px] leading-4 text-[var(--faint)]" title={VIEWER.login}>{VIEWER.name || VIEWER.login}</span>}
        </nav>
        <h1 className="mt-6 text-balance text-2xl font-semibold leading-tight tracking-[-.02em]">{tabCopy.title}</h1>
        <p className="mt-1.5 text-pretty text-[14.5px] text-[var(--dim)]">{tabCopy.detail}</p>
      </header>
      <main aria-live="polite">{error ? <EmptyState title="Cannot reach the daemon" detail={error} /> : !data ? <EmptyState title="Loading" detail="Fetching the queue." /> : asks.length === 0 ? <EmptyState title={tabCopy.title} detail={tabCopy.detail} /> : <div className="grid gap-3.5">{asks.map((ask) => <AskCard key={ask.ticket} ask={ask} onFinished={load} />)}</div>}</main>
      <footer className="mt-10 border-t border-[var(--rule)] pt-3.5 font-mono text-[11px] uppercase leading-5 tracking-[.1em] text-[var(--faint)]">this link expires · answers go straight to the agent</footer>
    </div>
  )
}
