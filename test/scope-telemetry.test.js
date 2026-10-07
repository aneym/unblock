// Scenario for the comment-latency freeze telemetry piece (written by Opus; the implementer may not edit it).
// The scope page beacons a compact summary of its own load to the daemon, which appends it to
// scope-telemetry.jsonl under its state dir. Over 16 KB is refused; a stranger is refused.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const initial = { slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', updated_at: new Date().toISOString(), plan_md: 'Initial plan' }
const report = { v: 1, reason: 'pagehide', since_load_ms: 61000, mode: 'events', doc_rendered_ms: 1234, composer_ready_ms: 1300,
  longtasks: { n: 1, total_ms: 2500, max_ms: 2500, top: [{ at: 3000, dur: 2500, attr: 'self' }] } }

test('the scope page telemetry lands in the daemon jsonl and oversize or stranger posts do not', async () => {
  const h = await startScopeHarness(initial)
  const file = join(process.env.UNBLOCK_STATE_DIR, 'scope-telemetry.jsonl')
  try {
    const ok = await h.request('/api/scope/demo/telemetry', { method: 'POST', headers: { ...human, 'User-Agent': 'Scenario UA' }, body: report })
    assert.equal(ok.status, 204, ok.text)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].slug, 'demo')
    assert.equal(lines[0].ua, 'Scenario UA')
    assert.deepEqual(lines[0].report, report)
    assert.ok(!Number.isNaN(Date.parse(lines[0].at)))

    const big = await h.request('/api/scope/demo/telemetry', { method: 'POST', headers: human, body: { ...report, pad: 'x'.repeat(16 * 1024) } })
    assert.equal(big.status, 413)
    const stranger = await h.request('/api/scope/demo/telemetry', { method: 'POST', body: report })
    assert.ok([401, 403].includes(stranger.status), String(stranger.status))
    const missing = await h.request('/api/scope/nope/telemetry', { method: 'POST', headers: human, body: report })
    assert.equal(missing.status, 404)
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1)
  } finally {
    await h.close()
  }
})

// Unit cases for web/src/scope/telemetry.ts, run against fake browser globals.
function fakeBrowser({ origin = 'https://scope.example' } = {}) {
  const saved = {}
  const set = (name, value) => { saved[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }) }
  const b = { now: 1000, hidden: false, textareas: [], observers: {}, mutation: null, intervals: [], listeners: {}, docListeners: {}, sent: [] }
  const doc = {
    get visibilityState() { return b.hidden ? 'hidden' : 'visible' },
    documentElement: {},
    addEventListener: (type, fn) => { b.docListeners[type] = fn },
    querySelector: sel => (sel === 'textarea' ? b.textareas[0] || null : null),
    querySelectorAll: sel => (sel === 'textarea[data-draft]' ? b.textareas.filter(t => t.draft) : sel === 'textarea' ? b.textareas : []),
  }
  set('document', doc)
  set('location', { origin })
  set('performance', { now: () => b.now, getEntriesByType: () => [] })
  set('PerformanceObserver', Object.assign(class { constructor(fn) { this.fn = fn } observe({ type }) { b.observers[type] = this.fn } }, { supportedEntryTypes: ['longtask', 'resource', 'event', 'first-input'] }))
  set('MutationObserver', class { constructor(fn) { b.mutation = fn } observe() {} disconnect() { b.mutation = null } })
  set('setInterval', fn => { b.intervals.push(fn); return 1 })
  set('setTimeout', () => 1)
  set('addEventListener', (type, fn) => { b.listeners[type] = fn })
  set('navigator', { sendBeacon: (url, blob) => { b.sent.push(blob); return true } })
  b.entries = (type, list) => b.observers[type]({ getEntries: () => list })
  b.hide = (hidden) => { b.hidden = hidden; b.docListeners.visibilitychange() }
  b.tick = () => b.intervals[0]()
  b.textarea = ({ draft = true, dialog = false, box = true } = {}) => ({ draft, closest: sel => (sel === 'dialog' && dialog ? {} : null), getClientRects: () => ({ length: box ? 1 : 0 }) })
  b.report = async () => { b.listeners.pagehide(); return JSON.parse(await b.sent.at(-1).text()) }
  b.restore = () => { for (const [name, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, name, d); else delete globalThis[name] } }
  return b
}

async function withTelemetry(setup, run) {
  const { startTelemetry } = await import('../web/src/scope/telemetry.ts')
  const b = fakeBrowser()
  try {
    setup?.(b)
    const telemetry = startTelemetry({ url: '/telemetry', mode: 'events' })
    return await run(b, telemetry)
  } finally {
    b.restore()
  }
}

test('a slow resource is reported by kind and origin, never by any part of its URL', () => withTelemetry(null, async b => {
  b.entries('resource', [
    { name: 'https://rails.so/patients/Alice-Smith/scan.mp4?token=Alice', initiatorType: 'fetch', startTime: 10, duration: 5000, encodedBodySize: 2048 },
    { name: 'https://scope.example/w/api/scope/demo/doc', initiatorType: 'fetch', startTime: 20, duration: 3000, encodedBodySize: 1024 },
    { name: 'https://scope.example/assets/app.js', initiatorType: 'script', startTime: 30, duration: 2500, encodedBodySize: 1024 },
  ])
  const raw = JSON.stringify(await b.report())
  assert.ok(!raw.includes('Alice'), raw)
  assert.ok(!raw.includes('patients') && !raw.includes('scan.mp4') && !raw.includes('/w/api'), raw)
  const top = (await b.report()).slow_fetches.top
  assert.deepEqual(top.map(f => [f.kind, f.origin]), [['media', 'cross'], ['api', 'self'], ['script', 'self']])
  assert.ok(top.every(f => !('path' in f)))
}))

test('a self long task and a cross-origin-ancestor long task are told apart', () => withTelemetry(null, async b => {
  b.entries('longtask', [
    { name: 'self', startTime: 100, duration: 500, attribution: [{ containerType: 'window', name: 'unknown' }] },
    { name: 'cross-origin-ancestor', startTime: 900, duration: 400, attribution: [{ containerType: 'window', name: 'unknown' }] },
  ])
  const [first, second] = (await b.report()).longtasks.top
  assert.ok(first.attr.startsWith('self'), first.attr)
  assert.ok(second.attr.startsWith('cross-origin-ancestor'), second.attr)
  assert.notEqual(first.attr, second.attr)
}))

test('time spent hidden is not a freeze, but a long stall while visible still is', () => withTelemetry(null, async b => {
  b.now = 1250; b.tick()
  b.now = 1500; b.hide(true)
  b.now = 21500; b.hide(false)
  b.now = 21750; b.tick()
  assert.equal((await b.report()).gaps.n, 0)
  b.now = 24000; b.tick()
  const gaps = (await b.report()).gaps
  assert.equal(gaps.n, 1)
  assert.ok(gaps.max_ms > 1000)
}))

test('only a visible comment composer sets composer_ready_ms', () => withTelemetry(null, async (b) => {
  b.textareas.push(b.textarea({ draft: false, dialog: true, box: false }))
  b.mutation()
  assert.equal((await b.report()).composer_ready_ms, null)
  b.textareas.push(b.textarea({ box: false }))
  b.mutation()
  assert.equal((await b.report()).composer_ready_ms, null)
  b.textareas.push(b.textarea({ dialog: true }))
  b.mutation()
  assert.equal((await b.report()).composer_ready_ms, null)
  b.now = 3000
  b.textareas.push(b.textarea())
  b.mutation()
  assert.equal((await b.report()).composer_ready_ms, 3000)
}))
