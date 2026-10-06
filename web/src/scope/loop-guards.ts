// Guards against the scope page feeding itself (Alex, 2026-10-06: "infinitely looping or freezing").
export type Clock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(timer: unknown): void }
const browserClock: Clock = { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as number) }

type SizeState = { current?: number; previous?: number; lastApply: number; recent: { h: number; at: number }[]; stamps: number[]; pending?: number; timer?: unknown }
const WOBBLE = 4, WOBBLE_MS = 2000, BOUNCE_MS = 250, WINDOW_MS = 1000, PER_WINDOW = 10

// A size reported back to the page can depend on the size the page just set (a demo sized to its own frame, a
// scrollbar that comes and goes). offer() applies real changes at once; it drops a few-px wobble back to a recent
// value, and defers a fast bounce to the previous value or anything past PER_WINDOW applies a second, applying the
// latest deferred value once allowed. A loop then costs a few layouts a second and the last report still wins.
export function sizeGate<K extends object>(apply: (key: K, h: number) => void, clock: Clock = browserClock) {
  const states = new WeakMap<K, SizeState>()
  function decide(key: K, st: SizeState, h: number) {
    if (st.current !== undefined && Math.abs(h - st.current) < .5) { st.pending = undefined; return }
    const now = clock.now()
    if (st.current !== undefined && Math.abs(h - st.current) <= WOBBLE && st.recent.some(r => r.h !== st.current && now - r.at < WOBBLE_MS && Math.abs(r.h - h) <= 1)) { st.pending = undefined; return }
    st.stamps = st.stamps.filter(s => now - s < WINDOW_MS)
    const bounceWait = st.previous !== undefined && Math.abs(h - st.previous) <= 1 ? BOUNCE_MS - (now - st.lastApply) : 0
    const rateWait = st.stamps.length >= PER_WINDOW ? st.stamps[0] + WINDOW_MS - now : 0
    const wait = Math.max(bounceWait, rateWait)
    if (wait > 0) {
      st.pending = h
      if (st.timer === undefined) st.timer = clock.setTimeout(() => { st.timer = undefined; const next = st.pending; st.pending = undefined; if (next !== undefined) decide(key, st, next) }, wait)
      return
    }
    st.pending = undefined
    st.previous = st.current; st.current = h; st.lastApply = now
    st.recent = [...st.recent, { h, at: now }].slice(-4); st.stamps.push(now)
    apply(key, h)
  }
  return {
    offer(key: K, h: number) {
      let st = states.get(key)
      if (!st) { st = { lastApply: -Infinity, recent: [], stamps: [] }; states.set(key, st) }
      decide(key, st, h)
    },
  }
}

type DemoStage = { isConnected: boolean; dataset: { embedSrc?: string }; style: { height: string } }

// The page's demo-size wiring: an accepted height is remembered by embed src at once, so a section redrawn before the
// frame starts at it; one animation frame writes every pending stage height and runs one layout. A stage that left the
// document (its section was redrawn) never touches the remembered heights, even from a deferred report.
export function demoSizes<S extends DemoStage>(heights: Map<string, number>, frame: (fn: () => void) => unknown, layout: () => void, clock: Clock = browserClock) {
  const pending = new Map<S, number>()
  let scheduled = false
  return sizeGate<S>((stage, h) => {
    if (!stage.isConnected) return
    if (stage.dataset.embedSrc) heights.set(stage.dataset.embedSrc, h)
    pending.set(stage, h)
    if (scheduled) return
    scheduled = true
    frame(() => {
      scheduled = false
      for (const [stage, h] of pending) stage.style.height = `${h}px`
      pending.clear(); layout()
    })
  }, clock)
}

// The poll path (boot.events === false): a hidden tab does not poll; it polls once each time it shows again.
export function pollWhileVisible(poll: () => void, every: number, env: { doc: Pick<Document, 'hidden' | 'addEventListener'>; setInterval(fn: () => void, ms: number): unknown } = { doc: document, setInterval: (fn, ms) => setInterval(fn, ms) }) {
  let hidden = env.doc.hidden
  env.setInterval(() => { if (!env.doc.hidden) poll() }, every)
  env.doc.addEventListener('visibilitychange', () => { const was = hidden; hidden = env.doc.hidden; if (was && !hidden) poll() })
}

// Change key for a scope payload. Every scope.json rewrite moves the daemon's mtime_ms and every relay push moves
// Rails' received_at, so with one of those plus revision and updated_at the scope body need not be stringified.
export function payloadKey(payload: { scope?: unknown; notes?: unknown; failed?: unknown; [key: string]: unknown }): string {
  const { scope, data: _data, items: _items, estimates: _estimates, ...rest } = payload
  const s = scope as { revision?: unknown; updated_at?: unknown } | null | undefined
  if (s && Number.isInteger(s.revision) && typeof s.updated_at === 'string' && (typeof rest.mtime_ms === 'number' || typeof rest.received_at === 'string'))
    return `r|${s.revision}|${s.updated_at}|${JSON.stringify(rest)}`
  return JSON.stringify({ scope, notes: payload.notes, failed: payload.failed })
}
