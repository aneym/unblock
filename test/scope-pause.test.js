// Owner: Opus (r8, notes at the lane's pause). Implementers make it pass and never edit it.
// Alex (2026-09-29 17:27 ET via p6): "don't deliver each scope note to a busy lane mid-turn. Queue them and
// deliver one batch when the lane's pane goes idle/done, with the page showing them as queued."
// Alex (~17:55 ET): notes land at the pane's pause, so a short-turn lane gets them within seconds.
// Also: each doc section says when it last changed, so the page can tell "in doc" from "with the lane";
// and a lane can reword its own question (pHW: "scope edit can't reword a comment's question text").
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { human, startScopeHarness } from './scope-harness.js'

const run = promisify(execFile)
const at = '2026-09-29T21:00:00Z'
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'plan', heading: 'The plan', body_md: 'We ship the page first. Voice comes last.' }] },
  threads: [
    { id: 'T1', anchor: { section: 'plan', quote: 'Voice comes last', prefix: 'page first. ', suffix: '.' }, author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Voice last', messages: [{ from: 'agent', text: 'Should voice ship in the first cut?', at }], created_at: at },
  ],
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('notes wait for the lane to pause, then go as one batch; sections carry when they changed', async () => {
  Object.assign(process.env, { UNBLOCK_SCOPE_PAUSE_MS: '100', UNBLOCK_SCOPE_HOLD_MAX_MS: '60000' })
  const h = await startScopeHarness(v2)
  const { request, bearer, until } = h
  // A herdr that reports the pane's status from a file and logs prompts.
  const work = mkdtempSync(join(tmpdir(), 'scope-pause-'))
  const status = join(work, 'status'), log = join(work, 'prompts')
  writeFileSync(status, 'working'); writeFileSync(log, '')
  const herdr = join(work, 'herdr')
  writeFileSync(herdr, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2)
if (a[0] === 'agent' && a[1] === 'get') { const s = fs.readFileSync(${JSON.stringify(status)}, 'utf8').trim()
  if (s === 'gone') { process.stderr.write('no such agent'); process.exit(1) }
  console.log(JSON.stringify({ id: 'cli:agent:get', result: { agent: { pane_id: a[2], agent_status: s }, type: 'agent_info' } })); process.exit(0) }
if (a[0] === 'agent' && a[1] === 'prompt') { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a.slice(2)) + '\\n'); console.log('{}'); process.exit(0) }
console.log('{}')`)
  chmodSync(herdr, 0o755)
  process.env.HERDR_BIN_PATH = herdr
  const prompts = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const notes = async () => (await request('/api/scope/demo', { headers: human })).json.notes
  const say = (text, quote = 'We ship the page first') => request('/api/scope/demo/threads', { method: 'POST', headers: human,
    body: { anchor: { section: 'plan', quote, prefix: '', suffix: '' }, text } })
  try {
    const events = await h.stream('/api/scope/demo/events')

    // 1. The lane is mid-turn: Alex's notes are held, not sent, and the page is told they are held.
    assert.equal((await say('Phones first, please.')).status, 201)
    await events.next('note', (n) => n.delivery === 'held' && n.text === 'Phones first, please.')
    const reply = await request('/api/scope/demo/threads/T1/reply', { method: 'POST', headers: human, body: { text: 'Yes, voice last.' } })
    assert.equal(reply.status, 200, reply.text)
    await sleep(500)
    assert.equal(prompts().length, 0, 'nothing reaches a working pane')
    assert.deepEqual((await notes()).map((n) => n.delivery), ['held', 'held'])

    // 2. The lane pauses: both notes go in one prompt, within about a second, and are marked delivered.
    writeFileSync(status, 'idle')
    await until(async () => prompts().length === 1, 'one batched prompt at the pause')
    const [pane, line] = [prompts()[0][0], prompts()[0][1]]
    assert.equal(pane, 'w5H:pT1')
    assert.match(line, /Phones first, please\./)
    assert.match(line, /Yes, voice last\./)
    await until(async () => (await notes()).every((n) => n.delivery === 'delivered' && typeof n.delivered_at === 'string'), 'both delivered')
    await sleep(400)
    assert.equal(prompts().length, 1, 'each note is sent once')

    // 3. A pane that is done, or that herdr no longer knows, gets the next note at once.
    writeFileSync(status, 'done')
    await say('Keep it short.')
    await until(async () => prompts().length === 2, 'done pane gets the note')
    writeFileSync(status, 'gone')
    await say('One more.')
    await until(async () => prompts().length === 3, 'an unknown pane falls back to sending')

    // 4. A pane blocked on a human (a permission prompt) is never typed into; the note waits.
    writeFileSync(status, 'blocked')
    await say('Not while it asks for a permission.')
    await events.next('note', (n) => n.delivery === 'held' && n.text === 'Not while it asks for a permission.')
    await sleep(400)
    assert.equal(prompts().length, 3)
    writeFileSync(status, 'idle')
    await until(async () => prompts().length === 4, 'sent once the block clears')

    // 5. Each section says when it last changed. A lane rewrite stamps only the sections it changed.
    const first = (await request('/api/scope/demo', { headers: human })).json.scope.doc.sections
    const put = await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections: [
      { id: 'title', heading: 'Demo scope', body_md: 'A small page.', updated_at: '1999-01-01T00:00:00Z' },
      { id: 'plan', heading: 'The plan', body_md: 'We ship the page first, for phones. Voice comes last.' },
    ] } })
    assert.equal(put.status, 200, put.text)
    const next = (await request('/api/scope/demo', { headers: human })).json.scope.doc.sections
    const plan = next.find((s) => s.id === 'plan'), title = next.find((s) => s.id === 'title')
    assert.ok(Date.parse(plan.updated_at) > Date.parse(at), `plan stamped: ${plan.updated_at}`)
    assert.equal(title.updated_at, first.find((s) => s.id === 'title').updated_at, 'an unchanged section keeps its stamp; a lane cannot set it')

    // 6. A lane rewords its own question (messages[0]); Alex's words are never reworded.
    const cli = (...args) => run(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
    const edited = JSON.parse((await cli('scope', 'edit', 'demo', 'T1', '--text', 'Ship voice in the first cut?', '--json')).stdout).thread
    assert.equal(edited.messages[0].text, 'Ship voice in the first cut?')
    assert.equal(edited.messages.length, 2, 'no message is added')
    const scope = (await request('/api/scope/demo', { headers: human })).json.scope
    const alexThread = scope.threads.find((t) => t.author === 'alex')
    const refused = await request(`/api/scope/demo/threads/${alexThread.id}/edit`, { method: 'POST', headers: bearer, body: { text: 'Reworded.' } })
    assert.equal(refused.status, 400, refused.text)
    assert.equal(prompts().length, 4, 'edits never ping the pane')
    events.close()
  } finally { await h.close() }
})

test('a lane that stays busy past the hold limit still gets its notes', async () => {
  Object.assign(process.env, { UNBLOCK_SCOPE_PAUSE_MS: '100', UNBLOCK_SCOPE_HOLD_MAX_MS: '600' })
  const h = await startScopeHarness(v2)
  const work = mkdtempSync(join(tmpdir(), 'scope-hold-'))
  const log = join(work, 'prompts'); writeFileSync(log, '')
  const herdr = join(work, 'herdr')
  writeFileSync(herdr, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2)
if (a[1] === 'get') { console.log(JSON.stringify({ result: { agent: { agent_status: 'working' } } })); process.exit(0) }
if (a[1] === 'prompt') fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a.slice(2)) + '\\n')
console.log('{}')`)
  chmodSync(herdr, 0o755)
  process.env.HERDR_BIN_PATH = herdr
  try {
    const started = Date.now()
    await h.request('/api/scope/demo/threads', { method: 'POST', headers: human,
      body: { anchor: { section: 'plan', quote: 'We ship the page first', prefix: '', suffix: '' }, text: 'Still here.' } })
    await sleep(300)
    assert.equal(readFileSync(log, 'utf8'), '', 'held while under the limit')
    const deadline = Date.now() + 3000
    while (!readFileSync(log, 'utf8') && Date.now() < deadline) await sleep(50)
    assert.match(readFileSync(log, 'utf8'), /Still here\./)
    assert.ok(Date.now() - started >= 600)
  } finally {
    await h.close()
    delete process.env.UNBLOCK_SCOPE_PAUSE_MS; delete process.env.UNBLOCK_SCOPE_HOLD_MAX_MS
  }
})
