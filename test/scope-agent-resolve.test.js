// Owner: Opus (r37, rewritten 2026-10-02 for "lanes close comments when we agree"). Implementers make it pass; they never edit it.
// Alex (2026-10-02 19:45 ET, on Lane asks cards): "maybe these work more as comments in general, with just an approve
// button ... and agents can close cards by themselves if we agree?" This supersedes r37's "a lane never closes Alex's
// comment" (2026-09-30): the card now shows who resolved it and why, and he can reopen it. Two guards stay:
// a lane says why when it closes his comment, and an answer of his that is a question never counts as a decision
// (open-factory T7, "like agent rails could make its own ui? not sure i udnerstand", was resolved as his answer).
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-30T14:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We run Sol medium for the build. Then the review.' },
]
const confused = 'like agent rails could make its own ui? not sure i udnerstand'
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: anchorInSection(sections[1], 'Then the review'), author: 'agent', kind: 'question', status: 'open', recommendation: 'Sonnet', messages: [{ from: 'agent', text: 'Who reviews?', at }], created_at: at },
    // Stored before this change: his question was saved as his own answer and waits for the lane to confirm it.
    { id: 'T2', anchor: anchorInSection(sections[1], 'Then the review'), author: 'agent', kind: 'question', status: 'resolved', recommendation: 'One copy', messages: [{ from: 'agent', text: 'One copy or two?', at }], created_at: at,
      resolution: { decision: confused, alex_words: confused, by: 'alex', how: 'own', at, confirmed_at: null, revision: null } },
  ],
}

test('a lane closes a comment once settled, says why, and can reopen it; his question is never a decision', async () => {
  const h = await startScopeHarness(scope)
  const { request, bearer } = h
  const thread = async (id) => (await request('/api/scope/demo', { headers: human })).json.scope.threads.find((t) => t.id === id)
  const post = (id, verb, body, headers = bearer) => request(`/api/scope/demo/threads/${id}/${verb}`, { method: 'POST', headers, body })
  const comment = async (quote, textValue, client_id) => {
    const posted = await request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: anchorInSection(sections[1], quote), text: textValue, client_id } })
    assert.equal(posted.status, 201, posted.text)
    return posted.json.thread.id
  }
  const cli = (...a) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...a], { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => done({ status, stdout, stderr }))
  })
  try {
    // 1. The lane answers his comment, he agrees, and the lane closes it with a reason.
    const t3 = await comment('We run Sol medium for the build', 'sol 6.1 right?', 'c-1')
    assert.equal((await post(t3, 'reply', { text: 'Yes: Sol is GPT-6.1 Sol.' })).status, 200)
    assert.equal((await post(t3, 'reply', { text: 'ok good', client_id: 'c-2' }, human)).status, 200)
    // 2026-10-03 resolve-rule: the lane passes his close words (scope-resolve-rule.test.js has the rule itself).
    const closed = await post(t3, 'resolve', { decision: 'Alex agreed: Sol is GPT-6.1 Sol.', quote: 'ok good' })
    assert.equal(closed.status, 200, closed.text)
    let t = await thread(t3)
    assert.equal(t.status, 'resolved')
    assert.deepEqual([t.resolution.by, t.resolution.decision], ['agent', 'Alex agreed: Sol is GPT-6.1 Sol.'])
    assert.equal(t.messages.at(-1).from, 'agent', 'the reason is also the lane\'s last word on the comment')

    // 2. No reason, no close: his comment stays open and the lane is told what to pass.
    const t4 = await comment('Then the review', 'who reviews the reviewer?', 'c-3')
    const bare = await post(t4, 'resolve', {})
    assert.equal(bare.status, 400)
    assert.match(bare.json.error, /--decision/)
    assert.equal((await thread(t4)).status, 'open')

    // 3. The lane reopens it from the CLI with a reason; he sees the reason on the card.
    const reopened = await cli('scope', 'reopen', 'demo', t3, '--reason', 'Reopened: the table still says Sol 6.0.')
    assert.equal(reopened.status, 0, reopened.stderr)
    assert.match(reopened.stdout, new RegExp(`reopened ${t3}`))
    t = await thread(t3)
    assert.equal(t.status, 'open'); assert.equal(t.resolution, undefined)
    assert.equal(t.messages.at(-1).text, 'Reopened: the table still says Sol 6.0.')

    // 4. Answering a lane question with a question keeps it open as his reply.
    const asked = await post('T1', 'resolve', { decision: 'what about Opus? not sure', alex_words: 'what about Opus? not sure', how: 'own', client_id: 'c-4' }, human)
    assert.equal(asked.status, 200, asked.text)
    t = await thread('T1')
    assert.equal(t.status, 'open'); assert.equal(t.resolution, undefined)
    assert.deepEqual([t.messages.at(-1).from, t.messages.at(-1).text], ['alex', 'what about Opus? not sure'])

    // 5. A question stored as his answer before this change: the lane cannot confirm it, the list flags it, and it reopens.
    const confirm = await post('T2', 'resolve', {})
    assert.equal(confirm.status, 400)
    assert.match(confirm.json.error, /scope reopen demo T2/)
    const listed = await cli('scope', 'comments', 'demo')
    assert.match(listed.stdout, /T2 resolved .*his answer is a question: unblock scope reopen demo T2/)
    assert.equal((await cli('scope', 'reopen', 'demo', 'T2')).status, 0)
    assert.equal((await thread('T2')).status, 'open')

    // 6. Unchanged: Alex closes his own comment and the lane confirms it; a lane question resolves by the lane.
    assert.equal((await post(t4, 'resolve', { decision: 'Resolved', alex_words: 'Resolved', how: 'resolve', client_id: 'c-5' }, human)).status, 200)
    assert.equal((await post(t4, 'resolve', {})).status, 200)
    assert.ok((await thread(t4)).resolution.confirmed_at)
    assert.equal((await post('T1', 'resolve', { decision: 'Sonnet reviews.' })).status, 200)
    assert.equal((await thread('T1')).resolution.by, 'agent')
  } finally { await h.close() }
})
