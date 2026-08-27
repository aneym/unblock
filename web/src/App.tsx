import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { api, FinishedError, VIEWER } from './lib/api'
import { buildDeck, groupOf, sortAsks, type DeckItem, type QueueData } from './deck'
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

  const open = useMemo(
    () => sortAsks((data?.asks || []).filter((ask) => ask.status === 'open' && !doneTickets.has(ask.ticket))),
    [data, doneTickets],
  )

  const projects = useMemo(() => {
    const counts = new Map<string, number>()
    for (const ask of open) {
      const key = groupOf(ask)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [open])
  const activeProject = project && projects.some(([name]) => name === project) ? project : null
  const setProjectPersist = (next: string | null) => {
    setProject(next)
    try {
      if (next) localStorage.setItem('ub_group', next)
      else localStorage.removeItem('ub_group')
    } catch { /* ignore */ }
  }

  // A deep-linked ask beats the project filter: following a link must never
  // land on a page that silently hides its target.
  const filtered = useMemo(() => {
    const scoped = activeProject ? open.filter((ask) => groupOf(ask) === activeProject) : open
    if (pinned && !scoped.some((ask) => ask.ticket === pinned)) {
      const target = open.find((ask) => ask.ticket === pinned)
      if (target) return [target, ...scoped]
    }
    return scoped
  }, [open, activeProject, pinned])

  const ordered = useMemo(() => {
    const deck = buildDeck(filtered)
    const pinnedItem = pinned ? deck.find((item) => item.asks.some((ask) => ask.ticket === pinned)) : undefined
    const rest = deck.filter((item) => item !== pinnedItem)
    const fresh = rest.filter((item) => !deferred.includes(item.key))
    const later = deferred.map((key) => rest.find((item) => item.key === key)).filter(Boolean) as DeckItem[]
    return [...(pinnedItem ? [pinnedItem] : []), ...fresh, ...later]
  }, [filtered, deferred, pinned])

  const current: DeckItem | undefined = ordered[0]
  const remaining = ordered.length
  const doneHere = activeProject ? doneLog.filter((entry) => entry.project === activeProject).length : doneLog.length
  const total = doneHere + remaining
  const position = Math.min(doneHere + 1, Math.max(total, 1))

  const unpinIfCurrent = (item: DeckItem) => {
    if (pinned && item.asks.some((ask) => ask.ticket === pinned)) {
      setPinned(null)
      if (window.location.hash.startsWith('#ask=')) history.replaceState(null, '', window.location.pathname + window.location.search)
    }
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
            <ProjectPicker projects={projects} active={activeProject} openCount={open.length} onPick={setProjectPersist} />
          )}
          {total > 0 && remaining > 0 && (
            <span className="ml-auto font-mono text-[13px] font-medium text-[var(--dim)]">{position} of {total}</span>
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
          <>
            <AnimatePresence mode="popLayout" initial={false}>
              {current ? (
                <motion.div
                  key={current.key}
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
            <div aria-hidden className="flex flex-col items-center">
              <AnimatePresence>
                {remaining > 1 && (
                  <motion.div key="peek1" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="mt-1.5 h-4 w-[94%] rounded-t-[16px] border border-b-0 border-[var(--rule)] bg-[var(--surface)] shadow-[0_-1px_2px_rgba(60,45,20,.04)]" />
                )}
                {remaining > 2 && (
                  <motion.div key="peek2" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="h-3.5 w-[86%] rounded-t-[14px] border border-b-0 border-[var(--rule)] bg-[var(--surface2)]" />
                )}
              </AnimatePresence>
            </div>
          </>
        )}
      </main>

      <footer className="mt-14 border-t border-[var(--rule)] pt-4 text-[13px] leading-5 text-[var(--faint)]">
        Answers go straight to the agent. Blanks go back as explicit skips.
      </footer>
    </div>
  )
}
