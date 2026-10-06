// Freeze telemetry: the scope page reports its own load by beacon at 60 s and on pagehide.
// All times are integer ms relative to performance.timeOrigin. Nothing here may throw into the page.
export type PollTiming = { at: number; fetch: number; parse: number; render: number; kb: number; changed: boolean }
type Mode = 'poll' | 'events'

const TOP = 10
const MAX_BYTES = 15000
const ms = (n: number) => Math.round(n)

// Counts every item but keeps only the worst few.
function tracker<T>(score: (item: T) => number) {
  const state = { n: 0, total: 0, max: 0, top: [] as T[] }
  return {
    state,
    add(item: T) {
      const value = score(item)
      state.n++; state.total += value; if (value > state.max) state.max = value
      state.top.push(item); state.top.sort((a, b) => score(b) - score(a)); if (state.top.length > TOP) state.top.length = TOP
    },
  }
}

function observe(type: string, options: Record<string, unknown>, onEntry: (entry: any) => void) {
  try {
    if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes(type)) return
    new PerformanceObserver(list => { try { for (const entry of list.getEntries()) onEntry(entry) } catch {} }).observe({ type, buffered: true, ...options })
  } catch {}
}

export function startTelemetry(opts: { url: string; mode: Mode }): { docRendered(): void; poll(t: PollTiming): void } {
  const now = () => ms(performance.now())
  let docRenderedAt: number | null = null
  let composerAt: number | null = null
  let firstInput: { at: number; delay: number } | null = null
  const slowInputs = tracker<{ at: number; type: string; delay: number; dur: number }>(i => i.dur)
  const longtasks = tracker<{ at: number; dur: number; attr: string }>(t => t.dur)
  const gaps = tracker<{ at: number; dur: number }>(g => g.dur)
  const fetches = tracker<{ at: number; dur: number; path: string; kb: number }>(f => f.dur)
  const polls = { n: 0, unchanged: 0, fetch_max_ms: 0, parse_max_ms: 0, render_max_ms: 0, total_ms: 0 }
  const slowPolls = tracker<PollTiming>(p => p.fetch + p.parse + p.render)

  // Visible time, kept by visibilitychange.
  let visibleSince: number | null = document.visibilityState === 'visible' ? performance.now() : null
  let visibleTotal = 0
  document.addEventListener('visibilitychange', () => {
    try {
      const t = performance.now()
      if (document.visibilityState === 'visible') { if (visibleSince === null) visibleSince = t }
      else if (visibleSince !== null) { visibleTotal += t - visibleSince; visibleSince = null }
    } catch {}
  })

  // Composer: first <textarea> anywhere in the document.
  try {
    const found = () => { if (composerAt === null && document.querySelector('textarea')) { composerAt = now(); return true } return false }
    if (!found()) {
      const watcher = new MutationObserver(() => { try { if (found()) watcher.disconnect() } catch {} })
      watcher.observe(document.documentElement, { childList: true, subtree: true })
    }
  } catch {}

  observe('first-input', {}, entry => { if (!firstInput) firstInput = { at: ms(entry.startTime), delay: ms(entry.processingStart - entry.startTime) } })
  observe('event', { durationThreshold: 16 }, entry => {
    if (entry.duration > 200) slowInputs.add({ at: ms(entry.startTime), type: String(entry.name), delay: ms(entry.processingStart - entry.startTime), dur: ms(entry.duration) })
  })
  observe('longtask', {}, entry => {
    if (entry.duration <= 200) return
    const a = entry.attribution?.[0]
    const attr = [a?.containerType, a?.containerName, a?.name].filter(Boolean).join('/').slice(0, 80)
    longtasks.add({ at: ms(entry.startTime), dur: ms(entry.duration), attr })
  })
  observe('resource', {}, entry => {
    if (entry.duration <= 2000) return
    let path = ''
    try { path = new URL(entry.name).pathname } catch {}
    fetches.add({ at: ms(entry.startTime), dur: ms(entry.duration), path, kb: ms((entry.encodedBodySize || 0) / 1024) })
  })

  // Main-thread heartbeat: a tick that arrives much later than 250 ms while the page stayed visible is a freeze.
  let lastTick = performance.now(), lastVisible = document.visibilityState === 'visible'
  setInterval(() => {
    try {
      const t = performance.now(), visible = document.visibilityState === 'visible', gap = t - lastTick - 250
      if (gap > 1000 && visible && lastVisible) gaps.add({ at: ms(t), dur: ms(gap) })
      lastTick = t; lastVisible = visible
    } catch {}
  }, 250)

  function report(reason: '60s' | 'pagehide') {
    const nav = (performance.getEntriesByType('navigation')[0] || null) as PerformanceNavigationTiming | null
    const t = performance.now()
    const body: Record<string, any> = {
      v: 1, reason, since_load_ms: ms(t), mode: opts.mode,
      visible_ms: ms(visibleTotal + (visibleSince !== null ? t - visibleSince : 0)),
      nav: nav && { ttfb: ms(nav.responseStart), dom_interactive: ms(nav.domInteractive), dcl: ms(nav.domContentLoadedEventEnd), load: ms(nav.loadEventEnd), transfer_kb: ms(nav.transferSize / 1024) },
      doc_rendered_ms: docRenderedAt,
      composer_ready_ms: composerAt,
      first_input: firstInput,
      slow_inputs: slowInputs.state.top,
      longtasks: { n: longtasks.state.n, total_ms: longtasks.state.total, max_ms: longtasks.state.max, top: longtasks.state.top },
      gaps: { n: gaps.state.n, max_ms: gaps.state.max, top: gaps.state.top },
      slow_fetches: { n: fetches.state.n, max_ms: fetches.state.max, top: fetches.state.top },
      polls: { ...polls, top: slowPolls.state.top.map(p => ({ at: p.at, fetch: p.fetch, parse: p.parse, render: p.render, kb: p.kb, changed: p.changed })) },
    }
    let json = JSON.stringify(body)
    if (json.length > MAX_BYTES) {
      body.slow_inputs = body.slow_inputs.slice(0, 3)
      for (const key of ['longtasks', 'gaps', 'slow_fetches', 'polls']) body[key].top = body[key].top.slice(0, 3)
      json = JSON.stringify(body)
    }
    if (json.length > MAX_BYTES) {
      body.slow_inputs = []
      for (const key of ['longtasks', 'gaps', 'slow_fetches', 'polls']) body[key].top = []
      json = JSON.stringify(body)
    }
    return json
  }
  function send(reason: '60s' | 'pagehide') {
    try { navigator.sendBeacon(opts.url, new Blob([report(reason)], { type: 'application/json' })) } catch {}
  }
  setTimeout(() => send('60s'), 60000)
  addEventListener('pagehide', () => send('pagehide'))

  return {
    docRendered() { if (docRenderedAt === null) docRenderedAt = now() },
    poll(raw) {
      try {
        const p = { ...raw, at: ms(raw.at), fetch: ms(raw.fetch), parse: ms(raw.parse), render: ms(raw.render), kb: ms(raw.kb) }
        const total = p.fetch + p.parse + p.render
        polls.n++; if (!p.changed) polls.unchanged++
        polls.fetch_max_ms = Math.max(polls.fetch_max_ms, p.fetch); polls.parse_max_ms = Math.max(polls.parse_max_ms, p.parse); polls.render_max_ms = Math.max(polls.render_max_ms, p.render)
        polls.total_ms += total
        slowPolls.add(p)
      } catch {}
    },
  }
}
