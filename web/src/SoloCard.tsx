import { useEffect, useMemo, useRef, useState } from 'react'
import { Linkify } from './lib/linkify'
import { Icon, stateOf } from './icons'
import { api, BASE, FinishedError, NetworkError } from './lib/api'
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

function LinkList({ links, className }: { links: { label: string; url: string }[]; className: string }) {
  return (
    <span className={`${className} links`}>
      {links.map((link) => {
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
  )
}

/**
 * Who asked, when, status and links: context, not the decision. It sits below
 * the question, folded on a phone and open on a wide screen, so the first
 * screen is always title, why and the question.
 */
function Details({ ask, herdrHref, topLinks }: {
  ask: Ask
  herdrHref: string | undefined
  topLinks: { label: string; url: string }[]
}) {
  const status = stateOf(ask)
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 960px)').matches)
  const summary = [
    `${ask.origin.agent || 'agent'} · ${ago(ask.created_at)} ago`,
    topLinks.length ? `${topLinks.length} ${topLinks.length === 1 ? 'link' : 'links'}` : '',
  ].filter(Boolean).join(' · ')
  return (
    <details
      className="details"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary><span className="details-label">Details</span> <span className="muted">{summary}</span></summary>
    <div className="properties">
      <div className="property">
        <span className="property-label">Ask</span>
        <span className="property-value">
          {groupOf(ask)} <span className="muted">·</span> <span className="ticket">{ask.ticket}</span>
        </span>
      </div>
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
          <LinkList links={topLinks} className="property-value" />
        </div>
      )}
      {!!ask.tried?.length && (
        <div className="property">
          <span className="property-label">Agent tried</span>
          <ul className="property-value tried-list">
            {ask.tried.map((item, i) => <li key={i}><Linkify text={item} /></li>)}
          </ul>
        </div>
      )}
    </div>
    </details>
  )
}

/** One line on every width: the bar must never grow over the question. */
function ActionBar({
  isDecision, hardMissing, isBusy, submit, armed, onSendBack, statusHint, hasError,
}: {
  isDecision: boolean; hardMissing: string[]; isBusy: boolean; submit: () => void
  armed: boolean; onSendBack: () => void; statusHint: string; hasError: boolean
}) {
  return (
    <div className="action-bar">
      <button className="primary" disabled={hardMissing.length > 0 || isBusy} onClick={submit}>
        {isDecision ? 'Send decision' : 'Send answer'}
      </button>
      <button className="text-button send-back" disabled={isBusy} onClick={onSendBack}>
        {armed ? 'Confirm send back?' : 'Send back…'}
      </button>
      <span className={`action-status${hasError ? ' error' : ''}`} role="status">{statusHint}</span>
    </div>
  )
}

/** Plain words for a failed send; the full sentence goes in the page, not the bar. */
function sendFailure(error: unknown, what: string, button: string): string {
  if (error instanceof NetworkError) {
    return `Not sent: the connection to unblock dropped, even after retrying. ${what} is still here. Tap ${button} to try again.`
  }
  return `Not sent: ${error instanceof Error ? error.message : 'unknown error'}.`
}

export function SoloCard({ ask, onFinished }: { ask: Ask; onFinished: () => void }) {
  /**
   * Seed once per ticket: server draft first, then the local mirror on top
   * when it is newer than what the daemon has. Later polls replace the `ask`
   * prop but must never clobber what is being typed.
   */
  const seeded = useMemo(() => {
    let found = {
      values: { ...(ask.draft || {}) } as Values,
      notes: { ...(ask.field_context || {}) },
      reply: ask.draft_reply || '',
      bounced: {} as Bounced,
    }
    const local = readLocal(ask.ticket)
    if (local && local.t > (ask.draft_updated_at || 0)) {
      found = {
        values: { ...found.values, ...(local.values || {}) },
        notes: { ...found.notes, ...(local.notes || {}) },
        reply: local.reply || found.reply,
        bounced: local.bounced || {},
      }
    }
    // The recommendation is the pre-picked answer, so one tap sends it. It
    // stays out of the draft until touched: an agent reading drafts must never
    // mistake the page's default for a choice.
    const prePicked = new Set<string>()
    for (const field of ask.fields) {
      if (field.name in (ask.answers || {}) || field.must_decide || !field.recommend) continue
      if (field.type === 'secret' || field.name in found.bounced) continue
      if (found.values[field.name] === undefined) {
        found.values[field.name] = field.recommend.value
        prePicked.add(field.name)
      }
    }
    return { ...found, prePicked }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.ticket])
  const prePicked = useRef(seeded.prePicked)
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
  // Only known, non-secret field names ever leave memory: an unexpected key
  // is dropped rather than trusted, so a mis-keyed secret cannot persist.
  const draftNames = useMemo(
    () => new Set(ask.fields.filter((field) => field.type !== 'secret').map((field) => field.name)),
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
    Object.fromEntries(Object.entries(raw).filter(
      ([key]) => draftNames.has(key) && !prePicked.current.has(key),
    ))

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
    prePicked.current.delete(name)
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
      setState('error'); setMessage(sendFailure(error, 'Your answer', isDecision ? 'Send decision' : 'Send answer'))
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
      setState('error'); setMessage(sendFailure(error, 'Your note', 'Send back'))
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
  const fieldUrls = new Set(ask.fields.map((field) => field.url).filter(Boolean))
  const topLinks = (ask.links || [])
    .filter((link, index, links) => links.findIndex((item) => item.url === link.url) === index)
    .filter((link) => !fieldUrls.has(link.url))
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
    ? 'Not sent'
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
  const onSendBackClick = () => {
    if (!armed) { setArmed(true); setShowReply(true) }
    else void sendBack()
  }

  return (
    <article className="document">
      <div className="document-body">
        <h1>{ask.title}</h1>
        <section className="context"><h2>Why</h2><p><Linkify text={ask.why} /></p></section>
        {!!ask.steps?.length && (
          <section className="steps">
            <h2>Do this</h2>
            <ol>{ask.steps.map((step, i) => <li key={i}><Linkify text={step} /></li>)}</ol>
            {!!topLinks.length && <LinkList links={topLinks} className="step-links" />}
          </section>
        )}
        {!detected && (
          <>
            <section className="questions" aria-label="Your answer">
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
            {state === 'error' && <p className="send-error" role="alert">{message}</p>}
          </>
        )}
        {/* Steps point at the links ("link below"), so with steps they stay beside them. */}
        <Details ask={ask} herdrHref={herdrHref} topLinks={ask.steps?.length ? [] : topLinks} />
      </div>
      {!detected && (
        <ActionBar
          isDecision={isDecision}
          hardMissing={hardMissing}
          isBusy={isBusy}
          submit={() => void submit()}
          armed={armed}
          onSendBack={onSendBackClick}
          statusHint={statusHint}
          hasError={state === 'error'}
        />
      )}
    </article>
  )
}
