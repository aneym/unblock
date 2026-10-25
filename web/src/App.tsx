import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, BASE, FinishedError, getSession, logout, NetworkError, VIEWER, type SessionInfo } from './lib/api'
import { LoginWall } from './LoginWall'
import { clearLocal } from './lib/drafts'
import { ago, askKind, groupOf, hideProducts, projectCounts, sortAsks, todayAsks, type Ask, type QueueData } from './deck'
import { Icon } from './icons'
import { ChipText, PlainText } from './ChipText'
import { SoloCard, type SendRecovery } from './SoloCard'

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
function AskList({ asks, products, hiddenProducts, toggleProduct, showAll, choose, showAnswered }: {
  asks: Ask[]; products: [string, number][]; hiddenProducts: ReadonlySet<string>
  toggleProduct: (name: string) => void; showAll: () => void
  choose: (ticket: string) => void; showAnswered: () => void
}) {
  const controls = (products.length >= 2 || (!asks.length && products.length > 0)) && (
    <nav className="product-filter" aria-label="Filter by product">
      {products.map(([name, count]) => {
        const shown = !hiddenProducts.has(name)
        return (
          <button type="button" key={name} className={`product-toggle${shown ? '' : ' off'}`} aria-pressed={shown}
            title={shown ? `Hide ${name}` : `Show ${name}`} onClick={() => toggleProduct(name)}
          >{name}<span className="product-count">{count}</span></button>
        )
      })}
    </nav>
  )
  if (!asks.length) return (
    <main className="list-page empty-list">
      {controls}
      <p>{products.length ? 'Nothing waiting in the products you picked' : 'Nothing waiting'}</p>
      <span className="empty-actions">
        {!!products.length && <button className="text-button" type="button" onClick={showAll}>Show all products</button>}
        <button className="text-button" type="button" onClick={showAnswered}>Show answered</button>
      </span>
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
            <span className="ask-meta">unblocks: <PlainText text={ask.blocks} /></span>
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
      {controls}
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
  // The wall: outside a shared link the page needs a signed-in human session.
  // A shared /u/<token> link carries its own capability, so BASE skips the wall.
  const [session, setSession] = useState<SessionInfo | null>(BASE ? { configured: true, authenticated: true, viewer: null } : null)
  const viewer = session?.viewer ?? VIEWER
  const [showAnswered, setShowAnswered] = useState(false)
  const [doneTickets, setDoneTickets] = useState<ReadonlySet<string>>(new Set())
  const outbox = useRef(new Set<string>())
  const [sendNotice, setSendNotice] = useState<
    { ticket: string; title: string; reason: string; kind: 'failure' } |
    { ticket: string; title: string; kind: 'partial' } | null
  >(null)
  const [recoveries, setRecoveries] = useState<Record<string, SendRecovery>>({})
  useEffect(() => {
    if (BASE) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!outbox.current.size) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])
  const [hiddenProducts, setHiddenProducts] = useState<ReadonlySet<string>>(() => {
    try {
      const names = JSON.parse(localStorage.getItem('unblock.hiddenProducts') || '[]')
      return new Set(Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [])
    } catch { return new Set() }
  })
  const updateHiddenProducts = (names: ReadonlySet<string>) => {
    setHiddenProducts(names)
    try { localStorage.setItem('unblock.hiddenProducts', JSON.stringify([...names])) }
    catch { /* storage may be unavailable */ }
  }
  const toggleProduct = (name: string) => {
    const names = new Set(hiddenProducts)
    if (names.has(name)) names.delete(name)
    else names.add(name)
    updateHiddenProducts(names)
  }
  const load = useCallback(async () => {
    try { setData(await api<QueueData>('/api/queue')); setError('') }
    catch (cause) {
      if (cause instanceof FinishedError) setFinished(true)
      // The session expired (or the daemon restarted): drop back to the wall
      // instead of showing the previous human's queue.
      else if (cause instanceof ApiError && cause.code === 'HUMAN_ONLY') {
        setSession((current) => current ? { ...current, authenticated: false } : current)
      } else setError(cause instanceof Error ? cause.message : 'Unknown error')
    }
  }, [])
  useEffect(() => {
    if (BASE) return
    let alive = true
    getSession().then((info) => { if (alive) setSession(info) })
      .catch(() => { if (alive) setSession({ configured: true, authenticated: false, viewer: null }) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    // Nothing is fetched until the human is through the wall.
    if (!BASE && !session?.authenticated) return
    void load()
    const timer = window.setInterval(() => {
      if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return
      void load()
    }, 6000)
    return () => window.clearInterval(timer)
  }, [load, session?.authenticated])
  useEffect(() => {
    const onHash = () => setSelectedTicket(pinned())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const openAsks = useMemo(
    () => sortAsks(todayAsks(data?.asks || []).filter((ask) => !doneTickets.has(ask.ticket))),
    [data, doneTickets],
  )
  const products = useMemo(() => projectCounts(openAsks), [openAsks])
  const asks = useMemo(() => hideProducts(openAsks, hiddenProducts), [openAsks, hiddenProducts])
  const hiddenCount = openAsks.length - asks.length
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
  // A card calls finish a moment after it sends, by which time the queue may
  // have changed and the human may have moved on. Remember, while the ask is
  // open, the asks that followed it; advance to the first still waiting, or to
  // whatever else waits, or to the list. Never move someone who already left.
  const asksRef = useRef(asks)
  asksRef.current = asks
  const selectedRef = useRef(selectedTicket)
  selectedRef.current = selectedTicket
  const following = useRef<string[]>([])
  if (currentIndex >= 0) following.current = asks.slice(currentIndex + 1).map((ask) => ask.ticket)
  const finish = (ticket: string) => {
    setDoneTickets((previous) => new Set([...previous, ticket]))
    if (!outbox.current.has(ticket)) void load()
    if (selectedRef.current !== ticket) return
    const waiting = asksRef.current.filter((ask) => ask.ticket !== ticket)
    const next = following.current.find((t) => waiting.some((ask) => ask.ticket === t)) ?? waiting[0]?.ticket
    if (next) choose(next)
    else goToList()
  }
  const queueSend = (ticket: string, body: unknown, recovery: SendRecovery) => {
    if (outbox.current.has(ticket)) return false
    outbox.current.add(ticket)
    setSendNotice((current) => current?.ticket === ticket ? null : current)
    const title = data?.asks.find((ask) => ask.ticket === ticket)?.title || ticket
    void api<{ complete: boolean }>('/api/answer', body).then((result) => {
      if (result.complete) {
        clearLocal(ticket)
        setRecoveries((previous) => { const next = { ...previous }; delete next[ticket]; return next })
      } else {
        // A partial answer stays open and can be revisited with its local draft.
        setDoneTickets((previous) => { const next = new Set(previous); next.delete(ticket); return next })
        setSendNotice({ ticket, title, kind: 'partial' })
      }
    }).catch((cause: unknown) => {
      if (cause instanceof FinishedError || (cause instanceof ApiError && cause.code === 'ASK_NOT_OPEN')) {
        clearLocal(ticket)
        return
      }
      const reason = cause instanceof ApiError && cause.code === 'STALE_REVISION'
        ? 'The agent changed this ask. Check it again'
        : cause instanceof ApiError && cause.code === 'HUMAN_ONLY'
          ? 'Approvals only count from your own signed-in page. Open this ask from the tailnet link'
          : cause instanceof NetworkError ? 'The connection to unblock dropped, even after retrying'
            : cause instanceof Error ? cause.message : 'Unknown error'
      setRecoveries((previous) => ({ ...previous, [ticket]: recovery }))
      setDoneTickets((previous) => { const next = new Set(previous); next.delete(ticket); return next })
      setSendNotice({ ticket, title, reason, kind: 'failure' })
    }).finally(() => {
      outbox.current.delete(ticket)
      void load()
    })
    return true
  }
  useEffect(() => {
    if (!selectedTicket || !selected) return
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return
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
  if (!BASE && session && !session.authenticated) {
    return <LoginWall session={session} onLogin={setSession} />
  }
  return (
    <>
      <header className="topbar">
        <div className="top-inner">
          <span className="wordmark">unblock</span>
          <span className="top-count">{asks.length} waiting{hiddenCount > 0 && ` · ${hiddenCount} hidden`}</span>
          {viewer && <span className="viewer" title={viewer.login}>{viewer.name || viewer.login}</span>}
          {viewer && !BASE && <button className="text-button sign-out" type="button"
            onClick={() => { void logout().finally(() => setSession({ configured: true, authenticated: false, viewer: null })) }}>Sign out</button>}
        </div>
      </header>
      {!BASE && sendNotice && <div className={`outbox-notice${sendNotice.kind === 'partial' ? ' is-partial' : ''}`} role="status">
        <span>{sendNotice.kind === 'partial'
          ? <>Saved “{sendNotice.title}”, but it still needs more.</>
          : <>Couldn't send “{sendNotice.title}”: {sendNotice.reason}.</>}</span>
        <button className="text-button" type="button" onClick={() => {
          choose(sendNotice.ticket)
          setSendNotice(null)
        }}>Open it</button>
      </div>}
      {finished ? (
        <div className="empty"><h2>This link is done.</h2><p>The answer reached the agent.</p></div>
      ) : !data ? (
        <div className="empty">
          <h2>{error ? "Can't reach the queue. Retrying…" : 'Loading the queue…'}</h2>
          <p>{error}</p>
        </div>
      ) : selectedTicket && selected && !(selected.status === 'open' && doneTickets.has(selectedTicket)) ? (
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
              key={selected.ticket} ask={selected}
              onFinished={() => finish(selected.ticket)} onReload={load}
              queueSend={!BASE ? queueSend : undefined} recovery={recoveries[selected.ticket]}
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
      ) : <AskList asks={asks} products={products} hiddenProducts={hiddenProducts}
        toggleProduct={toggleProduct} showAll={() => updateHiddenProducts(new Set())}
        choose={choose} showAnswered={() => setShowAnswered(true)} />}
    </>
  )
}
