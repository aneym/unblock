// Owner: Opus (r41, Reopen and Delete). Implementers copy it to test/ and make it pass; they never edit it.
// Alex (2026-09-30 14:55 ET): "need to be able to unresovle comments, and right click to see options btw."
// The menu offers Reply, Resolve/Reopen, Copy link, Jump to text, and Delete on his own notes.
// Server: POST threads/<T>/reopen (Alex or the Admin relay; a lane gets 403) puts a resolved or parked thread back
// to open and tells the lane like a new note. POST threads/<T>/delete removes a thread Alex started (403 on a lane's
// thread or from a lane) and tells the lane. Neither needs text.
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-30T14:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We run Sol medium for the build. Then the review.' },
]
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: anchorInSection(sections[1], 'Then the review'), author: 'agent', kind: 'question', status: 'open', recommendation: 'Sonnet', messages: [{ from: 'agent', text: 'Who reviews?', at }], created_at: at },
    { id: 'T2', anchor: anchorInSection(sections[1], 'We run Sol medium'), author: 'alex', kind: 'comment', status: 'resolved', messages: [{ from: 'alex', text: 'Why Sol?', at }, { from: 'agent', text: 'Cheapest that passes.', at }], created_at: at,
      resolution: { decision: 'Resolved', alex_words: 'Resolved', by: 'alex', how: 'resolve', at, confirmed_at: at, revision: 2 } },
  ],
}

test('Alex reopens a resolved or parked thread and deletes his own note; the lane hears about both', async () => {
  const h = await startScopeHarness(scope)
  const { request, bearer } = h
  const get = async () => (await request('/api/scope/demo', { headers: human })).json
  const thread = async (id) => (await get()).scope.threads.find((t) => t.id === id)
  const post = (id, verb, body = {}, headers = human) => request(`/api/scope/demo/threads/${id}/${verb}`, { method: 'POST', headers, body })
  try {
    // 1. Reopen a resolved comment: open again, resolution gone, messages kept, a revision is not a doc revision.
    const before = (await get()).scope.revision
    assert.equal((await post('T2', 'reopen', {}, bearer)).status, 403, 'a lane cannot reopen')
    const opened = await post('T2', 'reopen', { client_id: 'c-1' })
    assert.equal(opened.status, 200, opened.text)
    let t = await thread('T2')
    assert.equal(t.status, 'open')
    assert.equal(t.resolution, undefined)
    assert.deepEqual(t.messages.map((m) => m.text), ['Why Sol?', 'Cheapest that passes.'], 'reopening adds no message')
    assert.equal((await get()).scope.revision, before, 'reopen is not a doc revision')
    const notes = (await get()).notes || []
    const note = notes.find((n) => n.thread === 'T2' && n.event === 'reopen')
    assert.ok(note, `a reopen note for the lane: ${JSON.stringify(notes.map((n) => [n.thread, n.event]))}`)
    assert.equal(note.author, 'alex')
    // Reopening an open thread is refused and changes nothing.
    const again = await post('T2', 'reopen')
    assert.equal(again.status, 400)
    assert.match(again.json.error, /only resolved or parked/i)

    // 2. Park, then reopen: a parked lane question comes back.
    assert.equal((await post('T1', 'park', { client_id: 'c-2' })).status, 200)
    assert.equal((await thread('T1')).status, 'parked')
    assert.equal((await post('T1', 'reopen', { client_id: 'c-3' })).status, 200)
    t = await thread('T1')
    assert.equal(t.status, 'open')
    assert.equal(t.parked_at, undefined)
    assert.equal(t.recommendation, 'Sonnet', 'the question keeps its recommendation')
    assert.equal((await post('T9', 'reopen')).status, 404)

    // 3. Delete: only a thread Alex started, only by Alex (or the relay).
    assert.equal((await post('T1', 'delete')).status, 403, 'a lane question is not his to delete')
    assert.equal((await post('T2', 'delete', {}, bearer)).status, 403, 'a lane cannot delete')
    const gone = await post('T2', 'delete', { client_id: 'c-4' })
    assert.equal(gone.status, 200, gone.text)
    assert.equal(await thread('T2'), undefined, 'the thread is gone from the scope')
    assert.ok(((await get()).notes || []).some((n) => n.thread === 'T2' && n.event === 'delete'), 'the lane is told')
    assert.equal((await post('T2', 'delete')).status, 404)
    // Every write still leaves a valid scope.
    assert.equal((await get()).scope.threads.length, 1)
  } finally { await h.close() }
})
