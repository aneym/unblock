import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const state = mkdtempSync(join(process.env.UNBLOCK_TEST_TMPDIR || tmpdir(), 'unblock-v2-'))
process.env.UNBLOCK_STATE_DIR = state
process.env.UNBLOCK_CONFIG_DIR = join(state, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
process.env.UNBLOCK_PUBLIC_ORIGIN = 'https://studio.tailnet.test:8797'
process.env.UNBLOCK_TRUSTED_PROXY = 'tailscale'
process.env.UNBLOCK_ALLOWED_USERS = 'alex@example.test'
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const token = loadOrCreateSecret()
let daemon
const auth = { Authorization: `Bearer ${token}` }
const human = { Host: 'studio.tailnet.test:8797', 'tailscale-user-login': 'alex@example.test' }
let number = 0
const base = { kind: 'file', title: 'Action', why: 'This needs your approval.', tried: ['Checked the available tools and could not do it alone.'] }
const plan = { site: 'example.com', start_url: 'https://example.com/settings/new', steps: ['Open the settings page'], changes: 'Updates a setting', untouched: 'Other settings' }
const spend = { item: 'Workspace subscription', vendor: 'Acme', vendor_url: 'https://example.com/checkout', amount_cents: 1500, cap_cents: 2000, currency: 'usd', why: 'Needed for the project' }
const message = { to: 'person@example.test', via: 'email', subject: 'Hello', text: 'Please review.' }
function shape(purpose) { return { ...base, title: `Request ${++number}`, purpose, only_you: { consent: 'their_account', spend: 'spend', message: 'message' }[purpose], ...(purpose === 'consent' ? { plan } : purpose === 'spend' ? { spend } : { message }) } }
function raw(path, { method = 'GET', headers = auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => { const bytes = Buffer.concat(chunks); let json; try { json = JSON.parse(bytes) } catch {} resolve({ status: res.statusCode, json, bytes }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const post = (path, body, headers) => raw(path, { method: 'POST', body, headers })
async function create(ask) { const result = await post('/api/asks', { ask }); assert.equal(result.status, 201, JSON.stringify(result.json)); return result.json }
async function approve(ask, values = { verdict: 'approve' }) { return post('/api/answer', { ticket: ask.ticket, revision: ask.revision, values }, human) }
function cli(...args) { return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin/unblock.js'), ...args], { env: { ...process.env, UNBLOCK_PORT: String(daemon.port), UNBLOCK_STATE_DIR: state, UNBLOCK_LINK_CLI: join(state, 'fake-link') } })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('error', reject)
  child.on('close', (status) => resolve({ status, stdout, stderr }))
}) }

test.before(async () => { daemon = await startDaemon({ port: 0 }) })
test.after(async () => { await daemon.close(); rmSync(state, { recursive: true, force: true }) })

test('filing validation and generated fields through HTTP', async () => {
  for (const [ask, match] of [
    [{ ...shape('consent'), plan: undefined }, /plan/],
    [{ ...shape('consent'), plan: { ...plan, steps: ['Click Sign out'] } }, /stay Alex's own click/],
    [{ ...shape('consent'), plan: { ...plan, start_url: 'https://accounts.google.com/settings/new', site: 'accounts.google.com' } }, /stay Alex's own click/],
    [{ ...shape('consent'), plan: { ...plan, site: 'other.com' } }, /must match/],
    [{ ...shape('consent'), fields: [{ name: 'x', type: 'text' }] }, /fields/],
    [{ ...base, title: `Block ${++number}`, only_you: 'their_account', fields: [{ name: 'ok', type: 'confirm' }], links: [{ url: 'https://example.com/settings/new' }] }, /consent_blocked_by/],
    [{ ...shape('spend'), spend: { ...spend, currency: 'eur' } }, /usd/],
    [{ ...shape('spend'), spend: { ...spend, cap_cents: 1499 } }, /cap/],
    [{ ...shape('spend'), spend: { ...spend, amount_cents: 50001, cap_cents: 50001 } }, /50000/],
  ]) { const response = await post('/api/asks', { ask }); assert.equal(response.status, 400, JSON.stringify(response.json)); assert.match(response.json.error, match) }
  const blocker = await create({ ...base, title: `Block ${++number}`, only_you: 'their_account', consent_blocked_by: 'sign_in', fields: [{ name: 'ok', type: 'confirm' }], links: [{ url: 'https://example.com/settings/new' }] })
  assert.equal(blocker.consent_blocked_by, 'sign_in')
  for (const purpose of ['consent', 'spend', 'message']) {
    const ask = await create(shape(purpose))
    assert.equal(ask.revision, 1)
    assert.deepEqual(ask.fields.map((f) => f.name), purpose === 'message' ? ['verdict', 'edited_text'] : ['verdict', 'note'])
    assert.deepEqual(ask.fields[0].choices.map((c) => c.value), purpose === 'consent' ? ['approve', 'self', 'no'] : ['approve', 'no'])
    const expected = {
      consent: [{ name: 'verdict', type: 'choice', label: 'Your call', required: true, must_decide: true, choices: [
        { value: 'approve', label: 'Approve: do it for me' }, { value: 'self', label: "I'll do it myself" }, { value: 'no', label: 'No' },
      ] }, { name: 'note', type: 'text', label: 'Anything to change in the plan', required: false }],
      spend: [{ name: 'verdict', type: 'choice', label: 'Pay this?', required: true, must_decide: true, choices: [
        { value: 'approve', label: 'Approve payment' }, { value: 'no', label: 'No' },
      ] }, { name: 'note', type: 'text', label: 'Note', required: false }],
      message: [{ name: 'verdict', type: 'choice', label: 'Send it?', required: true, must_decide: true, choices: [
        { value: 'approve', label: 'Approve and send' }, { value: 'no', label: 'No' },
      ] }, { name: 'edited_text', type: 'text', multiline: true, label: 'Your edit', required: false }],
    }
    assert.deepEqual(ask.fields, expected[purpose])
  }
})

test('human-only, strict verdict, revision, immutable answered ask', async () => {
  const ask = await create(shape('consent'))
  const path = `/api/asks/${ask.ticket}`
  assert.equal((await post(`${path}/answer`, { revision: 1, values: { verdict: 'approve' } })).json.code, 'HUMAN_ONLY')
  assert.equal((await cli('answer', ask.ticket, 'approve')).status, 4)
  await post(`${path}/draft`, { values: { note: 'typed' } })
  const updated = await post(`${path}/update`, { plan: { ...plan, changes: 'Different setting' } })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.ask.revision, 2)
  assert.deepEqual(updated.json.ask.draft, {})
  for (const [body, status, code] of [
    [{ revision: 1, values: { verdict: 'approve' } }, 409, 'STALE_REVISION'],
    [{ revision: 2, values: { verdict: null } }, 400, 'INVALID_VERDICT'],
    [{ revision: 2, values: { verdict: 'maybe' } }, 400, 'INVALID_VERDICT'],
    [{ revision: 2, values: { verdict: 'approve', note: 'change it' } }, 400, 'NOTE_MEANS_CHANGE'],
  ]) { const result = await post('/api/answer', { ticket: ask.ticket, ...body }, human); assert.equal(result.status, status); assert.equal(result.json.code, code) }
  assert.equal((await post(`${path}/update`, { add_fields: [] })).status, 400)
  const approved = await approve(updated.json.ask)
  assert.equal(approved.status, 200, JSON.stringify(approved.json))
  assert.equal(approved.json.ask.answered_via, 'tailnet:alex@example.test')
  assert.equal((await approve(updated.json.ask)).status, 409)
  assert.equal((await post(`${path}/update`, { title: 'Altered' })).status, 409)
})

test('receipts enforce scope, file bounds, and authenticated reads', async () => {
  const ask = await create(shape('consent'))
  const path = `/api/asks/${ask.ticket}/receipt`
  assert.equal((await post(path, {})).json.code, 'RECEIPT_NOT_ALLOWED')
  assert.equal((await post('/api/asks/ub_INVALID/receipt', {})).status, 400)
  await approve(ask)
  const png = join(state, 'source.png')
  writeFileSync(png, Buffer.from([137,80,78,71,13,10,26,10,0]))
  const symlink = join(state, 'symlink.png')
  symlinkSync(png, symlink)
  const invalid = join(state, 'invalid.png')
  writeFileSync(invalid, 'not png')
  const huge = join(state, 'huge.png')
  writeFileSync(huge, Buffer.alloc(5 * 1024 * 1024 + 1))
  for (const file of [symlink, invalid, huge]) assert.equal((await post(path, { before: file })).status, 400)
  const result = await post(path, { before: png, final_url: 'https://example.com/settings/new' })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  assert.equal(result.json.ask.receipt.before, true)
  const served = await raw(`${path}/before.png`)
  assert.equal(served.status, 200)
  assert.deepEqual(served.bytes, readFileSync(png))
  assert.equal((await raw(`${path}/before.png`, { headers: {} })).status, 401)
  assert.equal((await raw(`${path}/before.png`, { headers: { Host: 'evil.example' } })).status, 403)
})

test('pay claims and CLI mask card output and errors', async () => {
  writeFileSync(join(state, 'fake-link'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${join(state, 'args')}'\nif [ -f '${join(state, 'fail')}' ]; then echo sk_live_SECRET >&2; exit 1; fi\necho '{"id":"sr_test","status":"pending","number":"4242424242424242"}'\n`, { mode: 0o700 })
  const waiting = await create(shape('spend'))
  assert.equal((await cli('pay', waiting.ticket)).status, 5)
  await approve(waiting)
  const paid = await cli('pay', waiting.ticket)
  assert.equal(paid.status, 0, paid.stderr)
  assert.match(paid.stdout, /sr_test.*pending/)
  assert.doesNotMatch(paid.stdout + paid.stderr, /4242424242424242/)
  const args = readFileSync(join(state, 'args'), 'utf8')
  assert.match(args, new RegExp(`--idempotency-key\\nunblock-${waiting.ticket}-r1`))
  assert.doesNotMatch(args, /--include|--output-file/)
  assert.equal((await cli('pay', waiting.ticket)).status, 5)
  const retry = await create(shape('spend'))
  await approve(retry)
  const first = await post(`/api/asks/${retry.ticket}/pay-claim`, {})
  assert.equal(first.json.is_new, true)
  const second = await cli('pay', retry.ticket)
  assert.equal(second.status, 0, second.stderr)
  assert.match(readFileSync(join(state, 'args'), 'utf8'), new RegExp(`unblock-${retry.ticket}-r1`))
  const failing = await create(shape('spend'))
  await approve(failing)
  writeFileSync(join(state, 'fail'), '')
  const failed = await cli('pay', failing.ticket)
  assert.equal(failed.status, 1)
  assert.doesNotMatch(failed.stdout + failed.stderr, /sk_live_SECRET/)
})
