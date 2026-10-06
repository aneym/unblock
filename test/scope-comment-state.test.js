// Scenario (owner: Opus, comment-latency P4 "Chip truth", 2026-10-06; implementers make it pass, never edit it).
// The chip under Alex's comment reads the delivery state the page last got. "Answered" used to need "delivered",
// so a reply could sit under "Sending…" while the delivery state lagged, and a comment the scope's responder took
// ('answerer') showed no chip at all. Now a real reply after Alex's message always reads Answered, whatever the
// delivery state says; a comment handed to the responder reads Sent until its answer lands; a responder hand-off to
// the lane is not an answer. The rule lives in web/src/scope/comment-state.ts (pure, no DOM), which page.ts uses.
import assert from 'node:assert/strict'
import test from 'node:test'
import { commentState } from '../web/src/scope/comment-state.ts'

const t0 = '2026-10-06T15:00:00.000Z', t1 = '2026-10-06T15:00:01.000Z', t2 = '2026-10-06T15:00:20.000Z'
const anchor = { section: 'plan', quote: 'Then the voice' }
const alex = { from: 'alex', text: 'Can voice come sooner?', at: t0 }
const thread = (messages, extra = {}) => ({ id: 'T4', anchor, author: 'alex', kind: 'comment', status: 'open', messages, ...extra })
// The note's own time is a moment after the message's: the daemon stamps the message first, then writes the note.
const note = (delivery, extra = {}) => ({ id: 9, thread: 'T4', from: 'alex', event: 'new', at: t1, delivery, delivered_at: null, ...extra })
const section = { id: 'plan', heading: 'The plan', body_md: 'Then the voice.' }
const state = (n, t, seen = false) => commentState({ note: n, thread: t, section, seen })

test('a reply after Alex reads Answered even while the delivery state still says queued or held', () => {
  const replied = thread([alex, { from: 'agent', text: 'Yes, next week.', at: t2 }])
  assert.equal(state(note('queued'), replied), 'Answered')
  assert.equal(state(note('held'), replied), 'Answered')
  assert.equal(state(note('retrying'), replied), 'Answered')
  assert.equal(state(note('delivered', { delivered_at: t1 }), replied), 'Answered')
})

test('with no reply the chip follows the delivery state', () => {
  const waiting = thread([alex])
  assert.equal(state(note('queued'), waiting), 'Sending…')
  assert.equal(state(note('held'), waiting), 'Sending…')
  assert.equal(state(note('delivered', { delivered_at: t1 }), waiting), 'Sent')
  assert.equal(state(note('retrying'), waiting), 'Retrying')
  assert.equal(state(note('failed'), waiting), 'Not sent')
  assert.equal(state(note('failed'), waiting, true), 'Not sent', 'a lane seeing the thread never hides Not sent')
  assert.equal(state(note('delivered', { delivered_at: t1 }), waiting, true), 'Seen 👀')
})

test('a comment the responder took reads Sent while it answers and Answered once the answer lands', () => {
  // The responder's message carries the same time as Alex's, earlier than the note: order, not time, decides.
  const answering = thread([alex, { from: 'agent', answerer: true, pending: true, text: 'Answering…', at: t0 }])
  const answered = thread([alex, { from: 'agent', answerer: true, text: 'Next week, after the page.', at: t0 }])
  const handedOff = thread([alex, { from: 'agent', answerer: true, handoff: true, text: "Couldn't answer: sent to w5H:pT1", at: t0 }])
  assert.equal(state(note('answerer', { delivered_at: t1 }), answering), 'Sent')
  assert.equal(state(note('answerer', { delivered_at: t1 }), answered), 'Answered')
  assert.equal(state(note('answerer', { delivered_at: t1 }), handedOff), 'Sent', 'a hand-off to the lane is not an answer')
})

test('an agent message from before Alex wrote is not a reply to him', () => {
  const asked = thread([{ from: 'agent', text: 'Voice first?', at: t0 }, { ...alex, at: t1 }], { author: 'agent', kind: 'question' })
  assert.equal(state(note('queued', { at: t2 }), asked), 'Sending…')
})

test('a resolved thread the lane confirmed reads Answered', () => {
  const closed = thread([alex], { status: 'resolved', resolution: { decision: 'Voice next week', by: 'agent', at: t2, confirmed_at: t2 } })
  assert.equal(state(note('queued'), closed), 'Answered')
})

test('with no note (a Rails copy), the thread delivery field still decides', () => {
  assert.equal(state(undefined, thread([alex], { delivery: 'queued' })), 'Sending…')
  assert.equal(state(undefined, thread([alex, { from: 'agent', text: 'Done.', at: t2 }], { delivery: 'queued' })), 'Answered')
  assert.equal(state(undefined, thread([alex], { delivery: 'with_lane' })), 'Sent')
  assert.equal(state(undefined, thread([alex], { delivery: 'in_doc' })), 'Answered')
})
