import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, BASE, FinishedError, NetworkError, VIEWER } from './lib/api'
import { clearLocal } from './lib/drafts'
import { ago, askKind, groupOf, hideProducts, projectCounts, sortAsks, type Ask, type QueueData } from './deck'
import { Icon } from './icons'
import { ChipText, PlainText } from './ChipText'
import { SoloCard, type SendRecovery } from './SoloCard'
import { TalkButton, VoiceBar } from './VoiceBar'
import type { TranscriptLine, VoiceState } from './lib/voice-live'
import { prepareAudio } from './lib/voice-audio'
import type { VoiceProvider, VoiceProviders, VoiceSpend, VoiceUi } from '../../src/voice.js'

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
      else setError(cause instanceof Error ? cause.message : 'Unknown error')
    }
  }, [])
  const [voiceState, setVoiceState] = useState<VoiceState | null>(null)
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [providers, setProviders] = useState<VoiceProviders | null>(null)
  const [provider, setProvider] = useState<VoiceProvider | undefined>()
  const [spend, setSpend] = useState<VoiceSpend | undefined>()
  const [minutesLeft, setMinutesLeft] = useState(false)
  const [blockedLink, setBlockedLink] = useState<{ url: string; label: string } | null>(null)
  const [voiceDetails, setVoiceDetails] = useState<{ ticket: string; open: boolean; nonce: number } | null>(null)
  const [voiceFill, setVoiceFill] = useState<{ ticket: string; values: Record<string, unknown>; field_context: Record<string, string>; nonce: number } | null>(null)
  const call = useRef<{ stop(): void } | null>(null)
  const starting = useRef(0)
  const selectedVoiceTicket = useRef(selectedTicket)
  selectedVoiceTicket.current = selectedTicket
  const [callTiming, setCallTiming] = useState<{ startedAt: number; maxMinutes: number } | null>(null)
  const uiNonce = useRef(0)
  const consumedFill = useRef(0)
  const consumedDetails = useRef(0)
  const consumeVoiceFill = useCallback((nonce: number) => {
    if (nonce <= consumedFill.current) return false
    consumedFill.current = nonce
    setVoiceFill((current) => current?.nonce === nonce ? null : current)
    return true
  }, [])
  const consumeVoiceDetails = useCallback((nonce: number) => {
    if (nonce <= consumedDetails.current) return false
    consumedDetails.current = nonce
    setVoiceDetails((current) => current?.nonce === nonce ? null : current)
    return true
  }, [])
  useEffect(() => {
    setVoiceFill((current) => current?.ticket === selectedTicket ? current : null)
    setVoiceDetails((current) => current?.ticket === selectedTicket ? current : null)
  }, [selectedTicket])
  useEffect(() => {
    if (voiceState?.name === 'ended' || voiceState?.name === 'error'
      || voiceState?.name === 'capped' || voiceState?.name === 'unconfigured') {
      setVoiceFill(null)
      setVoiceDetails(null)
    }
  }, [voiceState?.name])
  useEffect(() => {
    if (!VIEWER || BASE) return
    void api<VoiceProviders>('/api/voice/providers').then((result) => {
      setProviders(result)
      let stored: string | null = null
      try { stored = localStorage.getItem('unblock.voiceProvider.v2') } catch { /* storage may be unavailable */ }
      const picked = result.providers.find((item) => item.id === stored && item.configured)
      setProvider(picked?.id || result.default)
    }).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!callTiming || voiceState?.name === 'ended') return
    const tick = () => setMinutesLeft(Date.now() >= callTiming.startedAt + (callTiming.maxMinutes - 1) * 60_000)
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [callTiming, voiceState?.name])
  const startCall = (picked?: VoiceProvider) => {
    const attempt = ++starting.current
    call.current?.stop()
    call.current = null
    setTranscript([])
    setBlockedLink(null)
    setMinutesLeft(false)
    setCallTiming(null)
    setSpend(undefined)
    setVoiceFill(null)
    setVoiceDetails(null)
    let audio: AudioContext
    try { audio = prepareAudio() }
    catch (cause) {
      setVoiceState({ name: 'error', message: cause instanceof Error ? cause.message : 'Audio is unavailable.' })
      return
    }
    setVoiceState({ name: 'connecting' })
    void import('./lib/voice-live').then(({ startVoiceCall }) => {
      if (attempt !== starting.current) { void audio.close(); return }
      call.current = startVoiceCall(audio, {
        onState: setVoiceState,
        onTranscript: (line) => setTranscript((previous) => {
          const last = previous.at(-1)
          return last?.who === line.who ? [...previous.slice(0, -1), line] : [...previous, line]
        }),
        onUi: (ui: VoiceUi) => {
          switch (ui.do) {
            case 'show_ask':
              choose(ui.ticket)
              setShowAnswered(false)
              void load()
              break
            case 'show_list':
              goToList()
              if (ui.all) updateHiddenProducts(new Set())
              else if (ui.project) updateHiddenProducts(new Set(products.map(([name]) => name).filter((name) => name !== ui.project)))
              break
            case 'show_answered':
              goToList()
              setShowAnswered(true)
              break
            case 'open_link':
              if (!window.open(ui.url, '_blank', 'noopener')) setBlockedLink({ url: ui.url, label: ui.label })
              else setBlockedLink(null)
              break
            case 'details':
              if (ui.ticket !== selectedVoiceTicket.current) {
                choose(ui.ticket)
                void load()
              }
              setVoiceDetails({ ticket: ui.ticket, open: ui.open, nonce: ++uiNonce.current })
              break
            case 'fill':
              if (ui.ticket !== selectedVoiceTicket.current) {
                choose(ui.ticket)
                void load()
              }
              setVoiceFill({ ticket: ui.ticket, values: ui.values, field_context: ui.field_context, nonce: ++uiNonce.current })
              break
          }
        },
        onChanged: () => { void load() },
        onSession: (session) => {
          setProvider(session.provider)
          setSpend(session.spend)
          setCallTiming({ startedAt: Date.now(), maxMinutes: session.maxMinutes })
        },
      }, { provider: picked ?? provider })
    }).catch((cause) => {
      void audio.close()
      if (attempt === starting.current) setVoiceState({ name: 'error', message: cause instanceof Error ? cause.message : 'Voice is unavailable.' })
    })
  }
  useEffect(() => () => { starting.current++; call.current?.stop() }, [])
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
  const openAsks = useMemo(
    () => sortAsks((data?.asks || []).filter((ask) => ask.status === 'open' && !doneTickets.has(ask.ticket))),
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
  return (
    <>
      <header className="topbar">
        <div className="top-inner">
          <span className="wordmark">unblock</span>
          <span className="top-count">{asks.length} waiting{hiddenCount > 0 && ` · ${hiddenCount} hidden`}</span>
          {VIEWER && <span className="viewer" title={VIEWER.login}>{VIEWER.name || VIEWER.login}</span>}
          {VIEWER && !BASE && !finished && <TalkButton active={voiceState?.name === 'connecting' || voiceState?.name === 'listening' || voiceState?.name === 'speaking'} onClick={() => startCall()} />}
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
      {VIEWER && !BASE && <VoiceBar state={voiceState} transcript={transcript} provider={provider}
        choices={providers?.providers.filter((item) => item.configured).map(({ id, label }) => ({ id, label })) || []}
        spend={spend} minutesLeft={minutesLeft} blockedLink={blockedLink}
        onSwitch={(next) => {
          try { localStorage.setItem('unblock.voiceProvider.v2', next) } catch { /* storage may be unavailable */ }
          setProvider(next)
          startCall(next)
        }}
        onEnd={() => { starting.current++; call.current?.stop(); call.current = null; setVoiceFill(null); setVoiceDetails(null); setVoiceState({ name: 'ended' }) }}
        onRetry={() => startCall()} />}
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
              voiceDetails={voiceDetails?.ticket === selected.ticket && voiceDetails.nonce > consumedDetails.current ? voiceDetails : undefined}
              voiceFill={voiceFill?.ticket === selected.ticket && voiceFill.nonce > consumedFill.current ? voiceFill : undefined}
              onVoiceDetailsApplied={consumeVoiceDetails} onVoiceFillApplied={consumeVoiceFill}
              voiceCallActive={voiceState?.name === 'connecting' || voiceState?.name === 'listening' || voiceState?.name === 'speaking'}
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
