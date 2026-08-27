import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from './components/ui/button'
import { Textarea } from './components/ui/textarea'
import { cn } from './lib/utils'
import { api, BASE, FinishedError } from './lib/api'
import { clearLocal, readLocal, writeLocal } from './lib/drafts'
import { FieldControl } from './FieldControl'
import { ago, groupOf, isMissing, type Ask, type Bounced, type FieldValue, type Values } from './deck'

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

export function SuccessOverlay({ label }: { label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-[inherit] bg-[var(--surface)]/92 backdrop-blur-[2px]"
    >
      <motion.span
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 22 }}
        className="flex size-12 items-center justify-center rounded-full bg-[var(--ok)] text-[22px] font-bold text-white"
      >
        ✓
      </motion.span>
      <motion.p initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.08 }} className="text-[14.5px] font-medium text-[var(--dim)]">
        {label}
      </motion.p>
    </motion.div>
  )
}

interface SoloCardProps {
  ask: Ask
  deferrable: boolean
  onFinished: () => void
  onDefer: () => void
}

export function SoloCard({ ask, deferrable, onFinished, onDefer }: SoloCardProps) {
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
   * follows on a short debounce.
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
        window.setTimeout(onFinished, 950)
      }
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setMessage(error instanceof Error ? error.message : 'Could not send answer')
    }
  }
  /**
   * The third exit, for the whole ask. Sending it back is a real response: it
   * carries the note (optional), releases the agent, and tells it to ask again
   * properly. Never disabled.
   */
  const sendBack = async () => {
    setState('sending'); setMessage('sending back…')
    try {
      await api('/api/answer', { ticket: ask.ticket, reply, bounce: true })
      setState('done')
      setMessage('sent back — the agent will rework it')
      clearLocal(ask.ticket)
      window.setTimeout(onFinished, 1100)
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
    <article onKeyDown={onKeyDown} className={cn('relative rounded-[var(--radius-lg)] border border-[var(--rule)] bg-[var(--surface)] px-4 py-7 shadow-[0_1px_0_rgba(255,255,255,.6)_inset,0_18px_40px_-24px_rgba(60,45,20,.35)] sm:px-7 sm:py-8', detected && 'opacity-75')}>
      <AnimatePresence>{state === 'done' && <SuccessOverlay label={message} />}</AnimatePresence>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[12px] leading-5 text-[var(--faint)]">
        {ask.gating ? <span className="font-semibold text-[var(--accent)]">● waiting</span> : detected ? <span>detected</span> : <span>filed</span>}
        <span aria-hidden>·</span>
        <span>{ask.origin.agent || 'agent'}</span>
        <span aria-hidden>·</span>
        <span className="text-[var(--dim)]">{groupOf(ask)}</span>
        {ask.origin.pane_id && herdrHref && <><span aria-hidden>·</span><a href={herdrHref} onClick={(event) => { event.preventDefault(); openHerdr(herdrHref) }} title="Jump to this pane in Herdr" className="underline decoration-[var(--faint)] underline-offset-2 hover:text-[var(--accent)] hover:decoration-[var(--accent)]">{ask.origin.pane_id}</a></>}
        <span aria-hidden>·</span>
        <span>{ago(ask.created_at)}</span>
        {draftState !== 'idle' && <><span aria-hidden>·</span><span className={cn(draftState === 'offline' && 'text-[var(--danger)]')}>{draftState === 'saving' ? 'saving draft…' : draftState === 'saved' ? 'draft saved' : 'draft kept in this browser'}</span></>}
      </div>
      <h2 className="font-display mt-3.5 text-balance text-[24px] font-semibold leading-[1.25] tracking-[-.01em] sm:text-[26px]">{ask.title}</h2>
      <p className="mt-2 text-pretty text-[15px] leading-relaxed text-[var(--dim)]">{ask.why}</p>
      {!!ask.steps?.length && <ol className="my-4 list-decimal space-y-1.5 pl-6 text-[15px] leading-relaxed marker:text-[var(--faint)]">{ask.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      {!!ask.links?.length && <div className="my-4 grid gap-1.5">{ask.links.map((link) => <a key={link.url} className="break-all text-[15px] text-[var(--ink)] underline decoration-[var(--accent)] underline-offset-[3px] hover:text-[var(--accent)]" href={link.url} target="_blank" rel="noreferrer noopener">{link.label}</a>)}</div>}
      <div className="mt-4">{unanswered.map((field) => <FieldControl key={field.name} field={field} ticket={ask.ticket} value={values[field.name]} note={notes[field.name]} bounceNote={bounced[field.name]} onChange={onChange} onNoteChange={onNoteChange} onBounce={onBounce} disabled={isBusy} />)}</div>
      {!detected && <div className="border-t border-[var(--rule)] py-5">
        <label htmlFor={`reply_${ask.ticket}`} className="mb-2 block text-[13.5px] font-semibold leading-5 text-[var(--ink)]">Anything else <span className="font-normal text-[var(--faint)]">· or why you're sending it back</span></label>
        <Textarea id={`reply_${ask.ticket}`} value={reply} placeholder="Add context the fields don't cover, or say what's wrong with this ask" disabled={isBusy} className="min-h-20" onChange={(event) => onReplyChange(event.target.value)} />
      </div>}
      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 rounded-b-[var(--radius-lg)] border-t border-[var(--rule)] bg-[var(--surface)] px-4 py-4 sm:-mx-7 sm:px-7">
        {!detected && <>
          <Button disabled={hardMissing.length > 0 || isBusy} onClick={() => void submit()}>{ask.gating ? 'Answer & wake' : isDecision ? 'Submit & next' : 'Answer & next'}</Button>
          <Button variant="secondary" disabled={isBusy} title="Send the whole ask back unanswered — a note above goes with it" onClick={() => void sendBack()}>Send back</Button>
        </>}
        {deferrable && <button type="button" className="text-[13.5px] font-medium text-[var(--faint)] hover:text-[var(--ink)]" disabled={isBusy} title="Skip for now — this card comes back at the end of the deck" onClick={onDefer}>Skip</button>}
        <span className={cn('min-w-0 text-[13px] leading-5 text-[var(--faint)]', state === 'error' && 'text-[var(--danger)]', state === 'done' && 'text-[var(--ok)]')}>{statusHint}</span>
      </div>
    </article>
  )
}
