import { useEffect, useMemo, useRef, useState } from 'react'
import { api, BASE, FinishedError } from './lib/api'
import { clearLocal, readLocal, writeLocal } from './lib/drafts'
import { askKind, ago, groupOf, isMissing, type Ask, type FieldValue, type Values } from './deck'
import { FieldControl } from './FieldControl'
import { Icon } from './icons'
import { Chip, ChipText, PlainText } from './ChipText'

const onlyYou: Record<string, string> = {
  credential: 'your sign-in or key', their_account: 'a click in your account',
  spend: 'money', message: 'a message from you', judgment: 'your call',
}
const labels = {
  key: 'Send', click: 'Send', decision: 'Send decision', consent: 'Approve: do it for me',
  spend: 'Approve payment', message: 'Approve and send',
}
function firstSentence(text: string) {
  const sentence = text.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] || text
  return sentence.length > 180 ? `${sentence.slice(0, 179).trimEnd()}…` : sentence
}
function money(cents: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}
function openPane(href: string) {
  const frame = document.createElement('iframe')
  frame.style.display = 'none'
  frame.src = href
  document.body.appendChild(frame)
  window.setTimeout(() => frame.remove(), 2000)
}
function Checklist({ ticket, steps, readOnly = false, filled = false }: {
  ticket: string; steps: string[]; readOnly?: boolean; filled?: boolean
}) {
  const key = `ub_steps_${ticket}`
  const [checked, setChecked] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem(key) || '[]') as number[] } catch { return [] }
  })
  const toggle = (index: number) => {
    const next = checked.includes(index) ? checked.filter((item) => item !== index) : [...checked, index]
    setChecked(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* private mode */ }
  }
  return (
    <ol className={`checklist${readOnly ? ' numbered' : ''}`}>
      {steps.map((step, index) => (
        <li key={index}>
          {readOnly ? (
            <span className={`step-check${filled ? ' ticked' : ''}`} aria-hidden="true">
              {filled ? <Icon name="answered" size={13} /> : index + 1}
            </span>
          ) : (
            <button
              type="button" className={`step-check${checked.includes(index) ? ' ticked' : ''}`}
              aria-label={`Mark step ${index + 1} ${checked.includes(index) ? 'incomplete' : 'complete'}`}
              aria-pressed={checked.includes(index)} onClick={() => toggle(index)}
            >
              {checked.includes(index) && <Icon name="answered" size={13} />}
            </button>
          )}
          <span><ChipText text={step} /></span>
        </li>
      ))}
    </ol>
  )
}

export function SoloCard({ ask, onFinished }: { ask: Ask; onFinished: () => void }) {
  const kind = askKind(ask)
  const draftNames = useMemo(
    () => new Set(ask.fields.filter((field) => field.type !== 'secret').map((field) => field.name)),
    [ask.fields],
  )
  const safeValues = (raw: Values): Values =>
    Object.fromEntries(Object.entries(raw).filter(([name]) => draftNames.has(name)))
  const seeded = useMemo(() => {
    const local = readLocal(ask.ticket)
    const useLocal = local && local.t > (ask.draft_updated_at || 0)
    return {
      values: { ...safeValues(ask.draft || {}), ...(useLocal ? safeValues(local.values || {}) : {}) },
      notes: { ...(ask.field_context || {}), ...(useLocal ? local.notes : {}) },
      reply: useLocal ? local.reply : ask.draft_reply || '',
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.ticket])
  const [values, setValues] = useState<Values>(seeded.values)
  const [notes] = useState(seeded.notes)
  const [reply, setReply] = useState(seeded.reply)
  const [showReply, setShowReply] = useState(!!seeded.reply)
  const [showPlanNote, setShowPlanNote] = useState(!!seeded.values.note)
  const [editing, setEditing] = useState(!!seeded.values.edited_text)
  const [menu, setMenu] = useState(false)
  const [sendBackOpen, setSendBackOpen] = useState(false)
  const [backNote, setBackNote] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [status, setStatus] = useState('')
  const [draftState, setDraftState] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const completed = useRef(false)
  const latest = useRef({ values: seeded.values, notes: seeded.notes, reply: seeded.reply })
  const unanswered = ask.fields.filter((field) => !(field.name in (ask.answers || {})))
  const hardMissing = unanswered.filter(
    (field) => field.must_decide && isMissing(values[field.name]),
  )
  const detected = ask.origin.detected === true
  const isBusy = state === 'sending' || state === 'done'
  const answered = ask.status === 'answered'
  const herdrHref = ask.origin.pane_id
    ? `herdr://focus?pane=${encodeURIComponent(ask.origin.pane_id)}`
      + (ask.origin.tab_id ? `&tab=${encodeURIComponent(ask.origin.tab_id)}` : '')
      + (ask.origin.workspace_id ? `&workspace=${encodeURIComponent(ask.origin.workspace_id)}` : '')
    : undefined
  const topLink = ask.links?.[0]
  const persist = (next: Partial<typeof latest.current>) => {
    const merged = { ...latest.current, ...next }
    latest.current = merged
    writeLocal(ask.ticket, { values: safeValues(merged.values), notes: merged.notes, reply: merged.reply, bounced: {} })
    window.clearTimeout(timer.current)
    setDraftState('Saving draft…')
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      void api('/api/draft', {
        ticket: ask.ticket, values: safeValues(merged.values),
        field_context: merged.notes, reply: merged.reply,
      }).then(() => setDraftState('Draft saved')).catch(() => setDraftState('Draft kept in this browser'))
    }, 300)
  }
  useEffect(() => {
    const flush = () => {
      if (timer.current === undefined || completed.current) return
      window.clearTimeout(timer.current)
      timer.current = undefined
      const merged = latest.current
      const body = new Blob([JSON.stringify({
        ticket: ask.ticket, values: safeValues(merged.values),
        field_context: merged.notes, reply: merged.reply,
      })], { type: 'application/json' })
      try { navigator.sendBeacon(`${BASE}/api/draft`, body) } catch { /* local mirror remains */ }
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
  const onChange = (name: string, value: FieldValue, secret = false) => {
    const next = { ...latest.current.values, [name]: value }
    setValues(next)
    setState('idle')
    setStatus('')
    if (secret) latest.current = { ...latest.current, values: next }
    else persist({ values: next })
  }
  const onReply = (text: string) => {
    setReply(text)
    persist({ reply: text })
  }
  const finish = () => {
    completed.current = true
    window.clearTimeout(timer.current)
    timer.current = undefined
    clearLocal(ask.ticket)
    window.setTimeout(onFinished, 1200)
  }
  const submit = async (verdict?: string, skip = false) => {
    if (isBusy || detected || answered || (!verdict && !skip && hardMissing.length)) return
    const payload: Values = { ...latest.current.values }
    if (verdict) payload.verdict = verdict
    for (const field of unanswered) {
      if (skip && !field.must_decide) payload[field.name] = null
      else if (isMissing(payload[field.name]) && !field.must_decide) payload[field.name] = null
    }
    setState('sending'); setStatus('Sending…')
    try {
      const result = await api<{ complete: boolean }>('/api/answer', {
        ticket: ask.ticket, values: payload, reply: latest.current.reply, field_context: latest.current.notes,
        field_bounce: {},
      })
      setState('done'); setStatus(result.complete ? 'Sent' : 'Saved, still incomplete')
      if (result.complete) finish()
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setStatus(error instanceof Error ? error.message : 'Could not send answer')
    }
  }
  const sendBack = async () => {
    if (isBusy) return
    setState('sending'); setStatus('Sending back…')
    try {
      await api('/api/answer', { ticket: ask.ticket, reply: backNote, bounce: true })
      setState('done'); setStatus('Sent back — the agent will rework it')
      finish()
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setStatus(error instanceof Error ? error.message : 'Could not send it back')
    }
  }
  const skipBlocked = hardMissing.length > 0 || (
    (kind === 'consent' || kind === 'spend' || kind === 'message') && isMissing(values.verdict)
  )
  const onPrimary = () => void submit(
    kind === 'consent' || kind === 'spend' || kind === 'message' ? 'approve' : undefined,
  )
  const onSelf = () => {
    if (ask.plan?.start_url) window.open(ask.plan.start_url, '_blank', 'noopener,noreferrer')
    void submit('self')
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      if (kind === 'consent' || kind === 'spend' || kind === 'message') void submit('approve')
      else void submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const questionCount = unanswered.filter((field) => field.name !== 'note' && field.name !== 'edited_text').length
  const answeredCount = unanswered.filter(
    (field) => field.name !== 'note' && field.name !== 'edited_text' && !isMissing(values[field.name]),
  ).length
  const progress = questionCount > 1
    ? answeredCount === questionCount ? 'Ready to send' : `Question ${answeredCount + 1} of ${questionCount}`
    : ''
  const receipt = ask.receipt
  return (
    <article className="ask-article">
      <div className="ask-card">
        <div className="card-body">
          <div className="card-heading">
            <span className="kind-label"><Icon name={kind} size={18} /> {kind}</span>
            <span
              className={`status-pill${answered ? ' answered' : ''}`}
              title={ask.kind === 'park' ? 'The agent is paused until you answer' : 'The agent keeps working meanwhile'}
            >
              <Icon name={answered ? 'answered' : 'waiting'} size={14} />
              {answered ? 'Answered' : 'Waiting on you'}
            </span>
          </div>
          <h1><PlainText text={ask.title} /></h1>
          <div className="ask-meta">
            {groupOf(ask)} · {onlyYou[ask.only_you || ''] || ask.only_you || 'your call'} · asked by{' '}
            {ask.origin.agent || 'agent'}{' '}
            {herdrHref && (
              <a
                href={herdrHref} className="pane-link"
                onClick={(event) => { event.preventDefault(); openPane(herdrHref) }}
              >
                ({ask.origin.pane_id})
              </a>
            )}{' '}· {ago(ask.created_at)} ago
          </div>
          <p className="why-lead"><ChipText text={firstSentence(ask.why)} /></p>
          {(kind === 'key' || kind === 'click') && (
            <div className="hero-content">
              {topLink && (
                <a className="open-link" href={topLink.url} target="_blank" rel="noopener noreferrer">
                  <PlainText text={topLink.label} /> ↗
                </a>
              )}
              {kind === 'key' && unanswered.filter((field) => field.type === 'secret').map((field) => (
                <FieldControl
                  key={field.name} field={field} ticket={ask.ticket} value={values[field.name]}
                  onChange={onChange} disabled={isBusy} topUrl={topLink?.url}
                />
              ))}
              {!!ask.steps?.length && <Checklist ticket={ask.ticket} steps={ask.steps} />}
              {unanswered.filter((field) => kind !== 'key' || field.type !== 'secret').map((field) => (
                <FieldControl
                  key={field.name} field={field} ticket={ask.ticket} value={values[field.name]}
                  onChange={onChange} disabled={isBusy} topUrl={topLink?.url}
                />
              ))}
            </div>
          )}
          {kind === 'decision' && (
            <div className="hero-content decision-fields">
              {unanswered.map((field) => (
                <FieldControl
                  key={field.name} field={field} ticket={ask.ticket} value={values[field.name]}
                  onChange={onChange} disabled={isBusy} topUrl={topLink?.url}
                />
              ))}
            </div>
          )}
          {kind === 'consent' && ask.plan && (
            <div className="hero-content consent-hero">
              <Chip url={ask.plan.start_url} />
              <Checklist ticket={ask.ticket} steps={ask.plan.steps} readOnly filled={!!receipt} />
              <p><strong>What changes:</strong> <ChipText text={ask.plan.changes} /></p>
              <p><strong>Won't touch:</strong> <ChipText text={ask.plan.untouched} /></p>
              <button className="text-button" type="button" onClick={() => setShowPlanNote(!showPlanNote)}>
                Change something in the plan
              </button>
              {showPlanNote && (
                <textarea
                  className="control" aria-label="Anything to change in the plan"
                  value={typeof values.note === 'string' ? values.note : ''}
                  onChange={(event) => onChange('note', event.target.value)} disabled={isBusy}
                />
              )}
            </div>
          )}
          {kind === 'spend' && ask.spend && (
            <div className="hero-content spend-hero">
              <div className="amount">
                {money(ask.spend.amount_cents, ask.spend.currency)}
                <span>{ask.spend.currency.toUpperCase()}</span>
              </div>
              <p><ChipText text={ask.spend.item} /> · <Chip url={ask.spend.vendor_url} /> ·{' '}
                cap {money(ask.spend.cap_cents, ask.spend.currency)}</p>
              <p><ChipText text={ask.spend.why} /></p>
              <p className="muted">Paid through your Link wallet. Link asks you to confirm on your phone too.</p>
              <button className="text-button" type="button" onClick={() => setShowPlanNote(!showPlanNote)}>
                {showPlanNote ? 'Hide note' : 'Add a payment note'}
              </button>
              {showPlanNote && (
                <textarea
                  className="control" aria-label="Payment note"
                  value={typeof values.note === 'string' ? values.note : ''}
                  onChange={(event) => onChange('note', event.target.value)} disabled={isBusy}
                />
              )}
            </div>
          )}
          {kind === 'message' && ask.message && (
            <div className="hero-content message-hero">
              <p>To <ChipText text={ask.message.to} /> via {ask.message.via}</p>
              {ask.message.subject && <p><ChipText text={ask.message.subject} /></p>}
              {editing ? (
                <textarea
                  className="control message-edit" aria-label="Your edit"
                  value={typeof values.edited_text === 'string' ? values.edited_text : ask.message.text}
                  onChange={(event) => onChange('edited_text', event.target.value)} disabled={isBusy}
                />
              ) : <blockquote><ChipText text={ask.message.text} /></blockquote>}
              <button
                className="text-button" type="button"
                onClick={() => {
                  if (!editing && isMissing(values.edited_text)) onChange('edited_text', ask.message!.text)
                  setEditing(!editing)
                }}
              >
                {editing ? 'Show draft' : 'Edit'}
              </button>
            </div>
          )}
          {showReply && !detected && !answered && (
            <div className="reply-box">
              <label htmlFor={`reply_${ask.ticket}`} className="section-label">Anything else</label>
              <textarea
                id={`reply_${ask.ticket}`} className="control" value={reply}
                onChange={(event) => onReply(event.target.value)} disabled={isBusy}
              />
            </div>
          )}
          {sendBackOpen && (
            <div className="send-back-box">
              <label htmlFor={`back_${ask.ticket}`} className="section-label">Send it back with a note</label>
              <textarea
                id={`back_${ask.ticket}`} className="control" value={backNote}
                placeholder="What should change?" onChange={(event) => setBackNote(event.target.value)}
              />
              <button className="secondary" type="button" onClick={() => void sendBack()} disabled={isBusy}>
                Send back
              </button>
            </div>
          )}
        </div>
        {!detected && !answered && (
          <div className="card-footer">
            <span className="footer-progress" role="status">
              {state === 'error' ? status : state !== 'idle' ? status : progress || draftState}
            </span>
            <div className="footer-actions">
              <button
                type="button" className="primary" onClick={onPrimary}
                disabled={isBusy || (
                  (kind === 'key' || kind === 'click' || kind === 'decision') && !!hardMissing.length
                )}
              >
                {labels[kind]}
              </button>
              {kind === 'consent' && (
                <button className="secondary" type="button" disabled={isBusy} onClick={onSelf}>
                  I'll do it myself ↗
                </button>
              )}
              {(kind === 'consent' || kind === 'spend' || kind === 'message') && (
                <button className="secondary" type="button" disabled={isBusy} onClick={() => void submit('no')}>
                  No
                </button>
              )}
              <div className="menu-anchor">
                <button
                  type="button" className="text-button menu-trigger" aria-expanded={menu}
                  onClick={() => setMenu(!menu)}
                >
                  Can't do this ▾
                </button>
                {menu && (
                  <div className="menu-popover">
                    <button
                      type="button" onClick={() => { setSendBackOpen(true); setMenu(false) }}
                    >
                      Send it back with a note
                    </button>
                    <button
                      type="button" disabled={isBusy || skipBlocked}
                      title={skipBlocked ? 'Choose an answer for every must-decide question first' : undefined}
                      onClick={() => { setMenu(false); void submit(undefined, true) }}
                    >
                      Skip for now
                      {skipBlocked && <small>Choose a must-decide answer first</small>}
                    </button>
                    <button
                      type="button" onClick={() => { setShowReply(true); setMenu(false) }}
                    >
                      Add a note
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="ask-details">
        <details><summary>Why</summary><p><ChipText text={ask.why} /></p></details>
        {!!ask.tried?.length && (
          <details>
            <summary>What the agent tried ({ask.tried.length})</summary>
            <ul>{ask.tried.map((item, index) => <li key={index}><ChipText text={item} /></li>)}</ul>
          </details>
        )}
        {!!ask.links?.slice(1).length && (
          <details>
            <summary>More links</summary>
            <div className="more-links">
              {ask.links.slice(1).map((link, index) => <Chip key={index} url={link.url} />)}
            </div>
          </details>
        )}
        {answered && kind === 'consent' && receipt && (
          <details open>
            <summary>Receipt</summary>
            <div className="receipt-images">
              {receipt.before && (
                <img src={`${BASE}/api/asks/${encodeURIComponent(ask.ticket)}/receipt/before.png`} alt="Before" />
              )}
              {receipt.after && (
                <img src={`${BASE}/api/asks/${encodeURIComponent(ask.ticket)}/receipt/after.png`} alt="After" />
              )}
            </div>
            {receipt.final_url && <Chip url={receipt.final_url} />}
            <time dateTime={new Date(receipt.at).toISOString()}>{new Date(receipt.at).toLocaleString()}</time>
          </details>
        )}
        <span className="ticket">{ask.ticket}</span>
      </div>
    </article>
  )
}
