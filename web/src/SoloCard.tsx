import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, BASE, FinishedError } from './lib/api'
import { clearLocal, readLocal, writeLocal } from './lib/drafts'
import { askKind, ago, groupOf, isMissing, type Ask, type FieldValue, type Values } from './deck'
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

export function SoloCard({ ask, onFinished, onReload }: {
  ask: Ask; onFinished: () => void; onReload: () => Promise<void>
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
    return {
      values,
      notes: { ...(ask.field_context || {}), ...(useLocal ? local.notes : {}) },
      reply: useLocal ? local.reply : ask.draft_reply || '',
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.ticket])
  const [values, setValues] = useState<Values>(() => {
    const chosen = { ...seeded.values }
    if (kind === 'decision' || kind === 'question') for (const field of ask.fields) {
      if (!field.must_decide && field.recommend && isMissing(chosen[field.name])) {
        chosen[field.name] = field.recommend.value
      }
    }
    return chosen
  })
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
  const [primaryVisible, setPrimaryVisible] = useState(true)
  const focalRef = useRef<HTMLElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const [sendBackOpen, setSendBackOpen] = useState(false)
  const [backNote, setBackNote] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [status, setStatus] = useState('')
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
    const localValues = safeValues(merged.values)
    if (approvalKind && typeof merged.values.edited_text === 'string') {
      localValues.edited_text = merged.values.edited_text
    }
    writeLocal(ask.ticket, { values: localValues, notes: merged.notes, reply: merged.reply, bounced })
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
    const localValues = safeValues(merged.values)
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
  const submit = async (verdict?: string) => {
    if (isBusy || detected || answered || (!verdict && hardMissing.length)) return
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
      if (field.name in bounced) continue
      if (kind === 'consent' && field.name === 'note') continue
      if (kind === 'message' && field.name === 'edited_text') continue
      if (isMissing(payload[field.name]) && !field.must_decide) payload[field.name] = null
    }
    setState('sending'); setStatus('Sending…')
    try {
      const result = await api<{ complete: boolean }>('/api/answer', {
        ticket: ask.ticket, revision: ask.revision, values: payload,
        reply: kind === 'consent' ? '' : latest.current.reply,
        field_context: kind === 'consent' ? {} : latest.current.notes,
        field_bounce: approvalKind ? {} : bounced,
      })
      setState('done'); setStatus(result.complete ? 'Sent' : 'Saved, still incomplete')
      if (result.complete) finish()
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
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
      setState('error'); setStatus(error instanceof Error ? error.message : 'Could not send answer')
    }
  }
  const sendBack = async (note = backNote) => {
    if (isBusy) return
    setState('sending'); setStatus('Sending back…')
    try {
      await api('/api/answer', { ticket: ask.ticket, revision: ask.revision, reply: note, bounce: true })
      setState('done'); setStatus('Sent back — the agent will rework it')
      finish()
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
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
      setState('error'); setStatus(error instanceof Error ? error.message : 'Could not send it back')
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
    if (kind === 'permission') void submit('allow_once')
    else if (approvalKind) void submit('approve')
    else if (allRecommended) onRecommend()
    else void submit()
  }
  const primaryLabel = kind === 'key' || kind === 'click'
    ? `${topLink?.label || ''} ↗`
    : kind === 'decision' || kind === 'question' ? 'Accept the recommendations'
      : kind === 'spend' ? `Approve payment ${ask.spend ? money(ask.spend.amount_cents, ask.spend.currency) : ''}`
        : kind === 'permission' ? 'Allow once'
          : kind === 'consent' ? 'Approve: do it for me' : 'Approve and send'
  const onSelf = () => {
    if (ask.plan?.start_url) window.open(ask.plan.start_url, '_blank', 'noopener,noreferrer')
    void submit('self')
  }
  useEffect(() => {
    const target = primaryRef.current || focalRef.current
    if (!approvalKind || !target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setPrimaryVisible(entry.isIntersecting))
    observer.observe(target)
    return () => observer.disconnect()
  }, [approvalKind])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      if (kind === 'permission') void submit('allow_once')
      else if (approvalKind) void submit('approve')
      else void submit()
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
  const actionButtons = (mirror = false) => (
    <>
      {primaryAvailable && (kind === 'key' || kind === 'click' ? (
        <a className="primary" href={topLink!.url} target="_blank" rel="noopener noreferrer">
          <PlainText text={primaryLabel} />
        </a>
      ) : (kind === 'decision' || kind === 'question') && !allRecommended ? null : (
        <button
          ref={mirror ? undefined : primaryRef} type="button" className="primary"
          disabled={primaryDisabled} onClick={onPrimary}
        ><PlainText text={primaryLabel} /></button>
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
        <span
          className={`status-pill${answered ? ' answered' : ask.kind === 'park' ? ' paused' : ''}`}
          title={ask.kind === 'park' ? 'The agent is paused until you answer' : 'The agent keeps working meanwhile'}
        >
          <Icon name={answered ? 'answered' : ask.kind === 'park' ? 'park' : 'waiting'} size={14} />
          {answered ? 'Answered' : ask.kind === 'park' ? 'Agent paused' : 'Waiting on you'}
        </span>
      </div>
      <h1><PlainText text={ask.title} /></h1>
      <div className="ask-meta">
        {groupOf(ask)} · asked by {ask.origin.agent || 'agent'}{' '}
        {herdrHref && (
          <a href={herdrHref} className="pane-link" onClick={(event) => {
            event.preventDefault(); openPane(herdrHref)
          }}>({ask.origin.pane_id})</a>
        )}{' '}· {ago(ask.created_at)} ago
        {!!ask.blocks?.length && <> · unblocks: <PlainText text={ask.blocks.join(', ')} /></>}
      </div>
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
          <div className="focal-actions">
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
      {(kind === 'key' || kind === 'click') && (
        <section className="ask-body">
          {!!ask.steps?.length && (
            <StepList
              ticket={ask.ticket} steps={ask.steps} fields={unanswered} values={values}
              renderField={renderField} checked={checked} setChecked={setChecked}
            />
          )}
          {!ask.steps?.length && unanswered.map(renderField)}
        </section>
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
        <span className="ticket">{ask.ticket}</span>
      </div>
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
      {!answered && !detected && !approvalKind && (
        <div className="card-footer">
          <span className="footer-progress" role="status">
            {state === 'error' ? status : state !== 'idle' ? status : progress || draftState}
          </span>
          <button className="primary" type="button" disabled={isBusy || !!hardMissing.length}
            onClick={() => void submit()}>
            Send
          </button>
        </div>
      )}
      {!answered && !detected && approvalKind && !primaryVisible && (
        <div className="card-footer mirror-footer">
          <span className="footer-progress" role="status">{status}</span>
          <div className="footer-actions">{actionButtons(true)}</div>
        </div>
      )}
    </article>
  )
}
