// Scenario (owner: Opus, comment-latency P4 "Chip truth", 2026-10-06; implementers make it pass, never edit it).
// Alex comments in Rails Admin. The relay posts the comment here, reads the scope straight back and sends that copy
// to Rails. The daemon used to hand the comment to the lane in the background, after it had already answered the
// relay, so the copy Rails got still said "queued" and the chip read "Sending…" until the next sync run, 36-80 s
// later. Now the daemon hands a comment to the lane (or to the scope's responder) before it answers the write, so
// the relay's read-back already says delivered. A lane-post slower than the wait cap never holds the write past it.
//
// The lane-post stand-in is a plain JS file run by this node binary, not a freshly written executable: on 2026-10-06
// Studio's syspolicyd hung every exec of a newly written script, and this keeps the scenario independent of that.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-e2e-0123456789abcdefghijklmnopqrstuv'
const at = '2026-10-06T15:00:00Z'
const sections = [
  { id: 'title', heading: 'Chip truth', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first. Then the voice.' },
]
const on = (quote) => anchorInSection(sections[1], quote)
const scope = (extra) => ({ version: 2, slug: 'demo', title: 'Chip truth', pane: 'w5H:pT1', revision: 3, updated_at: at,
  doc: { sections }, threads: [], ...extra })

// `node post --to <pane> ...` runs ./post from the daemon's cwd: it waits STUB_POST_MS, then prints a bulletin id.
const work = mkdtempSync(join(tmpdir(), 'deliver-ack-'))
writeFileSync(join(work, 'post'), `setTimeout(() => { process.stdout.write('b-20261006150000-abcd\\n') }, Number(process.env.STUB_POST_MS || 0))\n`)
process.chdir(work)

async function boot(extra, env) {
  Object.assign(process.env, { UNBLOCK_ADMIN_RELAY_TOKEN: RELAY, UNBLOCK_SUPERVISED: '1', UNBLOCK_LANE_POST_BIN: process.execPath,
    UNBLOCK_ANSWERER_BIN: '/usr/bin/false', ...env })
  const h = await startScopeHarness(scope(extra))
  const relay = { 'X-Unblock-Relay': RELAY }
  const comment = (text, client_id) => h.request('/api/scope/demo/threads', { method: 'POST', headers: relay,
    body: { anchor: on('Then the voice'), text, client_id } })
  const noteFor = async (thread) => (await h.request('/api/scope/demo', { headers: relay })).json.notes
    .filter((note) => note.thread === thread && note.from === 'alex').at(-1)
  return { h, comment, noteFor }
}

test('the relay read-back right after a comment already says delivered, with the lane bulletin', async () => {
  const { h, comment, noteFor } = await boot({ answerer: 'off' }, { STUB_POST_MS: '400', UNBLOCK_SCOPE_DELIVER_WAIT_MS: '3000' })
  try {
    const made = await comment('Can voice come sooner?', 'adm-p4-1')
    assert.equal(made.status, 201)
    const note = await noteFor(made.json.thread.id)
    assert.equal(note.delivery, 'delivered', 'the read-back must not say queued')
    assert.equal(typeof note.delivered_at, 'string')
    assert.equal(note.bulletin, 'b-20261006150000-abcd')
  } finally { await h.close() }
})

test('a lane-post slower than the wait cap never holds the write past the cap, and still delivers', async () => {
  const { h, comment, noteFor } = await boot({ answerer: 'off' }, { STUB_POST_MS: '2500', UNBLOCK_SCOPE_DELIVER_WAIT_MS: '300' })
  try {
    const started = Date.now()
    const made = await comment('Is the runner Executor?', 'adm-p4-2')
    assert.equal(made.status, 201)
    assert.ok(Date.now() - started < 1500, `the write waited ${Date.now() - started} ms; the cap is 300 ms`)
    assert.equal((await noteFor(made.json.thread.id)).delivery, 'queued')
    const deadline = Date.now() + 6000
    while (Date.now() < deadline && (await noteFor(made.json.thread.id)).delivery !== 'delivered') await new Promise((r) => setTimeout(r, 50))
    assert.equal((await noteFor(made.json.thread.id)).delivery, 'delivered')
  } finally { await h.close() }
})

test('a comment the responder takes reads back as handed over, with a delivered time', async () => {
  const { h, comment, noteFor } = await boot({ answerer: 'on' }, { STUB_POST_MS: '0' })
  try {
    const made = await comment('What does the voice need?', 'adm-p4-3')
    assert.equal(made.status, 201)
    const note = await noteFor(made.json.thread.id)
    assert.equal(note.delivery, 'answerer')
    assert.equal(typeof note.delivered_at, 'string', 'a comment handed to the responder has a delivered time')
  } finally { await h.close() }
})
