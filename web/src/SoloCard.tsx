import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
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
  // Sending the whole ask back discards every answer on the card and cannot be
  // undone, and it sits next to the primary button. One click arms it, a
  // second sends it. Nothing else on the card is destructive enough to need
  // this, and nothing else gets it.
  const [armed, setArmed] = useState(false)
  const [step, setStep] = useState(0)
  const [reviewing, setReviewing] = useState(false)
  const reduced = useReducedMotion()
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])
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
    // Bounced fields keep their typed value: the store stores it beside the
    // bounce note as a draft, so "right, but ask me again" is expressible.
    const payload: Values = { ...values }
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
  /**
   * Cmd+Enter (or Ctrl+Enter) moves you forward: to the next question while
   * stepping through a long ask, and to send once everything is on screen.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (isBusy || detected) return
    event.preventDefault()
    if (paged && !reviewing) {
      if (step >= unanswered.length - 1) setReviewing(true)
      else setStep((current) => current + 1)
      return
    }
    if (hardMissing.length > 0) return
    void submit()
  }
  const herdrHref = ask.origin.pane_id
    ? `herdr://focus?pane=${encodeURIComponent(ask.origin.pane_id)}` +
      (ask.origin.tab_id ? `&tab=${encodeURIComponent(ask.origin.tab_id)}` : '') +
      (ask.origin.workspace_id ? `&workspace=${encodeURIComponent(ask.origin.workspace_id)}` : '')
    : undefined
  const isBusy = state === 'sending' || state === 'done'
  const bounceCount = Object.keys(bounced).length

  /**
   * A nine-question grill is not a card, it is a wall. Past three open
   * questions the card steps through them one at a time and ends on a review
   * of everything before it sends — the deck's premise applied inside the
   * card, instead of abandoned the moment an ask gets long.
   */
  const paged = unanswered.length > 3 && !detected
  const stepIndex = Math.min(step, Math.max(unanswered.length - 1, 0))
  const stepField = unanswered[stepIndex]
  const showAll = !paged || reviewing
  const isLastStep = stepIndex >= unanswered.length - 1
  const dotState = (field: typeof unanswered[number]) =>
    field.name in bounced ? 'bounced' : !isMissing(values[field.name]) ? 'done' : 'todo'
  // Field labels can be whole sentences, so naming three of them buries the
  // bar in prose. Name one, count the rest.
  const stillNeeds = hardMissing.length === 1
    ? `still needs: ${hardMissing[0]}`
    : hardMissing.length > 1
      ? `still needs ${hardMissing.length} decisions`
      : ''
  const answeredCount = unanswered.filter((field) => dotState(field) !== 'todo').length
  const statusHint = message
    || (armed ? 'this throws away every answer on this card' : '')
    || (paged && !reviewing
      ? answeredCount
        ? `${answeredCount} of ${unanswered.length} answered · blanks go back as skipped`
        : 'blanks go back as skipped'
      : '')
    || stillNeeds
    || [
      missing.length ? `${missing.length} unanswered ${missing.length === 1 ? 'field goes' : 'fields go'} back as skipped` : '',
      bounceCount ? `${bounceCount} ${bounceCount === 1 ? 'question goes' : 'questions go'} back for rework` : '',
    ].filter(Boolean).join(' · ')

  return (
    <article onKeyDown={onKeyDown} className={cn('relative rounded-[var(--radius-lg)] border border-[var(--rule)] bg-[var(--surface)] px-4 pt-7 shadow-[0_1px_0_rgba(255,255,255,.6)_inset,0_18px_40px_-24px_rgba(60,45,20,.35)] sm:px-7 sm:pt-8', detected && 'opacity-75')}>
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
      {paged && !reviewing && (
        <div className="mt-5 flex items-center gap-1.5">
          {unanswered.map((field, index) => {
            const shape = dotState(field)
            return (
              <button
                key={field.name}
                type="button"
                title={field.label}
                aria-label={`Question ${index + 1}: ${field.label}`}
                aria-current={index === stepIndex ? 'step' : undefined}
                disabled={isBusy}
                onClick={() => setStep(index)}
                className={cn(
                  'h-1.5 flex-1 rounded-full transition-colors duration-200',
                  shape === 'done' ? 'bg-[var(--ok)]' : shape === 'bounced' ? 'bg-[var(--danger)]' : 'bg-[var(--rule)]',
                  index === stepIndex && 'ring-2 ring-[var(--ink)] ring-offset-2 ring-offset-[var(--surface)]',
                )}
              />
            )
          })}
          <span className="ml-2 shrink-0 font-mono text-[12px] text-[var(--faint)]">{stepIndex + 1}/{unanswered.length}</span>
        </div>
      )}
      <div className="mt-4">
        {showAll ? (
          unanswered.map((field) => <FieldControl key={field.name} field={field} ticket={ask.ticket} value={values[field.name]} note={notes[field.name]} bounceNote={bounced[field.name]} onChange={onChange} onNoteChange={onNoteChange} onBounce={onBounce} disabled={isBusy} />)
        ) : stepField ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={stepField.name}
              initial={reduced ? { opacity: 0 } : { opacity: 0, x: 22 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, x: -22 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <FieldControl field={stepField} ticket={ask.ticket} value={values[stepField.name]} note={notes[stepField.name]} bounceNote={bounced[stepField.name]} onChange={onChange} onNoteChange={onNoteChange} onBounce={onBounce} disabled={isBusy} />
            </motion.div>
          </AnimatePresence>
        ) : null}
      </div>
      {paged && reviewing && (
        <button type="button" className="mt-1 text-[13px] leading-5 text-[var(--faint)] hover:text-[var(--ink)]" disabled={isBusy} onClick={() => setReviewing(false)}>
          Back to one at a time
        </button>
      )}
      {!detected && showAll && <div className="border-t border-[var(--rule)] py-5">
        <label htmlFor={`reply_${ask.ticket}`} className="mb-2 block text-[13.5px] font-semibold leading-5 text-[var(--ink)]">Anything else <span className="font-normal text-[var(--faint)]">· or why you're sending it back</span></label>
        <Textarea id={`reply_${ask.ticket}`} value={reply} placeholder="Add context the fields don't cover, or say what's wrong with this ask" disabled={isBusy} className="min-h-20" onChange={(event) => onReplyChange(event.target.value)} />
      </div>}
      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-3 rounded-b-[var(--radius-lg)] border-t border-[var(--rule)] bg-[var(--surface)] px-4 py-4 sm:-mx-7 sm:px-7">
        {paged && !reviewing ? (
          <>
            <Button variant="secondary" disabled={stepIndex === 0 || isBusy} onClick={() => setStep((current) => Math.max(current - 1, 0))}>Back</Button>
            {isLastStep ? (
              <Button disabled={isBusy} onClick={() => setReviewing(true)}>Review all {unanswered.length}</Button>
            ) : (
              <Button disabled={isBusy} onClick={() => setStep((current) => current + 1)}>Next</Button>
            )}
            {!isLastStep && <button type="button" className="text-[13.5px] font-medium text-[var(--faint)] hover:text-[var(--ink)]" disabled={isBusy} onClick={() => setReviewing(true)}>See all {unanswered.length}</button>}
          </>
        ) : !detected && (
          <>
            <Button disabled={hardMissing.length > 0 || isBusy} onClick={() => void submit()}>{ask.gating ? 'Answer & wake' : isDecision ? 'Submit & next' : 'Answer & next'}</Button>
            <Button
              variant="secondary"
              disabled={isBusy}
              title="Send the whole ask back unanswered. Every answer on this card is discarded; your note goes with it."
              className={cn(armed && 'border-[var(--danger)] text-[var(--danger)]')}
              onClick={() => (armed ? void sendBack() : setArmed(true))}
            >
              {armed ? 'Discard all & send back?' : 'Send back'}
            </Button>
          </>
        )}
        {deferrable && <button type="button" className="text-[13.5px] font-medium text-[var(--faint)] hover:text-[var(--ink)]" disabled={isBusy} title="Skip for now — this card comes back at the end of the deck" onClick={onDefer}>Skip</button>}
        <span className={cn('min-w-0 text-[13px] leading-5 text-[var(--faint)]', state === 'error' && 'text-[var(--danger)]', state === 'done' && 'text-[var(--ok)]')}>{statusHint}</span>
      </div>
    </article>
  )
}
