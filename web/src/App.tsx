import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, FinishedError, VIEWER } from './lib/api'
import { ago, groupOf, isMissing, sortAsks, type Ask, type Bounced, type QueueData, type Values } from './deck'
import { readLocal } from './lib/drafts'
import { SoloCard } from './SoloCard'
import { cn } from './lib/utils'

function readPinned(): string | null {
  const match = window.location.hash.match(/#ask=([^&]+)/)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}

function remainingFields(ask: Ask, live?: { values: Values; bounced: Bounced }) {
  const local = readLocal(ask.ticket)
  const draft = local && local.t > (ask.draft_updated_at || 0) ? local : null
  const values = live?.values || { ...(ask.draft || {}), ...(draft?.values || {}) }
  const bounced = live?.bounced || draft?.bounced || {}
  return ask.fields.filter((field) => field.required && !(field.name in (ask.answers || {})) && !(field.name in bounced) && isMissing(values[field.name])).length
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="rounded-[var(--radius-lg)] border border-[var(--rule)] bg-[var(--surface)] px-6 py-16 text-center">
    <h2 className="font-display text-[25px] font-semibold">{title}</h2>
    <p className="mt-2 text-[15px] text-[var(--dim)]">{detail}</p>
  </div>
}

export default function App() {
  const [data, setData] = useState<QueueData | null>(null)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)
  const [selectedTicket, setSelectedTicket] = useState<string | null>(() => readPinned())
  const [doneTickets, setDoneTickets] = useState<ReadonlySet<string>>(new Set())
  const [liveDrafts, setLiveDrafts] = useState<Record<string, { values: Values; bounced: Bounced }>>({})

  const load = useCallback(async () => {
    try { setData(await api<QueueData>('/api/queue')); setError('') }
    catch (cause) {
      if (cause instanceof FinishedError) setFinished(true)
      else setError(cause instanceof Error ? cause.message : 'Unknown error')
    }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return
      void load()
    }, 6000)
    return () => window.clearInterval(timer)
  }, [load])
  useEffect(() => {
    const onHashChange = () => setSelectedTicket(readPinned())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const asks = useMemo(() => sortAsks((data?.asks || []).filter((ask) => ask.status === 'open' && !doneTickets.has(ask.ticket))), [data, doneTickets])
  const selected = asks.find((ask) => ask.ticket === selectedTicket) || asks[0]
  const selectedIndex = selected ? asks.findIndex((ask) => ask.ticket === selected.ticket) : -1
  const choose = (ticket: string) => {
    setSelectedTicket(ticket)
    if (window.location.hash.startsWith('#ask=')) history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  const finish = (ticket: string) => {
    const index = asks.findIndex((ask) => ask.ticket === ticket)
    const next = asks[index + 1] || asks[index - 1]
    setDoneTickets((previous) => new Set([...previous, ticket]))
    setSelectedTicket((current) => current === ticket ? next?.ticket || null : current)
    if (window.location.hash.startsWith('#ask=')) history.replaceState(null, '', window.location.pathname + window.location.search)
    void load()
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
      if (event.target instanceof HTMLElement && (event.target.closest('input, textarea, select, button, a, [contenteditable="true"]') || event.target.isContentEditable)) return
      const direction = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
      if (!direction || asks.length === 0) return
      event.preventDefault()
      const index = selectedIndex < 0 ? 0 : (selectedIndex + direction + asks.length) % asks.length
      choose(asks[index].ticket)
      document.getElementById(`ask-tab-${encodeURIComponent(asks[index].ticket)}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [asks, selectedIndex])

  if (finished) return <div className="mx-auto max-w-[720px] px-4 pt-16"><Empty title="This link is finished" detail="Ask for a fresh one, or answer in the herdr pane." /></div>

  return <div className="mx-auto max-w-[1180px] px-4 pb-24 pt-5 sm:px-6 sm:pt-8">
    <header className="mb-6 border-b border-[var(--rule)] pb-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-[var(--faint)]">
        <span className="text-[14px] font-semibold text-[var(--ink)]">unblock</span>
        {data?.profile && data.profile !== '*' && <span>profile {data.profile}</span>}
        {!!data?.hidden && <span>{data.hidden} more in other profiles</span>}
        {VIEWER && <span className="ml-auto" title={VIEWER.login}>{VIEWER.name || VIEWER.login}</span>}
      </div>
      <div className="mt-4 flex items-baseline justify-between gap-4">
        <h1 className="font-display text-[28px] font-semibold leading-tight">Open asks</h1>
        <span className="font-mono text-[13px] text-[var(--dim)]">{asks.length} open</span>
      </div>
    </header>
    {error ? <Empty title="Cannot reach the daemon" detail={error} /> : !data ? <div className="py-20 text-center text-[var(--dim)]">Loading the queue…</div> : asks.length === 0 ? <Empty title="Nothing needs you" detail="No agent is waiting on an action or a decision." /> : <main className="grid items-start gap-5 md:grid-cols-[minmax(250px,330px)_minmax(0,1fr)]">
      <nav aria-label="Open asks" className="min-w-0">
        <p className="mb-2 hidden text-[12px] text-[var(--faint)] md:block">Select any ask · j/k to move</p>
        <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 md:mx-0 md:block md:space-y-2 md:overflow-visible md:p-0">
          {asks.map((ask) => {
            const active = ask.ticket === selected?.ticket
            const left = remainingFields(ask, liveDrafts[ask.ticket])
            const local = readLocal(ask.ticket)
            const hasDraft = !!(ask.draft_updated_at || local || liveDrafts[ask.ticket])
            return <button key={ask.ticket} id={`ask-tab-${encodeURIComponent(ask.ticket)}`} type="button" aria-current={active ? 'true' : undefined} onClick={() => choose(ask.ticket)} className={cn('min-w-[240px] max-w-[290px] shrink-0 snap-start rounded-[var(--radius)] border bg-[var(--surface)] px-4 py-3 text-left shadow-[0_1px_2px_rgba(60,45,20,.04)] transition-colors hover:border-[var(--accent)] md:w-full md:max-w-none md:min-w-0', active ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--rule)]')}>
              <span className="block truncate font-display text-[17px] font-semibold leading-snug">{ask.title}</span>
              <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--dim)]"><span className="min-w-0 truncate">{groupOf(ask)}</span><span aria-hidden>·</span><span className="shrink-0">{ago(ask.created_at)}</span></span>
              <span className="mt-2 flex items-center gap-2 font-mono text-[11px] text-[var(--dim)]"><span>{left} required {left === 1 ? 'field' : 'fields'} left</span>{hasDraft && <span title="Draft saved" aria-label="Draft saved" className="size-1.5 rounded-full bg-[var(--accent)]" />}</span>
            </button>
          })}
        </div>
      </nav>
      <section aria-label="Selected ask" className="min-w-0">
        {selected && <SoloCard key={selected.ticket} ask={selected} onFinished={() => finish(selected.ticket)} onDraftChange={(values, bounced) => setLiveDrafts((previous) => ({ ...previous, [selected.ticket]: { values, bounced } }))} />}
      </section>
    </main>}
    <footer className="mt-14 border-t border-[var(--rule)] pt-4 text-[13px] leading-5 text-[var(--faint)]">Answers go straight to the agent. Blanks go back as explicit skips.</footer>
  </div>
}
