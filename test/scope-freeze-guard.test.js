// Owner: Opus (comment-latency lane, freeze fast fix, 2026-10-06). Implementers make it pass and never edit it.
// Alex (2026-10-06): "something in rails scoping in general seems to be infinitely looping or freezing". The scope page
// re-runs layout() (a forced reflow over every card) on each demo size message, re-polls a hidden tab every 2 s and
// re-stringifies the whole scope on every poll. The guards live in web/src/scope/loop-guards.ts:
// - sizeGate(apply, clock): offer(key, h) calls apply(key, h) for a real change, drops a few-px wobble back to a recent
//   value, defers a fast bounce back to the previous value and anything past 10 applies per key per second, and later
//   applies the latest deferred value, so a feedback loop runs a few layouts a second instead of one per frame and the
//   last reported size still wins.
// - pollWhileVisible(poll, every, env): no polls while the document is hidden; one poll when it shows again.
// - payloadKey(payload): when the payload carries an integer scope.revision, a string scope.updated_at and a change
//   marker (daemon mtime_ms or Rails received_at), the key never reads the rest of the scope.
import assert from 'node:assert/strict'
import test from 'node:test'
import { sizeGate, pollWhileVisible, payloadKey } from '../web/src/scope/loop-guards.ts'

function fakeClock() {
  let t = 1000
  const timers = []
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const timer = { at: t + ms, fn }; timers.push(timer); return timer },
    clearTimeout: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    advance(ms) {
      const end = t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift(); t = next.at; next.fn()
      }
      t = end
    },
  }
}

test('a demo that answers each resize with a 3 px wobble settles after one bounce', () => {
  const clock = fakeClock(), applied = [], stage = {}
  const gate = sizeGate((key, h) => applied.push(h), clock)
  let h = 520
  for (let frame = 0; frame < 120; frame++) { gate.offer(stage, h); h = h === 520 ? 523 : 520; clock.advance(16) }
  assert.ok(applied.length <= 2, `applied ${applied.length} sizes in 2 s: ${applied.slice(0, 12).join(',')}`)
})

test('a demo that flips 40 px each frame (a scrollbar loop) runs at most a few layouts a second, not 60', () => {
  const clock = fakeClock(), applied = [], stage = {}
  const gate = sizeGate((key, h) => applied.push(h), clock)
  let h = 600
  for (let frame = 0; frame < 120; frame++) { gate.offer(stage, h); h = h === 600 ? 640 : 600; clock.advance(16) }
  clock.advance(2000)
  assert.ok(applied.length <= 12, `applied ${applied.length} sizes in about 2 s`)
})

test('a demo creeping 2 px per frame stays under 10 applies a second', () => {
  const clock = fakeClock(), applied = [], stage = {}
  const gate = sizeGate((key, h) => applied.push(h), clock)
  for (let frame = 0; frame < 60; frame++) { gate.offer(stage, 400 + frame * 2); clock.advance(16) }
  assert.ok(applied.length <= 11, `applied ${applied.length} sizes in about 1 s`)
})

test('the last reported size wins: an animated growth ends at its final height', () => {
  const clock = fakeClock(), applied = [], stage = {}
  const gate = sizeGate((key, h) => applied.push(h), clock)
  for (let frame = 0; frame <= 30; frame++) { gate.offer(stage, 300 + frame * 10); clock.advance(16) }
  clock.advance(3000)
  assert.equal(applied.at(-1), 600)
})

test('ordinary changes apply at once: open, then close a second later, and the same height twice applies once', () => {
  const clock = fakeClock(), applied = [], stage = {}
  const gate = sizeGate((key, h) => applied.push(h), clock)
  gate.offer(stage, 520); gate.offer(stage, 520)
  clock.advance(1000); gate.offer(stage, 800)
  clock.advance(1000); gate.offer(stage, 520)
  assert.deepEqual(applied, [520, 800, 520])
})

test('each stage has its own budget', () => {
  const clock = fakeClock(), applied = [], a = {}, b = {}
  const gate = sizeGate((key, h) => applied.push([key === a ? 'a' : 'b', h]), clock)
  gate.offer(a, 300); gate.offer(b, 300)
  assert.deepEqual(applied, [['a', 300], ['b', 300]])
})

test('a hidden tab does not poll; it polls once on showing and then on every tick', () => {
  const ticks = [], listeners = {}, doc = { hidden: true, addEventListener: (name, fn) => { listeners[name] = fn } }
  let polls = 0
  pollWhileVisible(() => { polls++ }, 2000, { doc, setInterval: fn => { ticks.push(fn); return 1 } })
  assert.equal(ticks.length, 1)
  for (let i = 0; i < 30; i++) ticks[0]()
  assert.equal(polls, 0, 'a hidden tab polled')
  doc.hidden = false; listeners.visibilitychange()
  assert.equal(polls, 1, 'showing the tab polls at once')
  ticks[0]()
  assert.equal(polls, 2)
})

test('a tab hidden and shown between ticks still polls once on showing, every time', () => {
  const listeners = {}, doc = { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn } }
  let polls = 0
  pollWhileVisible(() => { polls++ }, 2000, { doc, setInterval: () => 1 })
  for (let i = 1; i <= 3; i++) { doc.hidden = true; listeners.visibilitychange(); doc.hidden = false; listeners.visibilitychange(); assert.equal(polls, i) }
})

test('a wobble long after the last change is a real change and applies', () => {
  const clock = fakeClock(), applied = [], stage = {}
  const gate = sizeGate((key, h) => applied.push(h), clock)
  gate.offer(stage, 520); clock.advance(5000); gate.offer(stage, 523); clock.advance(60_000); gate.offer(stage, 520)
  assert.deepEqual(applied, [520, 523, 520])
})

test('the payload key does not read the scope body when revision, updated_at and a change marker are there', () => {
  const scope = { revision: 7, updated_at: '2026-10-06T18:00:00.000Z', version: 2 }
  Object.defineProperty(scope, 'threads', { enumerable: true, get() { throw new Error('read the threads') } })
  Object.defineProperty(scope, 'doc', { enumerable: true, get() { throw new Error('read the doc') } })
  const daemon = { slug: 's', scope, error: null, mtime_ms: 1759773600000.5, notes: [], failed: [] }
  const rails = { slug: 's', received_at: '2026-10-06T18:00:01Z', data: scope, scope, notes: [], failed: [] }
  assert.equal(payloadKey(daemon), payloadKey({ ...daemon }))
  assert.equal(payloadKey(rails), payloadKey({ ...rails }))
  assert.notEqual(payloadKey(daemon), payloadKey({ ...daemon, mtime_ms: 1759773601000 }), 'a rewrite of scope.json')
  assert.notEqual(payloadKey(rails), payloadKey({ ...rails, received_at: '2026-10-06T18:00:03Z' }), 'a new relay push')
  assert.notEqual(payloadKey(daemon), payloadKey({ ...daemon, notes: [{ id: 'n1' }] }))
  assert.notEqual(payloadKey(daemon), payloadKey({ ...daemon, failed: [{ client_id: 'c1' }] }))
})

test('without those markers the key is the whole scope, so any change re-renders', () => {
  const base = { scope: { version: 2, doc: { sections: [] }, threads: [{ id: 'T1', messages: [] }] }, notes: [] }
  const changed = { ...base, scope: { ...base.scope, threads: [{ id: 'T1', messages: [{ text: 'hi' }] }] } }
  assert.notEqual(payloadKey(base), payloadKey(changed))
  const noMarker = { scope: { ...base.scope, revision: 3, updated_at: 'x' }, notes: [] }
  assert.notEqual(payloadKey(noMarker), payloadKey({ ...noMarker, scope: { ...noMarker.scope, threads: [] } }))
})
