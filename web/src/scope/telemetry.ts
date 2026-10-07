// Freeze telemetry: the scope page reports its own load by beacon at 60 s and on pagehide.
// All times are integer ms relative to performance.timeOrigin. Nothing here may throw into the page.
export type PollTiming = { at: number; fetch: number; parse: number; render: number; kb: number; changed: boolean }
type Mode = 'poll' | 'events'

const TOP = 10
const MAX_BYTES = 15000
const ms = (n: number) => Math.round(n)

// A slow resource is reported by kind only: no pathname, query, host or any other part of its URL is sent,
// because scope pages carry names and ids in them.
const EXT_KINDS: Record<string, string> = {
  js: 'script', mjs: 'script', css: 'style', html: 'doc', htm: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', ico: 'image',
  mp4: 'media', webm: 'media', mov: 'media', m4v: 'media', mp3: 'media', m4a: 'media', wav: 'media', ogg: 'media',
  woff: 'font', woff2: 'font', ttf: 'font', otf: 'font',
}
const INITIATOR_KINDS: Record<string, string> = {
  script: 'script', css: 'style', img: 'image', image: 'image', video: 'media', audio: 'media', track: 'media', iframe: 'doc', frame: 'doc', navigation: 'doc',
}
export function resourceKind(entry: { name?: unknown; initiatorType?: unknown }): { kind: string; origin: 'self' | 'cross' } {
  let kind = 'other', origin: 'self' | 'cross' = 'cross'
  try {
    const url = new URL(String(entry.name))
    origin = url.origin === location.origin ? 'self' : 'cross'
    const path = url.pathname, ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
    if (origin === 'self' && (path.startsWith('/w/api/') || path.startsWith('/api/'))) kind = 'api'
    else {
      const init = String(entry.initiatorType)
      kind = (Object.hasOwn(INITIATOR_KINDS, init) && INITIATOR_KINDS[init]) || (ext && Object.hasOwn(EXT_KINDS, ext) && EXT_KINDS[ext]) || 'other'
    }
  } catch {}
  return { kind, origin }
}

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
  const fetches = tracker<{ at: number; dur: number; kind: string; origin: 'self' | 'cross'; kb: number }>(f => f.dur)
  const polls = { n: 0, unchanged: 0, fetch_max_ms: 0, parse_max_ms: 0, render_max_ms: 0, total_ms: 0 }
  const slowPolls = tracker<PollTiming>(p => p.fetch + p.parse + p.render)

  let lastTick = performance.now(), lastVisible = document.visibilityState === 'visible'

  // Visible time, kept by visibilitychange.
  let visibleSince: number | null = document.visibilityState === 'visible' ? performance.now() : null
  let visibleTotal = 0
  document.addEventListener('visibilitychange', () => {
    try {
      const t = performance.now()
      if (document.visibilityState === 'visible') { if (visibleSince === null) visibleSince = t }
      else if (visibleSince !== null) { visibleTotal += t - visibleSince; visibleSince = null }
      lastTick = t // time spent hidden is never a freeze, in either direction
      lastVisible = document.visibilityState === 'visible'
    } catch {}
  })

  // Composer: the first comment box (textarea[data-draft]) that is on screen. A textarea in a dialog (approval note)
  // or inside a closed card has either no business here or no layout box.
  try {
    const usable = (box: Element) => !box.closest('dialog') && box.getClientRects().length > 0
    const found = () => {
      if (composerAt === null && [...document.querySelectorAll('textarea[data-draft]')].some(usable)) { composerAt = now(); return true }
      return composerAt !== null
    }
    if (!found()) {
      const watcher = new MutationObserver(() => { try { if (found()) watcher.disconnect() } catch {} })
      watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] })
    }
  } catch {}

  observe('first-input', {}, entry => { if (!firstInput) firstInput = { at: ms(entry.startTime), delay: ms(entry.processingStart - entry.startTime) } })
  observe('event', { durationThreshold: 16 }, entry => {
    if (entry.duration > 200) slowInputs.add({ at: ms(entry.startTime), type: String(entry.name), delay: ms(entry.processingStart - entry.startTime), dur: ms(entry.duration) })
  })
  observe('longtask', {}, entry => {
    if (entry.duration <= 200) return
    const a = entry.attribution?.[0]
    // entry.name says whose task it was (self, same-origin-descendant, cross-origin-ancestor, ...).
    // containerName is a frame's own name attribute (any text), so it never leaves the page.
    const attr = [entry.name, a?.containerType, a?.name].filter(Boolean).join('/').slice(0, 80)
    longtasks.add({ at: ms(entry.startTime), dur: ms(entry.duration), attr })
  })
  observe('resource', {}, entry => {
    if (entry.duration <= 2000) return
    fetches.add({ at: ms(entry.startTime), dur: ms(entry.duration), ...resourceKind(entry), kb: ms((entry.encodedBodySize || 0) / 1024) })
  })

  // Main-thread heartbeat: a tick that arrives much later than 250 ms while the page stayed visible is a freeze.
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
