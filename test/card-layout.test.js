// Owner: Opus (explainers lane for w5H:p0M, 2026-10-03). Implementers make it pass and never edit it.
// The comment rail's placement, as a pure function the scope page's layout() calls (web/src/scope/card-layout.ts).
// placeCards(slots, pivot, sortByWant) -> each card's top, in input order. slots: [{ want, height }] in rail order;
// pivot: the index that keeps its want (the composer, or the focused card; -1 = the first card); sortByWant: true
// when a detached focused card is held in place, so the rail is ordered by want (stable) before packing.
// Cards pack 10 px apart; the first card never sits above 8 px (the clamp pushes later cards down, origin/main ceb1683).
// Reviewer inputs (codex-verifier, 2026-10-03): a detached focused card sorted last dragged later cards up, and a
// queued post card appended at the end did the same.
import assert from 'node:assert/strict'
import test from 'node:test'
import { placeCards } from '../web/src/scope/card-layout.ts'

const s = (want, height) => ({ want, height })

test('main: the pivot keeps its want, earlier cards stack above it, later cards below', () => {
  assert.deepEqual(placeCards([s(80, 100), s(150, 100), s(600, 100)], 1, false), [40, 150, 600])
})

test('main: when the first card would go above 8 px it sits at 8 and later cards are pushed down', () => {
  assert.deepEqual(placeCards([s(8, 100), s(50, 100)], 1, false), [8, 118])
})

test('no pivot means the first card leads', () => {
  assert.deepEqual(placeCards([s(100, 50), s(120, 50)], -1, false), [100, 160])
})

test('a detached focused card sorted last does not drag a later card up', () => {
  // T5 (1800) then T2, detached and pinned at 80, last in doc order and the pivot.
  assert.deepEqual(placeCards([s(1800, 100), s(80, 220)], 1, true), [1800, 80])
})

test('a queued post card at the end does not pull cards above a pinned card', () => {
  const slots = [s(1800, 100), s(188, 100), s(2000, 220)] // T5, the queued card, pinned T2 (pivot)
  assert.deepEqual(placeCards(slots, 2, false), [78, 188, 2000], 'unsorted, T5 jumps (the bug)')
  assert.deepEqual(placeCards(slots, 2, true), [1800, 188, 2000], 'sorted by want, every card sits at its want')
})

test('equal wants keep rail order', () => {
  assert.deepEqual(placeCards([s(300, 100), s(300, 100)], 0, true), [300, 410])
})
