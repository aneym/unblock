import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { cn } from './lib/utils'
import { api, FinishedError } from './lib/api'
import { clearLocal, readLocal, writeLocal } from './lib/drafts'
import { SuccessOverlay } from './SoloCard'
import { ago, isMissing, unansweredFields, type Ask, type DeckItem, type Field, type FieldValue, type Values } from './deck'

/**
 * A shared card for short asks: nothing in it but taps. Choices render as
 * pills, confirms as a single checkbox row. Each ask keeps its own exits —
 * answer, skip by leaving it blank, or send the whole ask back — and one
 * button submits the lot.
 */

interface RowState {
  values: Values
  reply: string
  /** set (possibly '') when the whole ask is being sent back */
  bounce?: string
  noteOpen?: boolean
}

function seedRow(ask: Ask): RowState {
  const base: RowState = { values: { ...(ask.draft || {}) }, reply: ask.draft_reply || '' }
  const local = readLocal(ask.ticket)
  if (local && local.t > (ask.draft_updated_at || 0)) {
    return { values: { ...base.values, ...(local.values || {}) }, reply: local.reply || base.reply }
  }
  return base
}

function ChoicePills({ field, value, disabled, onChange }: { field: Field; value: FieldValue | undefined; disabled: boolean; onChange: (value: FieldValue) => void }) {
  const declared = useMemo(() => new Set((field.choices || []).map((choice) => choice.value)), [field.choices])
  const selected = field.multi ? (Array.isArray(value) ? value : []) : undefined
  const isOther = !field.multi && typeof value === 'string' && value !== '' && !declared.has(value)
  const otherSelected = field.multi ? selected!.find((item) => !declared.has(item)) : isOther ? (value as string) : undefined
  const [otherOpen, setOtherOpen] = useState(otherSelected !== undefined)
  const recommended = (choiceValue: string) => {
    if (!field.recommend || field.must_decide) return false
    const target = field.recommend.value
    return Array.isArray(target) ? target.includes(choiceValue) : target === choiceValue
  }
  const pick = (choiceValue: string) => {
    if (field.multi) {
      const kept = selected!.includes(choiceValue) ? selected!.filter((item) => item !== choiceValue) : [...selected!, choiceValue]
      onChange(kept)
    } else {
      onChange(value === choiceValue ? '' : choiceValue)
    }
  }
  const active = (choiceValue: string) => (field.multi ? selected!.includes(choiceValue) : value === choiceValue)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(field.choices || []).map((choice) => (
        <motion.button
          key={choice.value}
          type="button"
          whileTap={{ scale: 0.96 }}
          disabled={disabled}
          onClick={() => pick(choice.value)}
          className={cn(
            'rounded-full border border-[var(--input-border)] bg-[var(--surface)] px-3.5 py-1.5 text-[14px] leading-5 transition-colors duration-150',
            active(choice.value) ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--bg)]' : 'hover:border-[var(--ink)]',
          )}
        >
          {choice.label}
          {recommended(choice.value) && <span className={cn('ml-1.5 align-middle text-[10px]', active(choice.value) ? 'text-[var(--bg)]' : 'text-[var(--accent)]')}>●</span>}
        </motion.button>
      ))}
      {!otherOpen && (
        <button type="button" disabled={disabled} className="rounded-full border border-dashed border-[var(--input-border)] px-3.5 py-1.5 text-[14px] leading-5 text-[var(--dim)] hover:border-[var(--ink)] hover:text-[var(--ink)]" onClick={() => setOtherOpen(true)}>
          Other…
        </button>
      )}
      {otherOpen && (
        <Input
          autoFocus
          value={otherSelected ?? ''}
          placeholder="your own answer"
          disabled={disabled}
          className="h-9 w-44 rounded-full px-3.5 text-[14px]"
          onChange={(event) => {
            const text = event.target.value
            if (field.multi) {
              const kept = selected!.filter((item) => declared.has(item))
              onChange(text.trim() ? [...kept, text] : kept)
            } else {
              onChange(text)
            }
          }}
        />
      )}
    </div>
  )
}

interface GroupCardProps {
  item: DeckItem
  deferrable: boolean
  onFinished: () => void
  onDefer: () => void
}

export function GroupCard({ item, deferrable, onFinished, onDefer }: GroupCardProps) {
  const seeded = useMemo(() => {
    const rows: Record<string, RowState> = {}
    for (const ask of item.asks) rows[ask.ticket] = seedRow(ask)
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key, item.asks.map((ask) => ask.ticket).join(',')])
  const [rows, setRows] = useState<Record<string, RowState>>(seeded)
  // Membership can change between polls (a new short ask joins the group).
  // Merge the new seeds in, but never clobber a row already being edited.
  useEffect(() => {
    setRows((current) => {
      const next: Record<string, RowState> = {}
      for (const [ticket, seed] of Object.entries(seeded)) next[ticket] = current[ticket] ?? seed
      return next
    })
  }, [seeded])
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const timers = useRef<Record<string, number>>({})
  useEffect(() => {
    const held = timers.current
    return () => Object.values(held).forEach((timer) => window.clearTimeout(timer))
  }, [])

  const isBusy = state === 'sending' || state === 'done'

  const update = (ticket: string, patch: Partial<RowState>) => {
    setState('idle')
    setMessage('')
    setRows((current) => {
      const row = { ...current[ticket], ...patch }
      const next = { ...current, [ticket]: row }
      writeLocal(ticket, { values: row.values, notes: {}, reply: row.reply, bounced: {} })
      window.clearTimeout(timers.current[ticket])
      timers.current[ticket] = window.setTimeout(() => {
        api('/api/draft', { ticket, values: row.values, reply: row.reply }).catch(() => { /* the local mirror already has it */ })
      }, 600)
      return next
    })
  }

  const hardMissing = item.asks.flatMap((ask) => {
    const row = rows[ask.ticket]
    if (!row || row.bounce !== undefined) return []
    return unansweredFields(ask)
      .filter((field) => field.must_decide && isMissing(row.values[field.name]))
      .map((field) => field.label)
  })

  const summary = () => {
    let answered = 0
    let skipped = 0
    let sentBack = 0
    for (const ask of item.asks) {
      const row = rows[ask.ticket]
      if (row?.bounce !== undefined) { sentBack += 1; continue }
      const open = unansweredFields(ask)
      if (open.some((field) => !isMissing(row?.values[field.name]))) answered += 1
      else skipped += 1
    }
    return [
      answered ? `${answered} answered` : '',
      skipped ? `${skipped} untouched ${skipped === 1 ? 'goes' : 'go'} back as skipped` : '',
      sentBack ? `${sentBack} sent back for rework` : '',
    ].filter(Boolean).join(' · ')
  }

  const submit = async () => {
    setState('sending'); setMessage('sending…')
    try {
      await Promise.all(item.asks.map((ask) => {
        const row = rows[ask.ticket]
        if (row?.bounce !== undefined) {
          return api('/api/answer', { ticket: ask.ticket, bounce: true, reply: row.bounce || row.reply || undefined })
        }
        const payload: Values = {}
        for (const field of unansweredFields(ask)) {
          const value = row?.values[field.name]
          if (!isMissing(value)) payload[field.name] = value as FieldValue
          else if (field.required && !field.must_decide) payload[field.name] = null
        }
        return api('/api/answer', { ticket: ask.ticket, values: payload, reply: row?.reply || undefined })
      }))
      setState('done')
      setMessage('sent')
      for (const ask of item.asks) clearLocal(ask.ticket)
      window.setTimeout(onFinished, 950)
    } catch (error) {
      if (error instanceof FinishedError) return onFinished()
      setState('error'); setMessage(error instanceof Error ? error.message : 'Could not send answers')
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (isBusy || hardMissing.length > 0) return
    event.preventDefault()
    void submit()
  }

  return (
    <article onKeyDown={onKeyDown} className="relative rounded-[var(--radius-lg)] border border-[var(--rule)] bg-[var(--surface)] px-4 py-7 shadow-[0_1px_0_rgba(255,255,255,.6)_inset,0_18px_40px_-24px_rgba(60,45,20,.35)] sm:px-7 sm:py-8">
      <AnimatePresence>{state === 'done' && <SuccessOverlay label={message} />}</AnimatePresence>
      <div className="flex items-baseline gap-2 font-mono text-[12px] leading-5 text-[var(--faint)]">
        <span className="text-[var(--dim)]">{item.project}</span>
        <span aria-hidden>·</span>
        <span>{item.asks.length === 1 ? 'a quick one' : `${item.asks.length} quick ones`}</span>
      </div>
      <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }}>
        {item.asks.map((ask) => {
          const row = rows[ask.ticket] || { values: {}, reply: '' }
          const isBounced = row.bounce !== undefined
          return (
            <motion.section
              key={ask.ticket}
              variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
              className={cn('border-b border-[var(--rule)] py-5 last:border-b-0 last:pb-2', isBounced && 'opacity-90')}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="font-display min-w-0 text-[17.5px] font-semibold leading-snug tracking-[-.005em]">{ask.title}</h3>
                <span className="font-mono text-[11.5px] text-[var(--faint)]">{ask.origin.agent || 'agent'} · {ago(ask.created_at)}</span>
              </div>
              <p className="mt-1 text-pretty text-[14px] leading-relaxed text-[var(--dim)]">{ask.why}</p>
              {isBounced ? (
                <div className="mt-3 rounded-[var(--radius)] border border-dashed border-[var(--danger)] px-3.5 py-3">
                  <p className="text-[13.5px] leading-5 text-[var(--danger)]">Going back to the agent unanswered — it will rework this ask.</p>
                  <Textarea value={row.bounce} placeholder="What's wrong with it? (optional)" spellCheck={false} disabled={isBusy} className="mt-2 min-h-12" onChange={(event) => update(ask.ticket, { bounce: event.target.value })} />
                  <button type="button" className="mt-2 block text-[12.5px] leading-5 text-[var(--faint)] hover:text-[var(--accent)]" disabled={isBusy} onClick={() => update(ask.ticket, { bounce: undefined })}>Keep it</button>
                </div>
              ) : (
                <div className="mt-3 grid gap-3">
                  {unansweredFields(ask).map((field) => (
                    <div key={field.name}>
                      {(unansweredFields(ask).length > 1 || field.label !== ask.title) && (
                        <p className="mb-1.5 text-[13px] font-semibold leading-5 text-[var(--ink)]">
                          {field.label}
                          {!field.required && <span className="font-normal text-[var(--faint)]"> · optional</span>}
                        </p>
                      )}
                      {field.type === 'confirm' ? (
                        <label className="flex cursor-pointer items-start gap-3 text-[14.5px]">
                          <Checkbox checked={row.values[field.name] === true} disabled={isBusy} onCheckedChange={(next) => update(ask.ticket, { values: { ...row.values, [field.name]: next === true } })} />
                          <span>{field.help || 'Done'}</span>
                        </label>
                      ) : (
                        <ChoicePills field={field} value={row.values[field.name]} disabled={isBusy} onChange={(value) => update(ask.ticket, { values: { ...row.values, [field.name]: value } })} />
                      )}
                      {field.recommend && !field.must_decide && <p className="mt-1.5 text-[12.5px] leading-5 text-[var(--dim)]"><span className="font-medium text-[var(--ink)]">Recommended</span> · {field.recommend.why}</p>}
                      {field.must_decide && <p className="mt-1.5 text-[12.5px] leading-5 text-[var(--dim)]">This one needs your decision.</p>}
                      {field.help && field.type !== 'confirm' && <p className="mt-1.5 text-[12.5px] leading-5 text-[var(--dim)]">{field.help}</p>}
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-x-4">
                    {!row.noteOpen && <button type="button" className="text-[12px] leading-5 text-[var(--faint)] hover:text-[var(--accent)]" disabled={isBusy} onClick={() => update(ask.ticket, { noteOpen: true })}>Add context</button>}
                    <button type="button" className="text-[12px] leading-5 text-[var(--faint)] hover:text-[var(--danger)]" disabled={isBusy} onClick={() => update(ask.ticket, { bounce: '' })}>Send back</button>
                  </div>
                  {row.noteOpen && <Textarea value={row.reply} placeholder="Context for this answer" spellCheck={false} disabled={isBusy} className="min-h-12" onChange={(event) => update(ask.ticket, { reply: event.target.value })} />}
                </div>
              )}
            </motion.section>
          )
        })}
      </motion.div>
      <div className="sticky bottom-0 -mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-b-[var(--radius-lg)] border-t border-[var(--rule)] bg-[var(--surface)] px-4 py-4 sm:-mx-7 sm:px-7">
        <Button disabled={hardMissing.length > 0 || isBusy} onClick={() => void submit()}>{item.asks.length === 1 ? 'Answer & next' : 'Answer all & next'}</Button>
        {deferrable && <button type="button" className="text-[13.5px] font-medium text-[var(--faint)] hover:text-[var(--ink)]" disabled={isBusy} title="Skip for now — this card comes back at the end of the deck" onClick={onDefer}>Skip</button>}
        <span className={cn('min-w-0 text-[13px] leading-5 text-[var(--faint)]', state === 'error' && 'text-[var(--danger)]', state === 'done' && 'text-[var(--ok)]')}>
          {message || (hardMissing.length ? `still needs: ${hardMissing.join(', ')}` : summary())}
        </span>
      </div>
    </article>
  )
}
