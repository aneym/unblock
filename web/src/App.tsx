import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { api, FinishedError, VIEWER } from './lib/api'
import { selectDeck, type DeckItem, type QueueData } from './deck'
import { SoloCard } from './SoloCard'
import { GroupCard } from './GroupCard'
import { cn } from './lib/utils'

/** #ask=<ticket> deep-links a card to the front of the deck. */
function readPinned(): string | null {
  const match = window.location.hash.match(/#ask=([^&]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function Meter({ done, total }: { done: number; total: number }) {
  if (total < 2) return null
  if (total > 14) {
    return (
      <div className="mt-3.5 h-[3px] overflow-hidden rounded-full bg-[var(--rule)]">
        <motion.div
          className="h-full rounded-full bg-[var(--ink)]"
          animate={{ width: `${Math.round((done / total) * 100)}%` }}
          transition={{ type: 'spring', stiffness: 200, damping: 28 }}
        />
      </div>
    )
  }
  return (
    <div className="mt-3.5 flex gap-1.5">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-[3px] flex-1 rounded-full transition-colors duration-500',
            index < done ? 'bg-[var(--ink)]' : 'bg-[var(--rule)]',
          )}
        />
      ))}
    </div>
  )
}

function ProjectPicker({ projects, active, openCount, onPick }: {
  projects: [string, number][]
  active: string | null
  openCount: number
  onPick: (project: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const pick = (project: string | null) => { onPick(project); setOpen(false) }
  return (
    <div className="relative">
      <motion.button
        type="button"
        whileTap={{ scale: 0.97 }}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-full border border-[var(--input-border)] bg-[var(--surface)] py-2 pl-4 pr-3.5 text-[14px] font-semibold shadow-[0_1px_2px_rgba(60,45,20,.06)]"
      >
        {active ?? 'All projects'}
        <span className="text-[10px] text-[var(--faint)]" aria-hidden>▾</span>
      </motion.button>
      <AnimatePresence>
        {open && (
          <>
            <button type="button" aria-label="Close" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} />
            <motion.ul
              role="listbox"
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 500, damping: 32 }}
              className="absolute left-0 top-[calc(100%+6px)] z-20 min-w-52 origin-top-left rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--surface)] py-1.5 shadow-[0_18px_40px_-18px_rgba(60,45,20,.4)]"
            >
              <li>
                <button type="button" role="option" aria-selected={!active} onClick={() => pick(null)} className={cn('flex w-full items-baseline gap-3 px-4 py-2 text-left text-[14px] hover:bg-[var(--surface2)]', !active && 'font-semibold')}>
                  <span className="min-w-0 flex-1">All projects</span>
                  <span className="font-mono text-[12px] text-[var(--faint)]">{openCount}</span>
                </button>
              </li>
              {projects.map(([name, count]) => (
                <li key={name}>
                  <button type="button" role="option" aria-selected={active === name} onClick={() => pick(name)} className={cn('flex w-full items-baseline gap-3 px-4 py-2 text-left text-[14px] hover:bg-[var(--surface2)]', active === name && 'font-semibold')}>
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="font-mono text-[12px] text-[var(--faint)]">{count}</span>
                  </button>
                </li>
              ))}
            </motion.ul>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

function BigState({ icon, title, detail }: { icon?: 'check'; title: string; detail: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 26 }}
      className="px-5 py-20 text-center"
    >
      {icon === 'check' && (
        <motion.span
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 20, delay: 0.05 }}
          className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-[var(--ok)] text-[22px] font-bold text-white"
        >
          ✓
        </motion.span>
      )}
      <h2 className="font-display text-[26px] font-semibold leading-tight tracking-[-.01em]">{title}</h2>
      <p className="mx-auto mt-2 max-w-[40ch] text-pretty text-[15px] leading-relaxed text-[var(--dim)]">{detail}</p>
    </motion.div>
  )
}

export default function App() {
  const [data, setData] = useState<QueueData | null>(null)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)
  // One entry per answered card, with its project — so the "N of M" header
  // can recount under a project filter instead of carrying global numbers.
  const [doneLog, setDoneLog] = useState<{ key: string; project: string }[]>([])
  const [doneTickets, setDoneTickets] = useState<ReadonlySet<string>>(new Set())
  const [deferred, setDeferred] = useState<string[]>([])
  const [pinned, setPinned] = useState<string | null>(() => readPinned())
  const [project, setProject] = useState<string | null>(() => {
    try { return localStorage.getItem('ub_group') } catch { return null }
  })
  const reduced = useReducedMotion()

  const load = useCallback(async () => {
    try { setData(await api<QueueData>('/api/queue')); setError('') }
    catch (cause) { if (cause instanceof FinishedError) setFinished(true); else setError(cause instanceof Error ? cause.message : 'Unknown error') }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return
      void load()
    }, 6000)
    return () => window.clearInterval(timer)
  }, [load])
  useEffect(() => {
    const onHashChange = () => setPinned(readPinned())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Every ordering rule lives in the shared model, so the picker, the deck and
  // the counter can never disagree about what is on screen.
  const { items, projects, activeProject, current, remaining } = useMemo(
    () => selectDeck({
      asks: data?.asks || [],
      project,
      pinnedTicket: pinned,
      deferredKeys: deferred,
      doneTickets,
    }),
    [data, project, pinned, deferred, doneTickets],
  )

  const clearPin = () => {
    setPinned(null)
    if (window.location.hash.startsWith('#ask=')) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }
  // Choosing a project is an explicit instruction, so it drops the deep link
  // that was holding the deck to one ask. Without this the picker changed and
  // the card did not, which is what made the filter look broken.
  const setProjectPersist = (next: string | null) => {
    clearPin()
    setProject(next)
    try {
      if (next) localStorage.setItem('ub_group', next)
      else localStorage.removeItem('ub_group')
    } catch { /* ignore */ }
  }

  const doneHere = activeProject ? doneLog.filter((entry) => entry.project === activeProject).length : doneLog.length
  const total = doneHere + remaining

  const unpinIfCurrent = (item: DeckItem) => {
    if (pinned && item.asks.some((ask) => ask.ticket === pinned)) clearPin()
  }
  const advance = (item: DeckItem) => {
    setDoneTickets((previous) => new Set([...previous, ...item.asks.map((ask) => ask.ticket)]))
    setDoneLog((previous) => [...previous, { key: item.key, project: item.project }])
    unpinIfCurrent(item)
    void load()
  }
  const defer = (item: DeckItem) => {
    setDeferred((previous) => [...previous.filter((key) => key !== item.key), item.key])
    unpinIfCurrent(item)
  }

  // A card answered elsewhere (the herdr pane, another tab) leaves the deck on
  // the next poll; drop its skip record so the list cannot grow forever.
  useEffect(() => {
    setDeferred((previous) => {
      const alive = previous.filter((key) => items.some((item) => item.key === key))
      return alive.length === previous.length ? previous : alive
    })
  }, [items])

  if (finished) {
    return (
      <div className="mx-auto max-w-[720px] px-4 pt-16">
        <BigState title="This link is finished" detail="Ask for a fresh one, or answer in the herdr pane." />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[720px] px-4 pb-24 pt-5 sm:px-5 sm:pt-8">
      <header>
        <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] leading-none text-[var(--faint)]">
          <span className="text-[14px] font-semibold text-[var(--ink)]">unblock</span>
          {data?.profile && data.profile !== '*' && <span>profile {data.profile}</span>}
          {!!data?.hidden && <span>{data.hidden} more in other profiles</span>}
          {VIEWER && <span className="ml-auto" title={VIEWER.login}>{VIEWER.name || VIEWER.login}</span>}
        </div>
        <div className="flex items-center gap-3">
          {projects.length > 0 && (
            <ProjectPicker
              projects={projects}
              active={activeProject}
              openCount={projects.reduce((sum, [, count]) => sum + count, 0)}
              onPick={setProjectPersist}
            />
          )}
          {remaining > 0 && (
            // Cards left, not "N of M". Skipping moves a card without
            // finishing it, and a position counter that sits still while the
            // card changes reads as a bug.
            <span className="ml-auto font-mono text-[13px] font-medium text-[var(--dim)]">{remaining} left</span>
          )}
        </div>
        <Meter done={doneHere} total={total} />
      </header>

      <main aria-live="polite" className="mt-6">
        {error ? (
          <BigState title="Cannot reach the daemon" detail={error} />
        ) : !data ? (
          <div className="px-5 py-20 text-center text-[15px] text-[var(--dim)]">Loading the queue…</div>
        ) : (
          /**
           * The stack. Each undealt card is a real layer BEHIND the live one,
           * inset and pushed down so only its bottom lip shows. Rendering them
           * as siblings underneath (the first attempt) read as two stray trays
           * floating below the card, because a lip needs the card on top of it
           * to be a lip at all.
           */
          <div className="relative">
            <AnimatePresence>
              {[2, 1].filter((depth) => remaining > depth).map((depth) => (
                <motion.div
                  key={`peek${depth}`}
                  aria-hidden
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 32 }}
                  style={{
                    top: depth * 9,
                    bottom: depth * -9,
                    left: depth * 13,
                    right: depth * 13,
                  }}
                  className="pointer-events-none absolute rounded-[var(--radius-lg)] border border-[var(--rule)] bg-[var(--surface)] shadow-[0_10px_24px_-20px_rgba(60,45,20,.4)]"
                />
              ))}
            </AnimatePresence>
            <AnimatePresence mode="popLayout" initial={false}>
              {current ? (
                <motion.div
                  key={current.key}
                  className="relative z-10"
                  initial={reduced ? { opacity: 0 } : { y: 26, scale: 0.97, opacity: 0 }}
                  animate={{ y: 0, scale: 1, opacity: 1 }}
                  exit={reduced ? { opacity: 0 } : { y: -34, opacity: 0, rotate: -1.2 }}
                  transition={{ type: 'spring', stiffness: 340, damping: 30 }}
                >
                  {current.grouped ? (
                    <GroupCard item={current} deferrable={remaining > 1} onFinished={() => advance(current)} onDefer={() => defer(current)} />
                  ) : (
                    <SoloCard ask={current.asks[0]} deferrable={remaining > 1} onFinished={() => advance(current)} onDefer={() => defer(current)} />
                  )}
                </motion.div>
              ) : (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  {doneLog.length > 0 ? (
                    <BigState icon="check" title="Deck clear" detail={`You answered ${doneLog.length} ${doneLog.length === 1 ? 'card' : 'cards'}. The agents are moving again.`} />
                  ) : (
                    <BigState title="Nothing needs you" detail="No agent is waiting on an action or a decision." />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </main>

      <footer className="mt-14 border-t border-[var(--rule)] pt-4 text-[13px] leading-5 text-[var(--faint)]">
        Answers go straight to the agent. Blanks go back as explicit skips.
      </footer>
    </div>
  )
}
