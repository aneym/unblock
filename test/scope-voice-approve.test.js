// Owner: Opus (r23, approve by voice). Implementers make it pass and never edit it.
// p6 (B), 2026-09-29: Alex approves a scope with a final note; the button came first (r17). By voice he says
// "approve it, ship it" or "not yet, it needs X": the session reads the approval back and sends it only on his
// yes, through the same approve route (via 'voice'). With changes and not yet need his note. An approved scope
// can't be approved twice, and a host without the route says so instead of failing silently.
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { createScopeVoiceSession, SCOPE_VOICE_PROMPT, SCOPE_VOICE_TOOLS } from '../src/scope-voice.js'

const section = { id: 'plan', heading: 'The plan', body_md: 'First choice. Second choice.' }
const open = (id) => ({ id, anchor: anchorInSection(section, 'First choice'), status: 'open', kind: 'question', recommendation: 'First', messages: [{ from: 'agent', text: 'Which?' }] })

function setup({ approval = null, threads = [open('T1'), open('T2')], postApprove = true } = {}) {
  const approvals = [], feed = [], posts = []
  const deps = {
    getScope: async () => ({ slug: 'demo', scope: { revision: 3, doc: { sections: [section] }, threads, approval } }),
    getContext: () => ({ thread: null, section: 'plan', selection: null }),
    postThread: async (body) => { posts.push(body); return { thread: { id: 'T9' } } },
    postReply: async () => ({}), postResolve: async () => ({}), postLaneNote: async () => ({}),
    onFeed: (line) => feed.push(line),
    now: () => 1_000_000,
  }
  if (postApprove) deps.postApprove = async (body) => { approvals.push(body); return { approval: { mode: body.mode } } }
  const session = createScopeVoiceSession(deps)
  return { say: (name, args) => session.handle(name, args), approvals, feed, posts }
}

test('approve_scope is a tool the model is told about', () => {
  const tool = SCOPE_VOICE_TOOLS.find((t) => t.name === 'approve_scope')
  assert.ok(tool, 'approve_scope tool')
  assert.deepEqual(tool.parameters.required, ['mode'])
  assert.deepEqual(tool.parameters.properties.mode.enum, ['approve', 'approve_with_changes', 'not_yet'])
  assert.ok(tool.parameters.properties.note, 'an optional note')
  assert.match(SCOPE_VOICE_PROMPT, /approve_scope/)
  assert.ok(SCOPE_VOICE_PROMPT.length < 2600, `prompt is ${SCOPE_VOICE_PROMPT.length}`)
})

test('approve is read back with the open-comment count and sent only on his yes', async () => {
  const { say, approvals, feed } = setup()
  const out = await say('approve_scope', { mode: 'approve', note: 'Um, ship it with the phone view first' })
  assert.equal(out.ok, true)
  assert.equal(out.speech, 'Approve this scope and move to build? 2 open questions close with the lane\'s recommendations. Your note: "Ship it with the phone view first."')
  assert.equal(approvals.length, 0, 'nothing sent before his yes')
  assert.equal(feed.at(-1).write, false)
  assert.equal(feed.at(-1).label, 'Proposed approval')
  const yes = await say('confirm')
  assert.equal(yes.speech, 'Approved. The lane moves to build.')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].mode, 'approve')
  assert.equal(approvals[0].comment, 'Ship it with the phone view first.')
  assert.equal(approvals[0].via, 'voice')
  assert.match(approvals[0].client_id, /^[0-9a-f-]{36}$/, 'a UUID so a retry never approves twice')
  assert.equal(feed.at(-1).write, true)
  assert.equal(feed.at(-1).label, 'Approved the scope')
  assert.equal((await say('confirm')).speech, 'Nothing to confirm.')
})

test('approve without a note, with no open comments, reads back simply', async () => {
  const { say, approvals } = setup({ threads: [] })
  assert.equal((await say('approve_scope', { mode: 'approve' })).speech, 'Approve this scope and move to build?')
  await say('confirm')
  assert.deepEqual(approvals.map((a) => [a.mode, a.comment]), [['approve', '']])
})

test('with changes and not yet need his note, and read it back', async () => {
  const { say, approvals } = setup()
  assert.deepEqual(await say('approve_scope', { mode: 'approve_with_changes' }), { ok: false, speech: 'What should the lane change first?' })
  assert.deepEqual(await say('approve_scope', { mode: 'not_yet', note: '' }), { ok: false, speech: "What's missing?" })
  assert.equal((await say('approve_scope', { mode: 'approve_with_changes', note: 'add the cost table' })).speech,
    'Approve with changes: "Add the cost table." The lane folds it in, then builds. Send it?')
  assert.equal((await say('confirm')).speech, 'Approved with changes.')
  const later = setup()
  assert.equal((await later.say('approve_scope', { mode: 'not_yet', note: 'it needs the cost table' })).speech, 'Not yet: "It needs the cost table." Send it?')
  assert.equal((await later.say('cancel')).speech, 'Okay, dropped.')
  assert.equal((await later.say('confirm')).speech, 'Nothing to confirm.')
  assert.equal(later.approvals.length, 0)
  await later.say('approve_scope', { mode: 'not_yet', note: 'it needs the cost table' })
  assert.equal((await later.say('confirm')).speech, 'Sent. The lane keeps scoping.')
  assert.deepEqual(approvals.map((a) => a.mode), ['approve_with_changes'])
  assert.deepEqual(later.approvals.map((a) => a.mode), ['not_yet'])
})

test('an approved scope, a half sentence and a host without the route never send', async () => {
  const done = setup({ approval: { mode: 'approve', at: '2026-09-30T01:00:00Z' } })
  assert.deepEqual(await done.say('approve_scope', { mode: 'approve' }), { ok: false, speech: 'This scope is already approved.' })
  const trial = setup({ approval: { mode: 'approve_to_try' } })
  assert.deepEqual(await trial.say('approve_scope', { mode: 'approve' }), { ok: false, speech: 'This scope is approved to try. Press Ship it when the build is ready.' })
  await trial.say('confirm')
  assert.equal(trial.approvals.length, 0)
  const half = setup()
  assert.deepEqual(await half.say('approve_scope', { mode: 'not_yet', note: 'it needs the' }), { ok: false, speech: 'Go on.' })
  const host = setup({ postApprove: false })
  assert.deepEqual(await host.say('approve_scope', { mode: 'approve' }), { ok: false, speech: "I can't approve from here. Use the Approve button." })
  for (const s of [done, half, host]) assert.equal(s.approvals.length, 0)
})

test('the spoken read-back of a comment drops comment ids and links; the filed text keeps his words', async () => {
  const { say, posts } = setup()
  const out = await say('comment', { text: 'Same as T3, see https://example.com/spec for the table' })
  assert.ok(!/https?:\/\//.test(out.speech), out.speech)
  await say('confirm')
  assert.equal(posts[0].text, 'Same as T3, see https://example.com/spec for the table.')
})
