// The chip rule (web/src/scope/comment-state.ts) is a pure decision table; the owner scenario is
// test/scope-comment-state.test.js. These rows guard two regressions a reviewer found (2026-10-06): a take or reopen
// adds no message of Alex's, so an older reply must not read as its answer; and a section edit only answers a comment
// after the comment reached the lane.
import assert from 'node:assert/strict'
import test from 'node:test'
import { commentState } from '../web/src/scope/comment-state.ts'

const t0 = '2026-10-06T15:00:00.000Z', t1 = '2026-10-06T15:00:10.000Z', t2 = '2026-10-06T15:00:20.000Z', t3 = '2026-10-06T15:00:30.000Z'
const anchor = { section: 'plan', quote: 'Then the voice' }
const thread = (messages, extra = {}) => ({ id: 'T4', anchor, author: 'alex', kind: 'comment', status: 'open', messages, ...extra })
const note = (event, delivery, extra = {}) => ({ id: 9, thread: 'T4', from: 'alex', event, at: t2, delivery, delivered_at: null, ...extra })
const replied = thread([{ from: 'alex', text: 'Voice sooner?', at: t0 }, { from: 'agent', text: 'Next week.', at: t1 }])
const asked = thread([{ from: 'alex', text: 'Voice sooner?', at: t0 }])
const plain = { id: 'plan', heading: 'The plan', body_md: 'Then the voice.' }
const edited = { ...plain, updated_at: t1 }

for (const [name, input, chip] of [
  ['a reopen after an old reply is still on its way', { note: note('reopen', 'queued'), thread: replied, section: plain }, 'Sending…'],
  ['a take after an old reply is still on its way', { note: note('take', 'held'), thread: replied, section: plain }, 'Sending…'],
  ['a reply after the reopen answers it', { note: note('reopen', 'delivered', { delivered_at: t2 }), thread: thread([...replied.messages, { from: 'agent', text: 'Reopened.', at: t3 }]), section: plain }, 'Answered'],
  ['a section edit before delivery is not an answer', { note: note('new', 'delivered', { at: t0, delivered_at: t3 }), thread: asked, section: edited }, 'Sent'],
  ['a section edit never hides Not sent', { note: note('new', 'failed', { at: t0 }), thread: asked, section: edited }, 'Not sent'],
  ['a park after an old reply is not answered by it', { note: note('park', 'delivered', { delivered_at: t2 }), thread: replied, section: plain }, 'Sent'],
  ['an unconfirmed resolve after an old reply is still on its way', { note: note('resolve', 'queued'), thread: { ...replied, status: 'resolved', resolution: { decision: 'Later', by: 'alex', at: t2, confirmed_at: null } }, section: plain }, 'Sending…'],
  ['a reply that reopens a thread is answered by the responder, stamped with his time', { note: note('reopen', 'answerer', { text: 'And audio?', delivered_at: t2 }), thread: thread([...replied.messages, { from: 'alex', text: 'And audio?', at: t2 }, { from: 'agent', answerer: true, text: 'Audio too.', at: t2 }]), section: plain }, 'Answered'],
  ['with no note, a section edit after his message answers it', { note: undefined, thread: { ...asked, delivery: 'with_lane' }, section: edited }, 'Answered'],
  ['a section edit after delivery answers it', { note: note('new', 'delivered', { at: t0, delivered_at: t0 }), thread: asked, section: edited }, 'Answered'],
]) test(name, () => assert.equal(commentState({ seen: false, ...input }), chip))
