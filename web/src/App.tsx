import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, BASE, FinishedError, VIEWER } from './lib/api'
import { ago, askKind, groupOf, sortAsks, type Ask, type PasskeyState, type QueueData } from './deck'
import { Icon } from './icons'
import { ChipText, PlainText } from './ChipText'
import { SoloCard } from './SoloCard'
import { dismissBanner, listPasskeys, type BannerEvent } from './lib/passkey'

function pinned() {
  const match = location.hash.match(/#ask=([^&]+)/)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}
function whyLead(why: string) {
  const sentence = why.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] || why
  return sentence.length > 180 ? `${sentence.slice(0, 179).trimEnd()}…` : sentence
}
/**
 * Sits above everything on the canonical page until dismissed. Every
 * enrollment — including Alex's own, during the review — raises one of
 * these, because enrollment is open to whoever reaches the human path
 * first while zero credentials exist (see SPEC-v2, "Passkey gate").
 */
function PasskeyBanner({ events, dismiss }: { events: BannerEvent[]; dismiss: (eventId: string) => void }) {
  if (!events.length) return null
  return (
    <div className="passkey-banner">
      {events.map((event) => (
        <div className="passkey-banner-row" key={event.event_id}>
          <Icon name="shield" size={16} />
          <span>
            A passkey was added{' '}
            {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
            If that wasn't you, stop and check before approving anything.
          </span>
          <button className="text-button" type="button" onClick={() => dismiss(event.event_id)}>Dismiss</button>
        </div>
      ))}
    </div>
  )
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
function AskList({ asks, choose, showAnswered }: {
  asks: Ask[]; choose: (ticket: string) => void; showAnswered: () => void
}) {
  if (!asks.length) return (
    <main className="list-page empty-list">
      <p>Nothing waiting</p>
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
        {!expanded && <span className="row-answer">Answer →</span>}
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
  // A share link (BASE = `/u/<token>`) has no human path to the passkey
  // routes; only the canonical, trusted-proxy page can enroll or approve.
  const passkeyAvailable = !BASE
  const [passkeyCount, setPasskeyCount] = useState(0)
  const [passkeyBanner, setPasskeyBanner] = useState<BannerEvent[]>([])
  const refreshPasskeys = useCallback(async () => {
    if (!passkeyAvailable) return
    try {
      const result = await listPasskeys()
      setPasskeyCount(result.credentials.length)
      setPasskeyBanner(result.banner)
    } catch { /* best effort; the page still works without this */ }
  }, [passkeyAvailable])
  useEffect(() => { void refreshPasskeys() }, [refreshPasskeys])
  const dismissPasskeyBanner = useCallback((eventId: string) => {
    void dismissBanner(eventId).catch(() => undefined).then(refreshPasskeys)
  }, [refreshPasskeys])
  const passkeys: PasskeyState = useMemo(
    () => ({ available: passkeyAvailable, count: passkeyCount, refresh: refreshPasskeys }),
    [passkeyAvailable, passkeyCount, refreshPasskeys],
  )
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
  const currentIndex = asks.findIndex((ask) => ask.ticket === selectedTicket)
  const choose = useCallback((ticket: string) => {
    if (pinned() !== ticket) location.hash = `ask=${encodeURIComponent(ticket)}`
    setSelectedTicket(ticket)
    window.scrollTo(0, 0)
  }, [])
  const goToList = useCallback(() => {
    history.pushState(null, '', location.pathname + location.search)
    setSelectedTicket(null)
    setShowAnswered(false)
    window.scrollTo(0, 0)
  }, [])
  const finish = (ticket: string) => {
    const index = asks.findIndex((ask) => ask.ticket === ticket)
    const remaining = asks.filter((ask) => ask.ticket !== ticket)
    const next = remaining[index < 0 || index >= remaining.length ? 0 : index]
    setDoneTickets((previous) => new Set([...previous, ticket]))
    if (next) choose(next.ticket)
    else goToList()
    void load()
  }
  useEffect(() => {
    if (!selectedTicket || !selected) return
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey) return
      if (event.target instanceof Element
        && event.target.closest('input, textarea, select, [contenteditable]')) return
      const openMenu = document.querySelector('.ask-pane .menu-popover')
      const openDialog = document.querySelector('.ask-pane dialog[open], .ask-pane [role="dialog"], .ask-pane [popover]:popover-open')
      if (openMenu || openDialog) {
        if (event.key === 'Escape' && openMenu) {
          event.preventDefault()
          openMenu.parentElement?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.click()
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        goToList()
        return
      }
      const direction = event.key === 'j' || event.key === 'ArrowRight' ? 1
        : event.key === 'k' || event.key === 'ArrowLeft' ? -1 : 0
      const next = asks[currentIndex + direction]
      if (!direction || !next || currentIndex < 0) return
      event.preventDefault()
      choose(next.ticket)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asks, selected, selectedTicket, currentIndex, choose, goToList])
  return (
    <>
      <PasskeyBanner events={passkeyBanner} dismiss={dismissPasskeyBanner} />
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
          <section className="ask-pane" aria-label="Selected ask">
            <nav className="ask-navigation" aria-label="Ask navigation">
              <button className="text-button" type="button" onClick={goToList}>← All asks</button>
              <span className="ask-navigation-right">
                {currentIndex >= 0 && <span>{currentIndex + 1} of {asks.length}</span>}
                {!!asks.length && (currentIndex < 0 || currentIndex < asks.length - 1) && (
                  <>
                    {currentIndex >= 0 && <span>·</span>}
                    <button className="text-button" type="button"
                      onClick={() => choose(asks[currentIndex < 0 ? 0 : currentIndex + 1].ticket)}
                    >Next →</button>
                  </>
                )}
              </span>
            </nav>
            <SoloCard
              key={selected.ticket} ask={selected} passkeys={passkeys}
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
