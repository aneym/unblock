import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, BASE, DraftStaleError, FinishedError, NetworkError } from './lib/api'
import { clearLocal, readLocal, writeLocal } from './lib/drafts'
import { askKind, ago, groupOf, isMissing, reviewLinks, type Ask, type FieldValue, type Link, type Values } from './deck'
import { FieldControl } from './FieldControl'
import { Icon } from './icons'
import { Chip, ChipText, PlainText } from './ChipText'

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

function ReviewSection({ images, pages }: { images: Link[]; pages: Link[] }) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const pageRow = (link: Link) => {
    let address = link.url
    try {
      const url = new URL(link.url)
      address = `${url.host}${url.pathname}`
    } catch { /* Show the original URL if it cannot be parsed. */ }
    return (
      <a key={link.url} className="review-page" href={link.url} target="_blank" rel="noopener noreferrer">
        <strong>{link.label} <span aria-hidden="true">↗</span></strong><span className="review-address">{address}</span>
      </a>
    )
  }
  return (
    <section className="review-section">
      <h2 className="section-label">To review</h2>
      {!!images.length && (
        <div className="review-images">
          {images.filter((link) => !failed.has(link.url)).map((link) => (
            <a key={link.url} className="review-image" href={link.url} title={link.label} target="_blank" rel="noopener noreferrer">
              <img src={link.url} alt={link.label} loading="lazy"
                onError={() => setFailed((previous) => new Set(previous).add(link.url))} />
            </a>
          ))}
        </div>
      )}
      {[...images.filter((link) => failed.has(link.url)), ...pages].map(pageRow)}
    </section>
  )
}

/**
 * Who asked, when, status and links: context, not the question. It sits below
 * the question, folded on a phone and open on a wide screen, so the first
 * screen is always title, why and the question (Alex, phone order, 2026-09-25).
 */
function Details({ ask, answered, herdrHref, topLinks, voiceDetails, onVoiceDetailsApplied }: {
  ask: Ask
  answered: boolean
  herdrHref: string | undefined
  topLinks: { label: string; url: string }[]
  voiceDetails?: { open: boolean; nonce: number }
  onVoiceDetailsApplied: (nonce: number) => boolean
}) {
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 960px)').matches)
  useEffect(() => {
    if (voiceDetails && onVoiceDetailsApplied(voiceDetails.nonce)) setOpen(voiceDetails.open)
  }, [voiceDetails?.nonce, onVoiceDetailsApplied])
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
            <span className="property-value"><PlainText text={ask.blocks} /></span>
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

export interface SendRecovery {
  revision: number
  values: Values
  notes: Record<string, string>
  reply: string
  bounced: Record<string, string>
  backNote: string
  planNote: string
  editing: boolean
}

export function SoloCard({ ask, onFinished, onReload, queueSend, recovery, voiceDetails, voiceFill, onVoiceDetailsApplied, onVoiceFillApplied, voiceCallActive }: {
  ask: Ask; onFinished: () => void; onReload: () => Promise<void>
  queueSend?: (ticket: string, body: unknown, recovery: SendRecovery) => boolean
  recovery?: SendRecovery
  voiceDetails?: { open: boolean; nonce: number }
  voiceFill?: { values: Record<string, unknown>; field_context: Record<string, string>; nonce: number }
  onVoiceDetailsApplied: (nonce: number) => boolean
  onVoiceFillApplied: (nonce: number) => boolean
  voiceCallActive: boolean
}) {
  const kind = askKind(ask)
  const approvalKind = kind === 'consent' || kind === 'spend' || kind === 'message' || kind === 'permission'
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
    if (recovery?.revision === ask.revision) Object.assign(values, recovery.values)
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
      notes: recovery?.revision === ask.revision ? recovery.notes : { ...(ask.field_context || {}), ...(useLocal ? local.notes : {}) },
      reply: recovery?.revision === ask.revision ? recovery.reply : useLocal ? local.reply : ask.draft_reply || '',
      prePicked,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.ticket])
  const prePicked = useRef(seeded.prePicked)
  const [values, setValues] = useState<Values>(seeded.values)
  const [notes, setNotes] = useState(seeded.notes)
  const [voiceFilled, setVoiceFilled] = useState(false)
  const [bounced, setBounced] = useState<Record<string, string>>(
    () => recovery?.revision === ask.revision ? recovery.bounced : approvalKind ? {} : readLocal(ask.ticket)?.bounced || {},
  )
  const [checked, setChecked] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem(`ub_steps_${ask.ticket}`) || '[]') as number[] }
    catch { return [] }
  })
  const [reply, setReply] = useState(seeded.reply)
  const [showPlanNote, setShowPlanNote] = useState(!!recovery?.planNote)
  const [planNote, setPlanNote] = useState(recovery?.planNote || '')
  const [editing, setEditing] = useState(recovery?.editing ?? !!seeded.values.edited_text)
  const [editDraft, setEditDraft] = useState(
    typeof seeded.values.edited_text === 'string' ? seeded.values.edited_text : ask.message?.text || '',
  )
  const [menu, setMenu] = useState(false)
  const [manual, setManual] = useState(false)
  const focalRef = useRef<HTMLElement>(null)
  const focalActionsRef = useRef<HTMLDivElement>(null)
  const actionBarRef = useRef<HTMLDivElement>(null)
  const [focalActionsInView, setFocalActionsInView] = useState(false)
  const [sendBackOpen, setSendBackOpen] = useState(!!recovery?.backNote)
  const [backNote, setBackNote] = useState(recovery?.backNote || '')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [status, setStatus] = useState('')
  const [errorText, setErrorText] = useState('')
  const [draftState, setDraftState] = useState('')
  const [safetyNotice, setSafetyNotice] = useState('')
  const timer = useRef<number | undefined>(undefined)
  const draftInFlight = useRef(false)
  const draftPending = useRef(false)
  const baseRev = useRef((ask as Ask & { draft_rev?: number }).draft_rev ?? 0)
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
  const isBusy = state === 'sending' || state === 'done'
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
  const hasMainSteps = (kind === 'key' || kind === 'click') && !!ask.steps?.length
  // Key/click keeps its first link as the primary button; other kinds show
  // every review link before the question, except links beside their fields.
  const { images, pages } = reviewLinks(ask)
  const topLinks = kind === 'key' || kind === 'click'
    ? (ask.links || [])
      .filter((link, index, links) => links.findIndex((item) => item.url === link.url) === index)
      .filter((link) => !ask.fields.some((field) => field.url === link.url))
      .filter((link) => link.url !== topLink?.url)
    : []
  const persistable = (raw: Values): Values => {
    const filtered = safeValues(raw)
    for (const name of prePicked.current) delete filtered[name]
    return filtered
  }
  // One draft request at a time, stamped with the revision it builds on. If
  // another request got there first the daemon answers DRAFT_STALE, and this
  // resends the newest values once on top of that revision.
  const sendDraft = () => {
    if (completed.current) return
    if (draftInFlight.current) {
      draftPending.current = true
      return
    }
    draftInFlight.current = true
    const save = () => {
      const current = latest.current
      return api<{ ask: Ask }>('/api/draft', {
        ticket: ask.ticket, base_rev: baseRev.current, values: persistable(current.values),
        field_context: current.notes, reply: current.reply,
      }, { retry: false })
    }
    const attempt = async () => {
      try {
        let result: { ask: Ask }
        try {
          result = await save()
        } catch (error) {
          if (!(error instanceof DraftStaleError)) throw error
          baseRev.current = error.draftRev
          result = await save()
        }
        baseRev.current = (result.ask as Ask & { draft_rev: number }).draft_rev
        setDraftState('Draft saved')
      } catch (error) {
        if (error instanceof FinishedError) {
          completed.current = true
          window.clearTimeout(timer.current)
          timer.current = undefined
          draftPending.current = false
          onFinished()
        } else setDraftState('Draft kept in this browser')
      } finally {
        draftInFlight.current = false
        if (draftPending.current && !completed.current) {
          draftPending.current = false
          sendDraft()
        }
      }
    }
    void attempt()
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
      sendDraft()
    }, 300)
  }
  useEffect(() => {
    const flush = () => {
      if (timer.current === undefined || completed.current) return
      window.clearTimeout(timer.current)
      timer.current = undefined
      const merged = latest.current
      const body = new Blob([JSON.stringify({
        ticket: ask.ticket, base_rev: baseRev.current + (draftInFlight.current ? 1 : 0),
        values: persistable(merged.values), field_context: merged.notes, reply: merged.reply,
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
  useEffect(() => {
    if (!voiceFill || !onVoiceFillApplied(voiceFill.nonce)) return
    const next = { ...latest.current.values }
    for (const [name, value] of Object.entries(voiceFill.values)) {
      if (value === null || !ask.fields.some((field) => field.name === name && field.type !== 'secret')) continue
      if (typeof value === 'string' || typeof value === 'boolean'
        || (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
        next[name] = value as FieldValue
        prePicked.current.delete(name)
      }
    }
    const nextNotes = { ...latest.current.notes, ...voiceFill.field_context }
    setValues(next)
    setNotes(nextNotes)
    setVoiceFilled(true)
    persist({ values: next, notes: nextNotes })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceFill?.nonce])
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
  const finish = (optimistic = false) => {
    completed.current = true
    window.clearTimeout(timer.current)
    timer.current = undefined
    if (!optimistic) clearLocal(ask.ticket)
    if (optimistic) onFinished()
    else window.setTimeout(onFinished, 1200)
  }
  const sendOptimistically = (body: unknown) => {
    if (!queueSend || BASE) return false
    const current = latest.current
    if (!queueSend(ask.ticket, body, {
      revision: ask.revision, values: { ...current.values }, notes: { ...current.notes },
      reply: current.reply, bounced: { ...bounced }, backNote, planNote, editing,
    })) return true
    setState('done')
    finish(true)
    return true
  }
  const submit = async (verdict?: string) => {
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
    const body = {
      ticket: ask.ticket, revision: ask.revision, values: payload,
      reply: kind === 'consent' ? '' : latest.current.reply,
      field_context: kind === 'consent' ? {} : latest.current.notes,
      field_bounce: approvalKind ? {} : bounced,
    }
    if (sendOptimistically(body)) return
    setState('sending'); setStatus('Sending…'); setErrorText('')
    try {
      const result = await api<{ complete: boolean }>('/api/answer', body)
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
      setErrorText(sendFailure(error, 'Your answer', approvalKind ? primaryLabel : 'Send'))
    }
  }
  const sendBack = async (note = backNote) => {
    if (isBusy) return
    const body = { ticket: ask.ticket, revision: ask.revision, reply: note, bounce: true }
    if (sendOptimistically(body)) return
    setState('sending'); setStatus('Sending back…'); setErrorText('')
    try {
      await api('/api/answer', body)
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
  const onPrimary = () => {
    if (approvalKind) void submit(kind === 'permission' ? 'allow_once' : 'approve')
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
        : kind === 'permission' ? 'Allow once' : kind === 'consent' ? 'Approve: do it for me' : 'Approve and send'
  const onSelf = () => {
    if (ask.plan?.start_url) window.open(ask.plan.start_url, '_blank', 'noopener,noreferrer')
    void submit('self')
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      // Only a plain send. An approval (payment, consent, message, command) is
      // never one keystroke away from a note being typed; it takes the button.
      if (approvalKind) return
      event.preventDefault()
      void submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const renderField = (field: Ask['fields'][number]) => (
    <FieldControl
      key={field.name} field={field} ticket={ask.ticket} value={values[field.name]}
      onChange={onChange} disabled={isBusy} topUrl={kind === 'key' || kind === 'click' ? topLink?.url : undefined}
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
      {kind !== 'key' && kind !== 'click' && (images.length > 0 || pages.length > 0) && (
        <ReviewSection key={ask.ticket} images={images} pages={pages} />
      )}
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
      <Details ask={ask} answered={answered} herdrHref={herdrHref} topLinks={hasMainSteps ? [] : topLinks}
        voiceDetails={voiceDetails} onVoiceDetailsApplied={onVoiceDetailsApplied} />
      {voiceFilled && voiceCallActive && !answered && !detected && <p className="voice-fill-hint">Heard by voice. Say yes to send, or tap Send.</p>}
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
