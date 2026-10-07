// Scenario (comment-latency, prod e2e bug 2): deleting the newest comment frees its id, so the next comment is T1 again.
// The step stamps must land on that new comment's note, not stay on the deleted one's, and the relay's push must find it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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

// A responder stand-in: prints text only once release-<Q-tag> exists, then writes done-<Q-tag>.
function installHeldResponder(dir) {
  const bin = join(dir, 'held-responder')
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { prompt += c })
process.stdin.on('end', () => {
  const tags = prompt.match(/Q-\\d+/g) || ['none']
  const tag = tags[tags.length - 1]
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'started-' + tag), '')
  out({ type: 'system', subtype: 'init' })
  const wait = setInterval(() => {
    if (!fs.existsSync(path.join(${JSON.stringify(dir)}, 'release-' + tag))) return
    clearInterval(wait)
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }] } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Answer for ' + tag + '.' })
    fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'done-' + tag), '')
    process.exit(0)
  }, 20)
})
`)
  chmodSync(bin, 0o700)
  return bin
}

test('a responder that was started on a deleted comment never stamps the comment that reuses its id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamps-held-'))
  const h = await startScopeHarness({ version: 2, slug: 'demo', title: 'Reused id', pane: 'w5H:pT1', revision: 3, updated_at: at,
    doc: { sections }, threads: [] })
  Object.assign(process.env, { UNBLOCK_ADMIN_RELAY_TOKEN: RELAY, UNBLOCK_SUPERVISED: '1', UNBLOCK_LANE_POST_BIN: process.execPath,
    UNBLOCK_ANSWERER_BIN: installHeldResponder(dir), UNBLOCK_EXPLAINER_TIMEOUT_MS: '180000' })
  const relay = { 'X-Unblock-Relay': RELAY }
  const release = (tag) => writeFileSync(join(dir, `release-${tag}`), '')
  const marked = (tag, kind = 'started') => existsSync(join(dir, `${kind}-${tag}`))
  const firsts = async () => (await h.request('/api/scope/demo', { headers: relay })).json.notes.filter((note) => note.thread === 'T1' && note.event === 'new')
  try {
    const comment = async (text, client_id) => {
      const made = await h.request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: on('Then the voice'), text, client_id } })
      assert.equal(made.status, 201)
      assert.equal(made.json.thread.id, 'T1')
    }
    await comment('Q-1 can voice come sooner?', 'race-1')
    await h.until(() => marked('Q-1'), 'the first responder started')
    await h.until(async () => typeof (await firsts())[0].stamps.answer_started_at === 'string', 'its answer_started_at')
    assert.equal((await h.request('/api/scope/demo/threads/T1/delete', { method: 'POST', headers: human, body: {} })).status, 200)
    await comment('Q-2 what about the page?', 'race-2')

    // The first responder finishes its first text after its comment is gone; the new comment must not take that stamp.
    release('Q-1')
    await h.until(() => marked('Q-1', 'done'), 'the first responder finished')
    await h.until(() => marked('Q-2'), 'the second responder started')
    await h.until(async () => typeof (await firsts()).at(-1).stamps.answer_started_at === 'string', 'the new note\'s answer_started_at')
    let [oldNote, newNote] = await firsts()
    assert.equal(newNote.stamps.answer_first_text_at, undefined, 'the old run\'s first text is not the new comment\'s')
    assert.equal(oldNote.stamps.answer_first_text_at, undefined, 'a deleted comment takes no stamp either')

    // Its own run's first text lands on it.
    const before = Date.now()
    release('Q-2')
    await h.until(async () => typeof (await firsts()).at(-1).stamps.answer_first_text_at === 'string', 'the new note\'s answer_first_text_at')
    newNote = (await firsts()).at(-1)
    assert.ok(Date.parse(newNote.stamps.answer_first_text_at) >= before - 50, 'stamped by its own run, after the release')
  } finally { await h.close() }
})
