import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, FinishedError, VIEWER } from './lib/api'
import { ago, askKind, groupOf, sortAsks, type Ask, type QueueData } from './deck'
import { Icon } from './icons'
import { ChipText, PlainText } from './ChipText'
import { SoloCard } from './SoloCard'

function pinned() {
  const match = location.hash.match(/#ask=([^&]+)/)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}
function whyLead(why: string) {
  const sentence = why.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] || why
  return sentence.length > 180 ? `${sentence.slice(0, 179).trimEnd()}…` : sentence
}
function QueueRow({ ask, active, choose }: { ask: Ask; active: boolean; choose: (ticket: string) => void }) {
  return (
    <button
      id={`ask-tab-${encodeURIComponent(ask.ticket)}`} type="button"
      className={`queue-row kind-${askKind(ask)}${active ? ' selected' : ''}`}
      aria-current={active ? 'true' : undefined} onClick={() => choose(ask.ticket)}
    >
      <span className="row-heading">
        <span className="kind-label"><Icon name={askKind(ask)} size={16} /> {askKind(ask)}</span>
        <span className="row-title"><PlainText text={ask.title} /></span>
      </span>
      <span className="row-meta">{groupOf(ask)} · {ask.minutes && `~${ask.minutes} min · `}
        waiting {ago(ask.created_at)}
      </span>
    </button>
  )
}
function QueueRail({ asks, selected, choose }: {
  asks: Ask[]; selected: string | null; choose: (ticket: string) => void
}) {
  const projects = Array.from(new Set(asks.map(groupOf)))
  return (
    <nav className="queue" aria-label="Waiting on you">
      <h2>Waiting on you</h2>
      {projects.map((project) => (
        <div className="queue-group" key={project}>
          <h3>{project}</h3>
          {asks.filter((ask) => groupOf(ask) === project).map((ask) => (
            <QueueRow key={ask.ticket} ask={ask} active={selected === ask.ticket} choose={choose} />
          ))}
        </div>
      ))}
    </nav>
  )
}
function AskList({ asks, choose, showAnswered }: {
  asks: Ask[]; choose: (ticket: string) => void; showAnswered: () => void
}) {
  if (!asks.length) return (
    <main className="list-page empty-list">
      <p>Nothing is waiting on you.</p>
      <button className="text-button" type="button" onClick={showAnswered}>Show answered</button>
    </main>
  )
  const [first, ...others] = asks
  const renderRow = (ask: Ask, expanded: boolean) => (
    <div className={`list-entry kind-${askKind(ask)}${expanded ? ' expanded' : ''}`} key={ask.ticket}>
      <button className="list-row" type="button" onClick={() => choose(ask.ticket)}>
        <span className="kind-label"><Icon name={askKind(ask)} size={16} /> {askKind(ask)}</span>
        <span className="list-row-copy">
          <span className="list-row-title"><PlainText text={ask.title} /></span>
          <span className="ask-meta">{groupOf(ask)} · {ask.minutes && `~${ask.minutes} min · `}
            waiting {ago(ask.created_at)}
          </span>
          {ask.kind === 'park' ? (
            <span className="status-pill paused"><Icon name="park" size={14} /> Agent paused</span>
          ) : !!ask.blocks?.length && (
            <span className="ask-meta">unblocks: <PlainText text={ask.blocks.join(', ')} /></span>
          )}
        </span>
        <span className="row-answer">Answer →</span>
      </button>
      {expanded && (
        <div className="list-focal">
          <p>{ask.minutes && `~${ask.minutes} min · `}<ChipText text={ask.summary || whyLead(ask.why)} /></p>
          <button className="primary" type="button" onClick={() => choose(ask.ticket)}>Answer →</button>
        </div>
      )}
    </div>
  )
  return (
    <main className="list-page">
      {renderRow(first, true)}
      {others.map((ask) => renderRow(ask, false))}
    </main>
  )
}
export default function App() {
  const [data, setData] = useState<QueueData | null>(null)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)
  const [selectedTicket, setSelectedTicket] = useState<string | null>(pinned)
  const [showAnswered, setShowAnswered] = useState(false)
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
  const selected = data?.asks.find((ask) => ask.ticket === selectedTicket)
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
      if (event.target instanceof HTMLElement
        && event.target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      const direction = event.key === 'j' || event.key === 'ArrowDown' ? 1
        : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
      if (!direction || !asks.length) return
      event.preventDefault()
      const index = selected ? asks.findIndex((ask) => ask.ticket === selected.ticket) : 0
      const next = asks[(index + direction + asks.length) % asks.length]
      choose(next.ticket)
      document.getElementById(`ask-tab-${encodeURIComponent(next.ticket)}`)?.scrollIntoView({ block: 'nearest' })
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
        <div className="empty"><h2>This link is done.</h2><p>The answer reached the agent.</p></div>
      ) : !data ? (
        <div className="empty">
          <h2>{error ? "Can't reach the queue. Retrying…" : 'Loading the queue…'}</h2>
          <p>{error}</p>
        </div>
      ) : selectedTicket && selected ? (
        <main className="shell">
          <QueueRail asks={asks} selected={selectedTicket} choose={choose} />
          <section className="ask-pane" aria-label="Selected ask">
            <button
              className="back-link" type="button" onClick={() => {
                history.pushState(null, '', location.pathname + location.search)
                setSelectedTicket(null)
              }}
            >
              ← All asks
            </button>
            <SoloCard
              key={selected.ticket} ask={selected}
              onFinished={() => finish(selected.ticket)} onReload={load}
            />
          </section>
        </main>
      ) : showAnswered ? (
        <main className="list-page">
          <button className="back-link" type="button" onClick={() => setShowAnswered(false)}>← All asks</button>
          <h1 className="list-title">Answered</h1>
          {(data.asks || []).filter((ask) => ask.status === 'answered').map((ask) => (
            <QueueRow key={ask.ticket} ask={ask} active={false} choose={choose} />
          ))}
        </main>
      ) : <AskList asks={asks} choose={choose} showAnswered={() => setShowAnswered(true)} />}
    </>
  )
}
