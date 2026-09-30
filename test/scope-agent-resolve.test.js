// Owner: Opus (r37, a lane never closes Alex's comment). Implementers copy it to test/ and make it pass; they never edit it.
// Alex (2026-09-30 ~09:58 ET): "i asked a question here somewhere and the comment got removed rather than responded to".
// On routing-next, pNE answered his T8 "sol 6.1 right?" and resolved it in the same second; the page hides resolved
// threads, so the question vanished with no answer seen. Rule: a lane answers Alex's comment and it stays open until
// he resolves it. A lane `resolve` on his comment records the answer and keeps it open. Lane questions still resolve.
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
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections },
  threads: [{ id: 'T1', anchor: anchorInSection(sections[1], 'Then the review'), author: 'agent', kind: 'question', status: 'open', recommendation: 'Sonnet', messages: [{ from: 'agent', text: 'Who reviews?', at }], created_at: at }],
}

test('a lane answers Alex\'s comment and it stays open; lane questions still resolve', async () => {
  const h = await startScopeHarness(scope)
  const { request, bearer } = h
  const get = async () => (await request('/api/scope/demo', { headers: human })).json
  const thread = async (id) => (await get()).scope.threads.find((t) => t.id === id)
  const resolve = (id, body, headers = bearer) => request(`/api/scope/demo/threads/${id}/resolve`, { method: 'POST', headers, body })
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
    // 1. What pNE did: reply, then resolve in the same breath. The thread stays open with the answer on it.
    const t8 = await comment('We run Sol medium for the build', 'sol 6.1 right?', 'c-1')
    assert.equal((await request(`/api/scope/demo/threads/${t8}/reply`, { method: 'POST', headers: bearer, body: { text: 'Yes: Sol is GPT-6.1 Sol. The table now says so.' } })).status, 200)
    const kept = await resolve(t8, { decision: 'Answered: Sol is GPT-6.1 Sol.' })
    assert.equal(kept.status, 200, kept.text)
    assert.equal(kept.json.kept_open, true, 'the reply says the comment stayed open')
    let t = await thread(t8)
    assert.equal(t.status, 'open', 'a lane never closes Alex\'s comment')
    assert.equal(t.resolution, undefined)
    assert.equal(t.messages.at(-1).from, 'agent')
    assert.equal(t.messages.filter((m) => m.from === 'agent').length, 1, 'the lane already answered: the decision is not added again')

    // 2. A lane resolve with no reply first: the decision becomes the lane's answer on the thread.
    const t9 = await comment('Then the review', 'who reviews the reviewer?', 'c-2')
    const answered = await resolve(t9, { decision: 'Sonnet 5.5 reviews; Opus judges a FAIL.' })
    assert.equal(answered.status, 200, answered.text)
    t = await thread(t9)
    assert.equal(t.status, 'open')
    assert.deepEqual(t.messages.map((m) => [m.from, m.text]), [['alex', 'who reviews the reviewer?'], ['agent', 'Sonnet 5.5 reviews; Opus judges a FAIL.']])
    // With no reply and no decision there is no answer to show: refused with a plain next step.
    const t10 = await comment('Then the review', 'and the budget?', 'c-3')
    const empty = await resolve(t10, {})
    assert.equal(empty.status, 400)
    assert.match(empty.json.error, /reply/i)
    assert.equal((await thread(t10)).status, 'open')

    // 3. Alex closes his own comment; the lane confirms it as before.
    const mine = await resolve(t8, { decision: 'Resolved', alex_words: 'Resolved', how: 'resolve', client_id: 'c-4' }, human)
    assert.equal(mine.status, 200, mine.text)
    t = await thread(t8)
    assert.equal(t.status, 'resolved'); assert.equal(t.resolution.by, 'alex')
    assert.equal((await resolve(t8, {})).status, 200)
    assert.ok((await thread(t8)).resolution.confirmed_at, 'the lane still confirms Alex\'s resolve')

    // 4. The lane's own question still resolves by the lane.
    const q = await resolve('T1', { decision: 'Sonnet reviews, settled in T9.' })
    assert.equal(q.status, 200, q.text)
    assert.notEqual(q.json.kept_open, true)
    t = await thread('T1')
    assert.equal(t.status, 'resolved'); assert.equal(t.resolution.by, 'agent')

    // 5. The CLI tells the lane what happened.
    const out = await cli('scope', 'resolve', 'demo', t9, '--decision', 'Sonnet 5.5 reviews.')
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, new RegExp(`answered ${t9}`))
    assert.match(out.stdout, /stays open until Alex resolves it/)
    assert.equal((await thread(t9)).status, 'open')
  } finally { await h.close() }
})
