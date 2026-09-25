import { useEffect, useMemo, useRef, useState } from 'react'
import { Linkify } from './lib/linkify'
import { Icon, stateOf } from './icons'
import { api, BASE, FinishedError } from './lib/api'
import { clearLocal, readLocal, writeLocal } from './lib/drafts'
import { FieldControl } from './FieldControl'
import { ago, groupOf, isMissing, type Ask, type Bounced, type FieldValue, type Values } from './deck'

const onlyYou: Record<string, string> = {
  credential: 'Your sign-in or key',
  their_account: 'A click in your account',
  spend: 'Spending or a new account',
  message: 'A message from you',
  judgment: 'Your call',
}

/**
 * Navigate to a custom-scheme URL without touching the page. A plain anchor
 * click makes some Chromium shells open an about:blank tab when no OS handler
 * answers; a throwaway iframe fires the handler with no navigation either way.
 */
function openExternalScheme(href: string) {
  const frame = document.createElement('iframe')
  frame.style.display = 'none'
  frame.src = href
  document.body.appendChild(frame)
  window.setTimeout(() => frame.remove(), 2000)
}

function Properties({ ask, herdrHref, topLinks }: {
  ask: Ask
  herdrHref: string | undefined
  topLinks: { label: string; url: string }[]
}) {
  const status = stateOf(ask)
  return (
    <div className="properties">
      <div className="property">
        <span className="property-label">Status</span>
        <span className="property-value">
          <Icon name={status.name} /> {status.label}{' '}
          <span className="muted">
            · {ask.gating ? 'the agent waits for you' : 'the agent keeps working'}
          </span>
        </span>
      </div>
      {ask.only_you && (
        <div className="property">
          <span className="property-label">Needs you for</span>
          <span className="property-value">{onlyYou[ask.only_you] || ask.only_you}</span>
        </div>
      )}
      <div className="property">
        <span className="property-label">Asked by</span>
        <span className="property-value">
          {ask.origin.agent || 'agent'}{' '}
          {herdrHref && (
            <>
              <span className="muted">·</span>{' '}
              <a
                href={herdrHref}
                className="mono pane-link"
                onClick={(event) => { event.preventDefault(); openExternalScheme(herdrHref) }}
              >
                {ask.origin.pane_id}
              </a>
            </>
          )}{' '}
          <span className="muted">· {ago(ask.created_at)} ago</span>
        </span>
      </div>
      {!!topLinks.length && (
        <div className="property">
          <span className="property-label">Links</span>
          <span className="property-value links">
            {topLinks.map((link) => {
              const isHttp = /^https?:/i.test(link.url)
              return (
                <a
                  key={link.url}
                  href={link.url}
                  target={isHttp ? '_blank' : undefined}
                  rel="noopener noreferrer"
                  onClick={isHttp ? undefined : (event) => {
                    event.preventDefault(); openExternalScheme(link.url)
                  }}
                >
                  {link.label} ↗
                </a>
              )
            })}
          </span>
        </div>
      )}
    </div>
  )
}

function ActionBar({
  isDecision, hardMissing, isBusy, submit, hasRecommendations, useRecommendations,
  armed, onSendBack, statusHint, hasError,
}: {
  isDecision: boolean; hardMissing: string[]; isBusy: boolean; submit: () => void
  hasRecommendations: boolean; useRecommendations: () => void
  armed: boolean; onSendBack: () => void; statusHint: string; hasError: boolean
}) {
  return (
    <div className="action-bar">
      <button className="primary" disabled={hardMissing.length > 0 || isBusy} onClick={submit}>
        {isDecision ? 'Send decision' : 'Send answer'}
      </button>
      <div className="action-secondary">
        {hasRecommendations && (
          <button className="secondary" disabled={isBusy} onClick={useRecommendations}>
            Use recommendations
          </button>
        )}
        <button className="text-button" disabled={isBusy} onClick={onSendBack}>
          {armed ? 'Confirm send back?' : 'Send back…'}
        </button>
      </div>
      <span className={`action-status${hasError ? ' error' : ''}`} role="status">{statusHint}</span>
    </div>
  )
}

export function SoloCard({ ask, onFinished }: { ask: Ask; onFinished: () => void }) {
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
  const [showReply, setShowReply] = useState(!!seeded.reply)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])
  const draftTimer = useRef<number | undefined>(undefined)
  const completed = useRef(false)
  const latest = useRef({
    values: seeded.values, notes: seeded.notes, reply: seeded.reply, bounced: seeded.bounced,
  })
  const secretNames = useMemo(
    () => new Set(ask.fields.filter((field) => field.type === 'secret').map((field) => field.name)),
    [ask.fields],
  )
  const unanswered = ask.fields.filter((field) => !(field.name in (ask.answers || {})))
  const missing = unanswered
    .filter((field) => !(field.name in bounced) && field.required && isMissing(values[field.name]))
    .map((field) => field.label)
  // Only must_decide fields hard-block the submit — and sending one back
  // counts as engaging with it. Everything else left blank is sent as an
  // explicit skip (null), a real "no answer" the agent acts on.
  const hardMissing = unanswered
    .filter((field) => field.must_decide && !(field.name in bounced) && isMissing(values[field.name]))
    .map((field) => field.label)
  const detected = ask.origin.detected === true
  const isDecision = ask.purpose === 'decision'

  const safeValues = (raw: Values) =>
    Object.fromEntries(Object.entries(raw).filter(([key]) => !secretNames.has(key)))

  /**
   * Every change lands in localStorage synchronously, then the server draft
   * follows on a short debounce.
   *
   * Short on purpose: an agent watching this ask reads the drafts to decide
   * what to ask next, so a single choice click has to reach the daemon while
   * the human is still on the question, not after they have moved on.
   */
  const persist = (next: Partial<typeof latest.current>) => {
    const merged = { ...latest.current, ...next }
    latest.current = merged
    const safe = safeValues(merged.values)
    writeLocal(ask.ticket, {
      values: safe, notes: merged.notes, reply: merged.reply, bounced: merged.bounced,
    })
    window.clearTimeout(draftTimer.current)
    setDraftState('saving')
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = undefined
      api('/api/draft', {
        ticket: ask.ticket,
        values: safeValues(merged.values),
        field_context: merged.notes,
        reply: merged.reply,
      })
        .then(() => setDraftState('saved'))
        .catch(() => setDraftState('offline'))
    }, 300)
  }

  /** Leaving the page flushes a pending draft without waiting on the network. */
  useEffect(() => {
    const flush = () => {
      if (draftTimer.current === undefined || completed.current) return
      window.clearTimeout(draftTimer.current)
      draftTimer.current = undefined
      const merged = latest.current
      const body = new Blob(
        [JSON.stringify({
          ticket: ask.ticket,
          values: safeValues(merged.values),
          field_context: merged.notes,
          reply: merged.reply,
        })],
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
      flush()
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
    if (hardMissing.length || isBusy || detected) return
    setState('sending'); setMessage('sending…')
    // Bounced fields keep their typed value: the store stores it beside the
    // bounce note as a draft, so "right, but ask me again" is expressible.
    const payload: Values = { ...values }
    for (const field of unanswered) {
      if (field.name in bounced) continue
      if (field.required && !field.must_decide && isMissing(payload[field.name])) payload[field.name] = null
    }
    try {
      const output = await api<{ complete: boolean }>('/api/answer', {
        ticket: ask.ticket, values: payload, reply, field_context: notes, field_bounce: bounced,
      })
      setState('done')
      setMessage(
        output.complete
          ? (ask.gating ? `sent · waking ${ask.origin.agent || 'agent'}` : 'sent')
          : 'saved, still incomplete',
      )
      if (output.complete) {
        completed.current = true
        window.clearTimeout(draftTimer.current)
        draftTimer.current = undefined
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
   * properly. Never disabled.
   */
  const sendBack = async () => {
    setState('sending'); setMessage('sending back…')
    try {
      await api('/api/answer', { ticket: ask.ticket, reply, bounce: true })
      setState('done')
      setMessage('sent back — the agent will rework it')
      completed.current = true
      window.clearTimeout(draftTimer.current)
      draftTimer.current = undefined
      clearLocal(ask.ticket)
      window.setTimeout(onFinished, 1200)
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setMessage(error instanceof Error ? error.message : 'Could not send it back')
    }
  }
  /** Cmd/Ctrl+Enter submits this ask; it never changes the selected ask. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (isBusy || detected) return
    event.preventDefault()
    if (hardMissing.length > 0) return
    void submit()
  }
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
  // A field's own url stays beside that field ("Open the screen"); the
  // Links row is only the ask's links, so a question never reads as a link.
  const topLinks = (ask.links || [])
    .filter((link, index, links) => links.findIndex((item) => item.url === link.url) === index)
  const herdrHref = ask.origin.pane_id
    ? `herdr://focus?pane=${encodeURIComponent(ask.origin.pane_id)}` +
      (ask.origin.tab_id ? `&tab=${encodeURIComponent(ask.origin.tab_id)}` : '') +
      (ask.origin.workspace_id ? `&workspace=${encodeURIComponent(ask.origin.workspace_id)}` : '')
    : undefined
  const isBusy = state === 'sending' || state === 'done'

  // Field labels can be whole sentences, so naming several of them buries the
  // bar in prose. Name one, count the rest.
  const stillNeeds = hardMissing.length === 1
    ? `Pick an answer for "${hardMissing[0]}"`
    : hardMissing.length > 1
      ? `Pick answers for ${hardMissing.length} questions`
      : ''
  const statusHint = state === 'error'
    ? message
    : state === 'sending'
      ? 'Sending…'
      : state === 'done'
        ? 'Sent'
        : armed
          ? 'Send back the whole ask and discard answers?'
          : stillNeeds || (
            draftState === 'offline'
              ? 'Draft kept in this browser'
              : draftState === 'saved'
                ? 'Draft saved'
                : missing.length
                  ? `${missing.length} ${missing.length === 1 ? 'question' : 'questions'} left`
                  : ''
          )
  const hasRecommendations = unanswered.some(
    (field) => !field.must_decide && field.recommend
      && isMissing(values[field.name]) && !(field.name in bounced),
  )
  const useRecommendations = () => {
    const next = { ...latest.current.values }
    for (const field of unanswered) {
      if (!field.must_decide && field.recommend && isMissing(next[field.name])
        && !(field.name in bounced) && field.type !== 'secret') {
        next[field.name] = field.recommend.value
      }
    }
    setValues(next)
    persist({ values: next })
  }
  const onSendBackClick = () => {
    if (!armed) { setArmed(true); setShowReply(true) }
    else void sendBack()
  }

  return (
    <article className="document">
      <div className="document-body">
        <div className="breadcrumb">
          <span>{groupOf(ask)} / {stateOf(ask).label}</span>
          <span className="ticket">{ask.ticket}</span>
        </div>
        <h1>{ask.title}</h1>
        <Properties ask={ask} herdrHref={herdrHref} topLinks={topLinks} />
        <section className="context"><h2>Why</h2><p><Linkify text={ask.why} /></p></section>
        {!!ask.tried?.length && (
          <details className="tried">
            <summary>What the agent tried ({ask.tried.length})</summary>
            <ul>{ask.tried.map((item, i) => <li key={i}><Linkify text={item} /></li>)}</ul>
          </details>
        )}
        {!!ask.steps?.length && (
          <section className="steps">
            <h2>Do this</h2>
            <ol>{ask.steps.map((step, i) => <li key={i}><Linkify text={step} /></li>)}</ol>
          </section>
        )}
        {!detected && (
          <>
            <section className="questions">
              <h2>Your answer</h2>
              {unanswered.map((field) => (
                <FieldControl
                  key={field.name}
                  field={field}
                  ticket={ask.ticket}
                  value={values[field.name]}
                  note={notes[field.name]}
                  bounceNote={bounced[field.name]}
                  onChange={onChange}
                  onNoteChange={onNoteChange}
                  onBounce={onBounce}
                  disabled={isBusy}
                />
              ))}
            </section>
            <section className="reply">
              <h2>Anything else</h2>
              {!showReply && !reply ? (
                <button className="text-button" type="button" onClick={() => setShowReply(true)}>
                  Add a reply
                </button>
              ) : (
                <textarea
                  aria-label="Anything else"
                  className="control"
                  value={reply}
                  placeholder="Add context or say why you're sending it back"
                  disabled={isBusy}
                  onChange={(event) => onReplyChange(event.target.value)}
                />
              )}
            </section>
          </>
        )}
      </div>
      {!detected && (
        <ActionBar
          isDecision={isDecision}
          hardMissing={hardMissing}
          isBusy={isBusy}
          submit={() => void submit()}
          hasRecommendations={hasRecommendations}
          useRecommendations={useRecommendations}
          armed={armed}
          onSendBack={onSendBackClick}
          statusHint={statusHint}
          hasError={state === 'error'}
        />
      )}
    </article>
  )
}
