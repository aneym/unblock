// Scenario (owner: Opus, comment-latency P1 "Step stamps", 2026-10-06; implementers make it pass, never edit it).
// A comment took about a minute to come back and nobody could say where the minute went: Rails dropped the queue
// time once the relay took a write. Now the note for each thread's first comment carries one time per step:
// rails_queued_at and relay_seen_at (sent by the relay with the write, trusted only from the relay and only when they
// are real times), daemon_received_at, delivered_at, answer_started_at, answer_first_text_at (the responder's run),
// answered_at (the first real reply), and pushed_at (the relay, after Rails took a copy holding the answer; first one
// wins). `unblock scope latency <slug> [--since <ISO|30m|2h|1d>] [--json]` prints n, p50 and p95 per step, where each
// step is named by the stamp it ends at and runs from the nearest earlier stamp the thread has, plus a total.
//
// The lane-post stand-in is a plain JS file run by this node binary, not a freshly written executable: on 2026-10-06
// Studio's syspolicyd hung every exec of a newly written script, and this keeps the scenario independent of that.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-e2e-0123456789abcdefghijklmnopqrstuv'
const at = '2026-10-06T15:00:00Z'
const sections = [
  { id: 'title', heading: 'Step stamps', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first. Then the voice.' },
]
const on = (quote) => anchorInSection(sections[1], quote)
const STEPS = ['relay_seen', 'daemon_received', 'delivered', 'answer_started', 'answer_first_text', 'answered', 'pushed', 'total']

const work = mkdtempSync(join(tmpdir(), 'stamps-'))
writeFileSync(join(work, 'post'), `process.stdout.write('b-20261006150000-abcd\\n')\n`)
process.chdir(work)

test('the first comment of a thread carries a time for each step, and scope latency prints p50 and p95 per step', async () => {
  Object.assign(process.env, { UNBLOCK_ADMIN_RELAY_TOKEN: RELAY, UNBLOCK_SUPERVISED: '1', UNBLOCK_LANE_POST_BIN: process.execPath })
  const h = await startScopeHarness({ version: 2, slug: 'demo', title: 'Step stamps', pane: 'w5H:pT1', revision: 3, updated_at: at,
    doc: { sections }, threads: [], answerer: 'off' })
  const relay = { 'X-Unblock-Relay': RELAY }
  const post = (path, body, headers = relay) => h.request(path, { method: 'POST', headers, body })
  const first = async (thread) => (await h.request('/api/scope/demo', { headers: relay })).json.notes
    .find((note) => note.thread === thread && note.event === 'new')
  const cli = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), 'scope', 'latency', 'demo', ...args],
      { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  try {
    const now = Date.now()
    const queued = new Date(now - 5000).toISOString(), seen = new Date(now - 2000).toISOString()

    // 1. The relay's two times ride on the write; the daemon adds its own on receipt, then on delivery.
    const made = await post('/api/scope/demo/threads', { anchor: on('Then the voice'), text: 'Can voice come sooner?',
      client_id: 'adm-p1-1', rails_queued_at: queued, relay_seen_at: seen })
    assert.equal(made.status, 201)
    const id = made.json.thread.id
    await h.until(async () => typeof (await first(id))?.stamps?.delivered_at === 'string', 'delivered_at stamp')
    let stamps = (await first(id)).stamps
    assert.equal(stamps.rails_queued_at, queued)
    assert.equal(stamps.relay_seen_at, seen)
    assert.ok(Date.parse(stamps.daemon_received_at) >= now - 1000, 'daemon_received_at is the daemon\'s own time')
    assert.ok(Date.parse(stamps.delivered_at) >= Date.parse(stamps.daemon_received_at))
    assert.equal(stamps.answered_at, undefined)

    // 2. Only the relay may say when Rails queued a write, and only a real time counts; a bad one never refuses the write.
    const page = await post('/api/scope/demo/threads', { anchor: on('We build the page first'), text: 'Page first?',
      client_id: 'page-p1-2', rails_queued_at: queued, relay_seen_at: seen }, human)
    assert.equal(page.status, 201)
    const pageStamps = (await first(page.json.thread.id)).stamps
    assert.equal(pageStamps.rails_queued_at, undefined)
    assert.equal(pageStamps.relay_seen_at, undefined)
    assert.equal(typeof pageStamps.daemon_received_at, 'string')
    const junk = await post('/api/scope/demo/threads', { anchor: on('We build the page first'), text: 'And the voice?',
      client_id: 'adm-p1-3', rails_queued_at: 'yesterday', relay_seen_at: 42 })
    assert.equal(junk.status, 201)
    assert.equal((await first(junk.json.thread.id)).stamps.rails_queued_at, undefined)
    assert.equal((await first(junk.json.thread.id)).stamps.relay_seen_at, undefined)

    // 3. pushed_at is the relay's, for a thread whose answer Rails now holds; before the answer it is not taken.
    assert.equal((await post('/api/scope/demo/stamps', { pushed_at: new Date().toISOString(), threads: [id] }, h.bearer)).status, 403)
    assert.equal((await post('/api/scope/demo/stamps', { pushed_at: new Date().toISOString(), threads: [id] })).json.stamped, 0)
    assert.equal((await post(`/api/scope/demo/threads/${id}/reply`, { text: 'Yes, next week.' }, h.bearer)).status, 200)
    stamps = (await first(id)).stamps
    assert.ok(Date.parse(stamps.answered_at) >= Date.parse(stamps.delivered_at))
    const pushed = new Date().toISOString()
    assert.equal((await post('/api/scope/demo/stamps', { pushed_at: pushed, threads: [id] })).json.stamped, 1)
    assert.equal((await post('/api/scope/demo/stamps', { pushed_at: new Date(Date.now() + 9000).toISOString(), threads: [id] })).json.stamped, 0)
    assert.equal((await first(id)).stamps.pushed_at, pushed, 'the first push wins')

    // 4. A reply is not a thread's first comment and carries no stamps.
    assert.equal((await post(`/api/scope/demo/threads/${id}/reply`, { text: 'Thanks.', client_id: 'adm-p1-4' })).status, 200)
    const notes = (await h.request('/api/scope/demo', { headers: relay })).json.notes
    assert.equal(notes.find((note) => note.client_id === 'adm-p1-4').stamps, undefined)

    // 5. The report: one row per step, named by the stamp it ends at, then the total.
    const text = await cli()
    assert.equal(text.status, 0, text.stderr)
    for (const step of STEPS) assert.match(text.stdout, new RegExp(`^${step}\\s+\\d+\\s+(-|\\d+\\.\\ds)\\s+(-|\\d+\\.\\ds)\\s*$`, 'm'), `row ${step}`)
    assert.match(text.stdout, /^relay_seen\s+1\s+3\.0s\s+3\.0s\s*$/m)
    assert.match(text.stdout, /^answer_started\s+0\s+-\s+-\s*$/m)
    const json = await cli('--json')
    assert.equal(json.status, 0, json.stderr)
    const report = JSON.parse(json.stdout)
    assert.equal(report.threads, 3)
    assert.deepEqual(report.steps.map((row) => row.step), STEPS)
    const row = (step) => report.steps.find((item) => item.step === step)
    assert.deepEqual(row('relay_seen'), { step: 'relay_seen', n: 1, p50_s: 3, p95_s: 3 })
    assert.equal(row('daemon_received').n, 1)
    assert.ok(Math.abs(row('daemon_received').p50_s - 2) <= 1, `relay_seen to daemon_received is about 2 s, got ${row('daemon_received').p50_s}`)
    assert.equal(row('delivered').n, 3)
    assert.equal(row('answered').n, 1, 'a lane reply runs from delivered_at when the thread has no answer_started_at')
    assert.equal(row('pushed').n, 1)
    assert.equal(row('total').n, 3)
    assert.ok(row('total').p95_s >= 5, 'total runs from the earliest stamp (rails_queued_at) to the latest')
    assert.equal(JSON.parse((await cli('--json', '--since', '1h')).stdout).threads, 3)
    assert.equal(JSON.parse((await cli('--json', '--since', new Date(Date.now() + 60_000).toISOString())).stdout).threads, 0)
    assert.notEqual((await cli('--since', 'soon')).status, 0, 'a bad --since is refused')
  } finally { await h.close() }
})
