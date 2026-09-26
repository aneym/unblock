import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, BASE, FinishedError, NetworkError } from './lib/api'
import { clearLocal, readLocal, writeLocal } from './lib/drafts'
import { askKind, ago, groupOf, isMissing, type Ask, type FieldValue, type PasskeyState, type Values } from './deck'
import { FieldControl } from './FieldControl'
import { Icon } from './icons'
import { Chip, ChipText, PlainText } from './ChipText'
import { approveAssertion, enroll, type Assertion } from './lib/passkey'

const afterDefaults: Record<ReturnType<typeof askKind>, string> = {
  key: 'the agent picks it up and keeps going', click: 'the agent picks it up and keeps going',
  decision: 'the agent goes with your picks', question: 'the agent goes with your picks',
  consent: 'the agent runs these steps in your browser and shows you screenshots',
  spend: 'Link asks you to confirm on your phone, then the agent checks out',
  message: 'the agent sends exactly this text, once', permission: 'the agent runs it once',
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
/** Plain words for a failed send; the full sentence goes in the page, not the bar. */
function sendFailure(error: unknown, what: string, button: string): string {
  if (error instanceof NetworkError) {
    return `Not sent: the connection to unblock dropped, even after retrying. ${what} is still here. Tap ${button} to try again.`
  }
  return `Not sent: ${error instanceof Error ? error.message : 'unknown error'}.`
}
/** Plain words for a failed Touch ID ceremony (enroll or approve), before an answer ever reaches the server. */
function passkeyFailure(error: unknown, button: string, approving = false): string {
  if (error instanceof ApiError && error.code === 'PASSKEY_EXISTS') {
    const added = error.added_at && Number.isFinite(error.added_at)
      ? new Date(error.added_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'an unknown time'
    return `A passkey is already set up here (added ${added}). If you didn't add it, don't approve anything and tell your agent.`
  }
  if (error instanceof ApiError && error.code === 'PASSKEY_INVALID') {
    return 'That Touch ID check did not match this version of the ask. Try again.'
  }
  if (error instanceof ApiError && error.code === 'PASSKEY_REQUIRED') {
    return 'Enroll a passkey first.'
  }
  const name = error instanceof Error ? error.name : undefined
  if (name === 'NotAllowedError') {
    return approving
      ? 'Touch ID was cancelled, or this device has no passkey for unblock. Nothing was sent.'
      : 'Touch ID was cancelled. Nothing was sent.'
  }
  if (name === 'AbortError') return 'Touch ID was cancelled. Nothing was sent.'
  return sendFailure(error, 'Your answer', button)
}
function StepList({ ticket, steps, fields, values, renderField, checked, setChecked }: {
  ticket: string; steps: string[]; fields: Ask['fields']; values: Values
  renderField: (field: Ask['fields'][number]) => ReactNode
  checked: number[]; setChecked: (next: number[]) => void
}) {
  const key = `ub_steps_${ticket}`
  const toggle = (index: number) => {
    const next = checked.includes(index) ? checked.filter((item) => item !== index) : [...checked, index]
    setChecked(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* private mode */ }
  }
  const completed = steps.filter((_, index) => {
    const linked = fields.filter((field) => field.step === index + 1)
    return linked.length
      ? linked.filter((field) => field.required).every((field) => !isMissing(values[field.name]))
      : checked.includes(index)
  }).length
  return (
    <section className="steps-body">
      <div className="steps-heading"><h2 className="section-label">Steps</h2>
        <span>{completed} of {steps.length} done</span>
      </div>
      <ol className="checklist">
        {steps.map((step, index) => {
          const linked = fields.filter((field) => field.step === index + 1)
          const done = linked.length
            ? linked.filter((field) => field.required).every((field) => !isMissing(values[field.name]))
            : checked.includes(index)
          return (
            <li key={index} className={done ? 'step-done' : ''}>
              {linked.length ? (
                <span className={`step-check${done ? ' ticked' : ''}`} aria-hidden="true">
                  {done && <Icon name="answered" size={13} />}
                </span>
              ) : (
                <button
                  type="button" className={`step-check${done ? ' ticked' : ''}`}
                  aria-label={`Mark step ${index + 1} ${done ? 'incomplete' : 'complete'}`}
                  aria-pressed={done} onClick={() => toggle(index)}
                >{done && <Icon name="answered" size={13} />}</button>
              )}
              <div className="step-content">
                <ChipText text={step} />
                {linked.map((field) => <div className="step-field" key={field.name}>{renderField(field)}</div>)}
              </div>
            </li>
          )
        })}
      </ol>
      {fields.some((field) => !field.step || field.step > steps.length) && (
        <div className="also-needed">
          <h2 className="section-label">Also needed</h2>
          {fields.filter((field) => !field.step || field.step > steps.length).map((field) => (
            <div key={field.name}>{renderField(field)}</div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Who asked, when, status and links: context, not the question. It sits below
 * the question, folded on a phone and open on a wide screen, so the first
 * screen is always title, why and the question (Alex, phone order, 2026-09-25).
 */
function Details({ ask, answered, herdrHref, topLinks }: {
  ask: Ask
  answered: boolean
  herdrHref: string | undefined
  topLinks: { label: string; url: string }[]
}) {
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 960px)').matches)
  const statusLabel = answered ? 'Answered' : ask.kind === 'park' ? 'Agent paused' : 'Waiting on you'
  const statusIcon = answered ? 'answered' : ask.kind === 'park' ? 'park' : 'waiting'
  const statusNote = ask.kind === 'park' ? 'the agent is paused until you answer' : 'the agent keeps working meanwhile'
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
            <Icon name={statusIcon} size={14} /> {statusLabel} <span className="muted">· {statusNote}</span>
          </span>
        </div>
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
                  onClick={(event) => { event.preventDefault(); openPane(herdrHref) }}
                >
                  {ask.origin.pane_id}
                </a>
              </>
            )}{' '}
            <span className="muted">· {ago(ask.created_at)} ago</span>
          </span>
        </div>
        {!!ask.blocks?.length && (
          <div className="property">
            <span className="property-label">Unblocks</span>
            <span className="property-value"><PlainText text={ask.blocks.join(', ')} /></span>
          </div>
        )}
        {!!topLinks.length && (
          <div className="property">
            <span className="property-label">Links</span>
            <span className="property-value links">
              {topLinks.map((link) => <Chip key={link.url} url={link.url} />)}
            </span>
          </div>
        )}
        {!!ask.tried?.length && (
          <div className="property">
            <span className="property-label">Agent tried</span>
            <ul className="property-value tried-list">
              {ask.tried.map((item, index) => <li key={index}><ChipText text={item} /></li>)}
            </ul>
          </div>
        )}
      </div>
    </details>
  )
}

export function SoloCard({ ask, onFinished, onReload, passkeys }: {
  ask: Ask; onFinished: () => void; onReload: () => Promise<void>; passkeys: PasskeyState
}) {
  const kind = askKind(ask)
  const approvalKind = kind === 'consent' || kind === 'spend' || kind === 'message' || kind === 'permission'
  // The daemon's PASSKEY_VERDICTS (src/store.js): only these three verdicts
  // need a WebAuthn assertion. Spend stays one tap — Link's own push to
  // Alex's phone is spend's outside check.
  const passkeyGated = kind === 'consent' || kind === 'message' || kind === 'permission'
  const gatedVerdict = kind === 'permission' ? 'allow_once' : 'approve'
  const draftNames = useMemo(
    () => new Set(ask.fields.filter((field) => field.type !== 'secret'
      && (!approvalKind || (field.name !== 'verdict' && field.name !== 'edited_text')))
      .map((field) => field.name)),
    [ask.fields, approvalKind],
  )
  const safeValues = (raw: Values): Values =>
    Object.fromEntries(Object.entries(raw).filter(([name]) => draftNames.has(name)))
  const seeded = useMemo(() => {
    const local = readLocal(ask.ticket)
    const useLocal = local && local.t > (ask.draft_updated_at || 0)
    const values: Values = { ...safeValues(ask.draft || {}), ...(useLocal ? safeValues(local.values || {}) : {}) }
    if (approvalKind && typeof local?.values?.edited_text === 'string') {
      values.edited_text = local.values.edited_text
    }
    // The recommendation is the pre-picked answer, so one tap sends it. It
    // stays out of the draft until touched: an agent reading drafts must never
    // mistake the page's default for a choice, and a sent-back field never
    // carries it either.
    const prePicked = new Set<string>()
    if (kind === 'decision' || kind === 'question') {
      for (const field of ask.fields) {
        if (!field.must_decide && field.recommend && isMissing(values[field.name])) {
          values[field.name] = field.recommend.value
          prePicked.add(field.name)
        }
      }
    }
    return {
      values,
      notes: { ...(ask.field_context || {}), ...(useLocal ? local.notes : {}) },
      reply: useLocal ? local.reply : ask.draft_reply || '',
      prePicked,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.ticket])
  const prePicked = useRef(seeded.prePicked)
  const [values, setValues] = useState<Values>(seeded.values)
  const [notes, setNotes] = useState(seeded.notes)
  const [bounced, setBounced] = useState<Record<string, string>>(
    () => approvalKind ? {} : readLocal(ask.ticket)?.bounced || {},
  )
  const [checked, setChecked] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem(`ub_steps_${ask.ticket}`) || '[]') as number[] }
    catch { return [] }
  })
  const [reply, setReply] = useState(seeded.reply)
  const [showPlanNote, setShowPlanNote] = useState(false)
  const [planNote, setPlanNote] = useState('')
  const [editing, setEditing] = useState(!!seeded.values.edited_text)
  const [editDraft, setEditDraft] = useState(
    typeof seeded.values.edited_text === 'string' ? seeded.values.edited_text : ask.message?.text || '',
  )
  const [menu, setMenu] = useState(false)
  const [manual, setManual] = useState(false)
  const focalRef = useRef<HTMLElement>(null)
  const focalActionsRef = useRef<HTMLDivElement>(null)
  const actionBarRef = useRef<HTMLDivElement>(null)
  const [focalActionsInView, setFocalActionsInView] = useState(false)
  const [sendBackOpen, setSendBackOpen] = useState(false)
  const [backNote, setBackNote] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error' | 'passkey'>('idle')
  const [status, setStatus] = useState('')
  const [errorText, setErrorText] = useState('')
  const [draftState, setDraftState] = useState('')
  const [safetyNotice, setSafetyNotice] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const completed = useRef(false)
  const latest = useRef({
    values: Object.fromEntries(ask.fields.map((field) => [field.name, values[field.name]])
      .filter(([, value]) => value !== undefined)) as Values,
    notes: seeded.notes, reply: seeded.reply,
  })
  const latestRevision = useRef(ask.revision)
  useEffect(() => {
    if (latestRevision.current === ask.revision) return
    latestRevision.current = ask.revision
    setSafetyNotice('The agent changed this ask. Check it again.')
    setShowPlanNote(false)
    setPlanNote('')
    setEditing(false)
    setEditDraft(ask.message?.text || '')
    if (approvalKind) {
      setValues({})
      setBounced({})
      latest.current = { values: {}, notes: {}, reply: '' }
      // A revised approval must not reuse values from the prior plan.
      clearLocal(ask.ticket)
    }
  }, [ask.revision, ask.ticket, approvalKind])
  const unanswered = ask.fields.filter((field) => !(field.name in (ask.answers || {})))
  const hardMissing = unanswered.filter(
    (field) => field.must_decide && !(field.name in bounced) && isMissing(values[field.name]),
  )
  const detected = ask.origin.detected === true
  const isBusy = state === 'sending' || state === 'done' || state === 'passkey'
  const answered = ask.status === 'answered'
  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      const button = focalActionsRef.current?.querySelector('button.primary')
      const barHeight = actionBarRef.current?.offsetHeight || 72
      const rect = button?.getBoundingClientRect()
      const visible = !!button && getComputedStyle(button).visibility !== 'hidden'
        && getComputedStyle(button).display !== 'none'
        && !!rect && rect.width > 0 && rect.height > 0
        // Wholly on screen above the bar: a sliver of it cannot be pressed.
        && rect.top >= 0 && rect.bottom <= window.innerHeight - barHeight
      setFocalActionsInView(visible)
    }
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(measure) }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.cancelAnimationFrame(frame)
    }
  })
  const herdrHref = ask.origin.pane_id
    ? `herdr://focus?pane=${encodeURIComponent(ask.origin.pane_id)}`
      + (ask.origin.tab_id ? `&tab=${encodeURIComponent(ask.origin.tab_id)}` : '')
      + (ask.origin.workspace_id ? `&workspace=${encodeURIComponent(ask.origin.workspace_id)}` : '')
    : undefined
  const topLink = ask.links?.[0]
  // A field's own url stays beside that field; the Links row is only the
  // ask's remaining links, and it moves under the steps when there are any
  // ("link below"), otherwise into Details.
  const fieldUrls = new Set(ask.fields.map((field) => field.url).filter(Boolean))
  const topLinks = (ask.links || [])
    .filter((link, index, links) => links.findIndex((item) => item.url === link.url) === index)
    .filter((link) => !fieldUrls.has(link.url))
    .filter((link) => !topLink || link.url !== topLink.url)
  const hasMainSteps = (kind === 'key' || kind === 'click') && !!ask.steps?.length
  const persistable = (raw: Values): Values => {
    const filtered = safeValues(raw)
    for (const name of prePicked.current) delete filtered[name]
    return filtered
  }
  const persist = (next: Partial<typeof latest.current>) => {
    const merged = { ...latest.current, ...next }
    latest.current = merged
    const localValues = persistable(merged.values)
    if (approvalKind && typeof merged.values.edited_text === 'string') {
      localValues.edited_text = merged.values.edited_text
    }
    writeLocal(ask.ticket, { values: localValues, notes: merged.notes, reply: merged.reply, bounced })
    window.clearTimeout(timer.current)
    setDraftState('Saving draft…')
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      void api('/api/draft', {
        ticket: ask.ticket, values: persistable(merged.values),
        field_context: merged.notes, reply: merged.reply,
      }, { retry: false }).then(() => setDraftState('Draft saved')).catch(() => setDraftState('Draft kept in this browser'))
    }, 300)
  }
  useEffect(() => {
    const flush = () => {
      if (timer.current === undefined || completed.current) return
      window.clearTimeout(timer.current)
      timer.current = undefined
      const merged = latest.current
      const body = new Blob([JSON.stringify({
        ticket: ask.ticket, values: persistable(merged.values),
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
    prePicked.current.delete(name)
    const next = { ...latest.current.values, [name]: value }
    setValues(next)
    setState('idle')
    setStatus('')
    if (secret || (approvalKind && name === 'verdict')) {
      latest.current = { ...latest.current, values: next }
    } else persist({ values: next })
  }
  const onReply = (text: string) => {
    setReply(text)
    persist({ reply: text })
  }
  const onNoteChange = (name: string, note: string) => {
    const next = { ...latest.current.notes, [name]: note }
    setNotes(next)
    persist({ notes: next })
  }
  const onSkip = (name: string) => onChange(name, null)
  const onBounce = (name: string, note: string) => {
    const next = { ...bounced, [name]: note }
    setBounced(next)
    const merged = latest.current
    const localValues = persistable(merged.values)
    if (approvalKind && typeof merged.values.edited_text === 'string') {
      localValues.edited_text = merged.values.edited_text
    }
    writeLocal(ask.ticket, { values: localValues, notes: merged.notes, reply: merged.reply, bounced: next })
  }
  const finish = () => {
    completed.current = true
    window.clearTimeout(timer.current)
    timer.current = undefined
    clearLocal(ask.ticket)
    window.setTimeout(onFinished, 1200)
  }
  const submit = async (verdict?: string, assertion?: Assertion) => {
    // Not isBusy: a passkey-gated submit is called while state is already
    // 'passkey' (the ceremony that produced `assertion`), and must proceed.
    if (state === 'sending' || state === 'done' || detected || answered || (!verdict && hardMissing.length)) return
    if (approvalKind && !verdict) return
    if (kind === 'consent' && planNote.trim() && verdict === 'approve') return
    const payload: Values = { ...latest.current.values }
    if (verdict) payload.verdict = verdict
    if (kind === 'consent') delete payload.note
    if (kind === 'message') {
      if (editing) payload.edited_text = editDraft
      else delete payload.edited_text
    }
    for (const field of unanswered) {
      // A sent-back question keeps only what the human typed, never the page's default.
      if (field.name in bounced && prePicked.current.has(field.name)) delete payload[field.name]
      if (field.name in bounced) continue
      if (kind === 'consent' && field.name === 'note') continue
      if (kind === 'message' && field.name === 'edited_text') continue
      if (isMissing(payload[field.name]) && !field.must_decide) payload[field.name] = null
    }
    setState('sending'); setStatus('Sending…'); setErrorText('')
    try {
      const result = await api<{ complete: boolean }>('/api/answer', {
        ticket: ask.ticket, revision: ask.revision, values: payload,
        reply: kind === 'consent' ? '' : latest.current.reply,
        field_context: kind === 'consent' ? {} : latest.current.notes,
        field_bounce: approvalKind ? {} : bounced,
        ...(assertion ? { assertion } : {}),
      })
      setState('done'); setStatus(result.complete ? 'Sent' : 'Saved, still incomplete')
      if (result.complete) finish()
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      if (error instanceof ApiError && error.code === 'ASK_NOT_OPEN') return onFinished()
      if (error instanceof ApiError && error.code === 'STALE_REVISION') {
        setSafetyNotice('The agent changed this ask. Check it again.')
        setState('idle'); setStatus('')
        await onReload()
        return
      }
      if (error instanceof ApiError && error.code === 'HUMAN_ONLY') {
        setSafetyNotice('Approvals only count from your own signed-in page. Open this ask from the tailnet link.')
        setState('idle'); setStatus('')
        return
      }
      setState('error'); setStatus('Not sent')
      setErrorText(passkeyFailure(error, approvalKind ? primaryLabel : 'Send'))
    }
  }
  const sendBack = async (note = backNote) => {
    if (isBusy) return
    setState('sending'); setStatus('Sending back…'); setErrorText('')
    try {
      await api('/api/answer', { ticket: ask.ticket, revision: ask.revision, reply: note, bounce: true })
      setState('done'); setStatus('Sent back — the agent will rework it')
      finish()
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      if (error instanceof ApiError && error.code === 'ASK_NOT_OPEN') return onFinished()
      if (error instanceof ApiError && error.code === 'STALE_REVISION') {
        setSafetyNotice('The agent changed this ask. Check it again.')
        setState('idle'); setStatus('')
        await onReload()
        return
      }
      if (error instanceof ApiError && error.code === 'HUMAN_ONLY') {
        setSafetyNotice('Approvals only count from your own signed-in page. Open this ask from the tailnet link.')
        setState('idle'); setStatus('')
        return
      }
      setState('error'); setStatus('Not sent')
      setErrorText(sendFailure(error, 'Your note', 'Send back'))
    }
  }
  const allRecommended = (kind === 'decision' || kind === 'question')
    && unanswered.some((field) => field.type === 'choice')
    && unanswered.filter((field) => field.type === 'choice').every(
      (field) => !!field.recommend && !field.must_decide,
    )
  const onRecommend = () => {
    const next = { ...latest.current.values }
    for (const field of unanswered) {
      if (!field.must_decide && field.recommend) next[field.name] = field.recommend.value
    }
    setValues(next)
    latest.current = { ...latest.current, values: next }
    void submit()
  }
  /**
   * The Touch ID ceremony for a passkey-gated verdict: enroll first when
   * there is no credential yet, then get an assertion and submit it
   * alongside the verdict. `submit` does its own busy/answered/detected
   * checks, but they gate on `sending`/`done`, not `passkey`, so this can
   * call it once the assertion is in hand.
   */
  const onPasskeyApprove = async () => {
    if (isBusy || detected || answered) return
    setSafetyNotice(''); setErrorText('')
    setState('passkey'); setStatus('Confirm with Touch ID or your passkey…')
    let approving = !!passkeys.count
    try {
      if (!passkeys.count) {
        await enroll()
        void passkeys.refresh()
      }
      approving = true
      const assertion = await approveAssertion(ask.ticket)
      await submit(gatedVerdict, assertion)
    } catch (error) {
      setState('error'); setStatus('Not sent')
      setErrorText(passkeyFailure(error, primaryLabel, approving))
    }
  }
  const onPrimary = () => {
    if (passkeyGated) void onPasskeyApprove()
    else if (approvalKind) void submit('approve')
    else if (allRecommended) onRecommend()
    else void submit()
  }
  const recommended = unanswered.filter((field) => field.recommend && !field.must_decide)
  const singleRecommendation = recommended.length === 1 ? recommended[0] : null
  const choiceLabel = singleRecommendation?.type === 'choice'
    ? singleRecommendation.choices?.find((choice) => choice.value === singleRecommendation.recommend?.value)?.label
    : undefined
  const primaryLabel = kind === 'key' || kind === 'click'
    ? `${topLink?.label || ''} ↗`
    : kind === 'decision' || kind === 'question'
      ? singleRecommendation ? (choiceLabel ? `Go with ${choiceLabel}` : 'Accept the recommendation') : 'Accept the recommendations'
      : kind === 'spend' ? `Approve payment ${ask.spend ? money(ask.spend.amount_cents, ask.spend.currency) : ''}`
        : !passkeyGated ? 'Approve and send' // unreachable: passkeyGated covers every remaining kind
          : !passkeys.available
            ? (kind === 'permission' ? 'Allow once' : kind === 'consent' ? 'Approve: do it for me' : 'Approve and send')
            : !passkeys.count ? 'Enroll a passkey to approve'
              : kind === 'permission' ? 'Allow once with Touch ID' : 'Approve with Touch ID'
  const onSelf = () => {
    if (ask.plan?.start_url) window.open(ask.plan.start_url, '_blank', 'noopener,noreferrer')
    void submit('self')
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      // Only a plain send. An approval (payment, consent, message, command) is
      // never one keystroke away from a note being typed; it takes the button.
      if (passkeyGated || approvalKind) return
      event.preventDefault()
      void submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const renderField = (field: Ask['fields'][number]) => (
    <FieldControl
      key={field.name} field={field} ticket={ask.ticket} value={values[field.name]}
      onChange={onChange} disabled={isBusy} topUrl={topLink?.url}
      note={notes[field.name] || ''} onNoteChange={onNoteChange}
      onSkip={onSkip} onBounce={onBounce}
    />
  )
  const questionCount = unanswered.filter((field) => field.name !== 'note' && field.name !== 'edited_text').length
  const answeredCount = unanswered.filter(
    (field) => field.name !== 'note' && field.name !== 'edited_text'
      && (!isMissing(values[field.name]) || field.name in bounced),
  ).length
  const doneSteps = ask.steps?.filter((_, index) => {
    const linked = unanswered.filter((field) => field.step === index + 1)
    return linked.length
      ? linked.filter((field) => field.required).every((field) => !isMissing(values[field.name]))
      : checked.includes(index)
  }).length || 0
  const progress = (kind === 'key' || kind === 'click') && ask.steps?.length
    ? `${doneSteps} of ${ask.steps.length} done`
    : questionCount > 1
      ? answeredCount === questionCount ? 'Ready to send' : `Question ${answeredCount + 1} of ${questionCount}`
      : ''
  const receipt = ask.receipt
  const receiptAt = receipt?.at && Number.isFinite(receipt.at) ? receipt.at : null
  const sentence = ask.summary || firstSentence(ask.why)
  const after = ask.after || afterDefaults[kind]
  const primaryAvailable = (kind !== 'key' && kind !== 'click') || !!topLink
  const primaryDisabled = isBusy || (kind === 'consent' && !!planNote.trim())
    || (passkeyGated && !passkeys.available)
  const actionButtons = () => (
    <>
      {primaryAvailable && (kind === 'key' || kind === 'click' ? (
        <a className="primary" href={topLink!.url} target="_blank" rel="noopener noreferrer">
          <PlainText text={primaryLabel} />
        </a>
      ) : (kind === 'decision' || kind === 'question') && !allRecommended ? null : (
        <button type="button" className="primary" disabled={primaryDisabled} onClick={onPrimary}>
          <PlainText text={primaryLabel} />
        </button>
      ))}
      {passkeyGated && !passkeys.available && (
        <p className="passkey-hint">Approve on the unblock page; it needs Touch ID.</p>
      )}
      {kind === 'consent' && (
        <>
          <button className="secondary" type="button" onClick={() => setManual(!manual)} disabled={isBusy}>
            Do it yourself instead
          </button>
          <button className="secondary" type="button" disabled={isBusy} onClick={() => void submit('no')}>
            No
          </button>
        </>
      )}
      {kind === 'message' && (
        <button className="secondary" type="button" onClick={() => setEditing(!editing)} disabled={isBusy}>
          Edit
        </button>
      )}
      {(kind === 'spend' || kind === 'message') && (
        <button className="secondary" type="button" disabled={isBusy} onClick={() => void submit('no')}>No</button>
      )}
      {kind === 'permission' && (
        <>
          <button className="secondary" type="button" disabled={isBusy} onClick={() => void submit('deny')}>
            Deny
          </button>
          <button className="text-button" type="button" onClick={() => setSendBackOpen(true)}>
            Deny with a note
          </button>
        </>
      )}
    </>
  )
  return (
    <article className={`ask-article kind-${kind}`}>
      <div className="card-heading">
        <span className="kind-label"><Icon name={kind} size={16} /> {kind}</span>
      </div>
      <h1><PlainText text={ask.title} /></h1>
      <section className="why-section">
        <h2 className="section-label">Why</h2>
        <p><ChipText text={ask.why} /></p>
      </section>
      {hasMainSteps && (
        <section className="ask-body">
          <StepList
            ticket={ask.ticket} steps={ask.steps!} fields={unanswered} values={values}
            renderField={renderField} checked={checked} setChecked={setChecked}
          />
          {/* Steps point at the links ("link below"), so with steps they stay beside them. */}
          {!!topLinks.length && (
            <div className="step-links">
              {topLinks.map((link) => <Chip key={link.url} url={link.url} />)}
            </div>
          )}
        </section>
      )}
      {/* A finished consent leads with what the agent did. */}
      {answered && kind === 'consent' && receipt && (
        <section className="receipt-card">
          <h2><Icon name="answered" size={18} /> Done by the agent ·{' '}
            {receiptAt && <time dateTime={new Date(receiptAt).toISOString()}>
              {new Date(receiptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>}
          </h2>
          {(receipt.before || receipt.after) && <p>Screenshots the agent took</p>}
          <div className="receipt-images">
            {receipt.before && (
              <img src={`${BASE}/api/asks/${encodeURIComponent(ask.ticket)}/receipt/before.png`} alt="Before" />
            )}
            {receipt.after && (
              <img src={`${BASE}/api/asks/${encodeURIComponent(ask.ticket)}/receipt/after.png`} alt="After" />
            )}
          </div>
          {receipt.final_url && <Chip url={receipt.final_url} />}
        </section>
      )}
      <section className="focal-card" ref={focalRef}>
        {kind === 'spend' && ask.spend && (
          <div className="amount">
            {money(ask.spend.amount_cents, ask.spend.currency)}
            <span>{ask.spend.currency.toUpperCase()}</span>
          </div>
        )}
        <p className="focal-sentence">
          {ask.minutes && <span>~{ask.minutes} min · </span>}
          <ChipText text={kind === 'permission' ? ask.permission?.summary || sentence : sentence} />
        </p>
        {kind === 'consent' && ask.plan && (
          <div className="focal-extra consent-hero">
            <Chip url={ask.plan.start_url} />
            <ol className="plan-steps">
              {ask.plan.steps.map((step, index) => <li key={index}><ChipText text={step} /></li>)}
            </ol>
            <p><strong>What changes:</strong> <ChipText text={ask.plan.changes} /></p>
            <p><strong>Won't touch:</strong> <ChipText text={ask.plan.untouched} /></p>
            {!answered && (
              <button className="text-button" type="button" onClick={() => setShowPlanNote(!showPlanNote)}>
                Change something in the plan
              </button>
            )}
            {showPlanNote && !answered && (
              <div className="plan-change">
                <textarea
                  className="control" aria-label="Anything to change in the plan"
                  value={planNote} onChange={(event) => setPlanNote(event.target.value)} disabled={isBusy}
                />
                <button
                  className="secondary" type="button" disabled={isBusy || !planNote.trim()}
                  onClick={() => void sendBack(planNote)}
                >Send back</button>
              </div>
            )}
          </div>
        )}
        {kind === 'spend' && ask.spend && (
          <div className="focal-extra spend-hero">
            <p><ChipText text={ask.spend.item} /> · <Chip url={ask.spend.vendor_url} /> ·{' '}
              cap {money(ask.spend.cap_cents, ask.spend.currency)}</p>
            <p><ChipText text={ask.spend.why} /></p>
          </div>
        )}
        {kind === 'message' && ask.message && (
          <div className="focal-extra message-hero">
            <p>To <ChipText text={ask.message.to} /> via {ask.message.via}</p>
            {ask.message.subject && <p><ChipText text={ask.message.subject} /></p>}
            {editing ? (
              <textarea
                className="control message-edit" aria-label="Your edit" value={editDraft} disabled={isBusy}
                onChange={(event) => { setEditDraft(event.target.value); onChange('edited_text', event.target.value) }}
              />
            ) : <blockquote><ChipText text={ask.message.text} /></blockquote>}
          </div>
        )}
        {kind === 'permission' && ask.permission && (
          <div className="focal-extra permission-hero">
            <span className="neutral-chip">{ask.permission.tool}</span>
            {ask.permission.command && <pre className="permission-command">{ask.permission.command}</pre>}
            {ask.permission.path && <p className="permission-path">{ask.permission.path}</p>}
          </div>
        )}
        {!answered && !detected && (
          <div className="focal-actions" ref={focalActionsRef}>
            {state === 'passkey' && (
              <p className="passkey-pending">
                <Icon name="fingerprint" size={16} /> Confirm with Touch ID or your passkey…
              </p>
            )}
            {actionButtons()}
            {approvalKind && (
              <div className="menu-anchor focal-menu">
                <button
                  type="button" className="field-menu-trigger" aria-expanded={menu}
                  aria-label="More options" onClick={() => setMenu(!menu)
                }>⋯</button>
                {menu && (
                  <div className="menu-popover">
                    <button type="button" onClick={() => { setSendBackOpen(true); setMenu(false) }}>
                      Send back with a note
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <p className="after-line"><Icon name="arrow" size={14} /> Then: <ChipText text={after} /></p>
      </section>
      {kind === 'consent' && manual && (
        <section className="manual-body">
          <h2 className="section-label">Do it yourself instead</h2>
          {ask.links?.map((link, index) => <Chip key={index} url={link.url} />)}
          {ask.steps?.length ? (
            <ol>{ask.steps.map((step, index) => <li key={index}><ChipText text={step} /></li>)}</ol>
          ) : (
            <ol>{ask.plan?.steps.map((step, index) => <li key={index}><ChipText text={step} /></li>)}</ol>
          )}
          <button className="secondary" type="button" onClick={onSelf} disabled={isBusy}>
            I'll do it myself ↗
          </button>
        </section>
      )}
      {(kind === 'key' || kind === 'click') && !hasMainSteps && (
        <section className="ask-body">{unanswered.map(renderField)}</section>
      )}
      {(kind === 'decision' || kind === 'question') && (
        <section className="ask-body decision-fields">{unanswered.map(renderField)}</section>
      )}
      {!answered && !detected && kind !== 'consent' && (
        <div className="reply-box">
          <label htmlFor={`reply_${ask.ticket}`} className="section-label">Anything else</label>
          <input
            id={`reply_${ask.ticket}`} className="control" value={reply}
            onChange={(event) => onReply(event.target.value)} disabled={isBusy}
          />
        </div>
      )}
      {state === 'error' && errorText && <p className="send-error" role="alert">{errorText}</p>}
      {safetyNotice && <p className="safety-notice" role="alert">{safetyNotice}</p>}
      {sendBackOpen && (
        <div className="send-back-box">
          <label htmlFor={`back_${ask.ticket}`} className="section-label">Send back with a note</label>
          <textarea
            id={`back_${ask.ticket}`} className="control" value={backNote}
            placeholder="What should change?" onChange={(event) => setBackNote(event.target.value)}
          />
          <button className="secondary" type="button" onClick={() => void sendBack()} disabled={isBusy}>
            Send back
          </button>
        </div>
      )}
      <Details ask={ask} answered={answered} herdrHref={herdrHref} topLinks={hasMainSteps ? [] : topLinks} />
      {!answered && !detected && (
        <div ref={actionBarRef} className={`action-bar${focalActionsInView ? ' is-hidden' : ''}`} aria-hidden={focalActionsInView}>
          {approvalKind ? (
            <button type="button" className="primary" disabled={primaryDisabled} onClick={onPrimary}>
              <PlainText text={primaryLabel} />
            </button>
          ) : (
            <button
              type="button" className="primary" disabled={isBusy || !!hardMissing.length}
              onClick={() => void submit()}
            >
              Send
            </button>
          )}
          <button
            type="button" className="text-button send-back" disabled={isBusy}
            onClick={() => setSendBackOpen(true)}
          >
            Send back…
          </button>
          <span className={`action-status${state === 'error' ? ' error' : ''}`} role="status">
            {state === 'error' ? 'Not sent' : state !== 'idle' ? status : (progress || draftState)}
          </span>
        </div>
      )}
    </article>
  )
}
