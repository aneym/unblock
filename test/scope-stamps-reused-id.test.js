// Scenario (comment-latency, prod e2e bug 2): deleting the newest comment frees its id, so the next comment is T1 again.
// The step stamps must land on that new comment's note, not stay on the deleted one's, and the relay's push must find it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-e2e-0123456789abcdefghijklmnopqrstuv'
const at = '2026-10-06T15:00:00Z'
const sections = [
  { id: 'title', heading: 'Reused id', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first. Then the voice.' },
]
const on = (quote) => anchorInSection(sections[1], quote)

const work = mkdtempSync(join(tmpdir(), 'stamps-reused-'))
writeFileSync(join(work, 'post'), `process.stdout.write('b-20261006150000-abcd\\n')\n`)
process.chdir(work)

test('a comment that reuses a deleted comment\'s id gets its own step stamps and shows in the relay push', async () => {
  Object.assign(process.env, { UNBLOCK_ADMIN_RELAY_TOKEN: RELAY, UNBLOCK_SUPERVISED: '1', UNBLOCK_LANE_POST_BIN: process.execPath })
  const h = await startScopeHarness({ version: 2, slug: 'demo', title: 'Reused id', pane: 'w5H:pT1', revision: 3, updated_at: at,
    doc: { sections }, threads: [], answerer: 'off' })
  const relay = { 'X-Unblock-Relay': RELAY }
  const post = (path, body, headers = relay) => h.request(path, { method: 'POST', headers, body })
  const notes = async () => (await h.request('/api/scope/demo', { headers: relay })).json.notes
  const firsts = async (thread) => (await notes()).filter((note) => note.thread === thread && note.event === 'new')
  try {
    const comment = async (text, client_id) => {
      const made = await post('/api/scope/demo/threads', { anchor: on('Then the voice'), text, client_id }, human)
      assert.equal(made.status, 201)
      return made.json.thread.id
    }

    // 1. The first T1 is answered, then deleted.
    const old = await comment('Can voice come sooner?', 'page-reuse-1')
    assert.equal(old, 'T1')
    assert.equal((await post(`/api/scope/demo/threads/${old}/reply`, { text: 'Yes, next week.' }, h.bearer)).status, 200)
    assert.equal(typeof (await firsts(old))[0].stamps.answered_at, 'string')
    assert.equal((await post(`/api/scope/demo/threads/${old}/delete`, {}, human)).status, 200)

    // 2. A deleted thread takes no stamps: the relay's push finds nothing.
    assert.equal((await post('/api/scope/demo/stamps', { pushed_at: new Date().toISOString(), threads: [old] })).json.stamped, 0)

    // 3. The next comment reuses the id and starts clean.
    const reused = await comment('What about the page?', 'page-reuse-2')
    assert.equal(reused, old, 'the id is reused')
    await h.until(async () => (await firsts(reused)).length === 2, 'both notes')
    const [oldNote, newNote] = await firsts(reused)
    assert.equal(newNote.stamps.answered_at, undefined, 'the new note does not inherit the old note\'s answer')
    assert.equal(typeof newNote.stamps.daemon_received_at, 'string')

    // 4. Its answer and push land on the new note and leave the old one alone.
    assert.equal((await post(`/api/scope/demo/threads/${reused}/reply`, { text: 'Page first.' }, h.bearer)).status, 200)
    const pushed = new Date().toISOString()
    assert.equal((await post('/api/scope/demo/stamps', { pushed_at: pushed, threads: [reused] })).json.stamped, 1)
    const [oldAfter, newAfter] = await firsts(reused)
    assert.equal(typeof newAfter.stamps.answered_at, 'string')
    assert.equal(newAfter.stamps.pushed_at, pushed)
    assert.deepEqual(oldAfter.stamps, oldNote.stamps, 'the deleted comment\'s stamps are untouched')
  } finally { await h.close() }
})
