import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, FinishedError, VIEWER } from './lib/api'
import { ago, groupOf, sortAsks, type Ask, type QueueData } from './deck'
import { readLocal } from './lib/drafts'
import { Icon, stateOf } from './icons'
import { SoloCard } from './SoloCard'

function pinned() {
  const match = location.hash.match(/#ask=([^&]+)/)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}
function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="empty"><h2>{title}</h2><p>{detail}</p></div>
}
function QueueRow({ ask, active, sent, choose }: {
  ask: Ask; active: boolean; sent: boolean; choose: (ticket: string) => void
}) {
  const hasDraft = !sent && !!(ask.draft_updated_at || readLocal(ask.ticket))
  const state = sent ? { name: 'sent' as const, label: 'Sent' } : stateOf(ask, hasDraft)
  const left = ask.fields.filter((field) => !(field.name in (ask.answers || {}))).length
  return (
    <button
      id={`ask-tab-${encodeURIComponent(ask.ticket)}`}
      type="button"
      className={`queue-row${active ? ' selected' : ''}`}
      aria-current={active ? 'true' : undefined}
      onClick={() => choose(ask.ticket)}
    >
      <span className="row-heading">
        <Icon name={state.name} /><span className="row-title">{ask.title}</span>
      </span>
      <span className="row-meta">
        <span>{state.label}</span><span>·</span><span>{ago(ask.created_at)}</span><span>·</span>
        <span>{left} {left === 1 ? 'question' : 'questions'}</span><span>·</span>
        <span>{ask.origin.agent || 'agent'}</span>
      </span>
    </button>
  )
}
function QueueGroups({ asks, selectedTicket, selected, doneTickets, choose }: {
  asks: Ask[]; selectedTicket: string | null; selected: Ask | undefined
  doneTickets: ReadonlySet<string>; choose: (ticket: string) => void
}) {
  const projects = Array.from(new Set(asks.map(groupOf)))
  return (
    <nav className="queue" aria-label="Waiting on you">
      <h2>Waiting on you</h2>
      {projects.map((project) => (
        <div className="queue-group" key={project}>
          <h3>{project}</h3>
          {asks.filter((ask) => groupOf(ask) === project).map((ask) => (
            <QueueRow
              key={ask.ticket}
              ask={ask}
              active={!!selectedTicket && ask.ticket === selected?.ticket}
              sent={doneTickets.has(ask.ticket)}
              choose={choose}
            />
          ))}
        </div>
      ))}
    </nav>
  )
}
export default function App() {
  const [data, setData] = useState<QueueData | null>(null)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)
  const [selectedTicket, setSelectedTicket] = useState<string | null>(pinned)
  const [doneTickets, setDoneTickets] = useState<ReadonlySet<string>>(new Set())
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
    const onHash = () => setSelectedTicket(pinned())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const asks = useMemo(
    () => sortAsks((data?.asks || []).filter((ask) => ask.status === 'open' && !doneTickets.has(ask.ticket))),
    [data, doneTickets],
  )
  const selected = asks.find((ask) => ask.ticket === selectedTicket) || asks[0]
  const choose = useCallback((ticket: string) => {
    if (pinned() !== ticket) location.hash = `ask=${encodeURIComponent(ticket)}`
    setSelectedTicket(ticket)
  }, [])
  const finish = (ticket: string) => {
    const index = asks.findIndex((ask) => ask.ticket === ticket)
    const next = asks[index + 1] || asks[index - 1]
    setDoneTickets((previous) => new Set([...previous, ticket]))
    if (next) choose(next.ticket)
    else { history.replaceState(null, '', location.pathname + location.search); setSelectedTicket(null) }
    void load()
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
      const target = event.target
      const inField = target instanceof HTMLElement
        && target.closest('input, textarea, select, button, a, [contenteditable="true"]')
      if (inField) return
      const direction = event.key === 'j' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'k' || event.key === 'ArrowUp'
          ? -1
          : 0
      if (!direction || !asks.length) return
      event.preventDefault()
      const index = selected ? asks.findIndex((ask) => ask.ticket === selected.ticket) : 0
      const next = asks[(index + direction + asks.length) % asks.length]
      choose(next.ticket)
      document.getElementById(`ask-tab-${encodeURIComponent(next.ticket)}`)
        ?.scrollIntoView({ block: 'nearest' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asks, selected, choose])

  return (
    <>
      <header className="topbar">
        <div className="top-inner">
          <span className="wordmark">unblock</span>
          <span className="top-count">{asks.length} waiting</span>
          {VIEWER && <span className="viewer" title={VIEWER.login}>{VIEWER.name || VIEWER.login}</span>}
        </div>
      </header>
      {finished ? (
        <Empty title="This link is done." detail="The answer reached the agent." />
      ) : !data ? (
        <Empty
          title={error ? "Can't reach the queue. Retrying…" : 'Loading the queue…'}
          detail={error || ''}
        />
      ) : !asks.length ? (
        <Empty title="Nothing is waiting on you." detail="Agents only file what they cannot do themselves." />
      ) : (
        <main className={`shell${selectedTicket ? ' has-hash' : ''}`}>
          <QueueGroups
            asks={asks}
            selectedTicket={selectedTicket}
            selected={selected}
            doneTickets={doneTickets}
            choose={choose}
          />
          <section className="ask-pane" aria-label="Selected ask">
            <button
              className="back-link"
              type="button"
              onClick={() => {
                history.pushState(null, '', location.pathname + location.search)
                setSelectedTicket(null)
              }}
            >
              ← All asks
            </button>
            {selected && (
              <SoloCard key={selected.ticket} ask={selected} onFinished={() => finish(selected.ticket)} />
            )}
          </section>
        </main>
      )}
    </>
  )
}
