// Owner: Opus (r32, pJ0 TO-pHY-11). Implementers make it pass and never edit it.
// Alex (2026-09-30 09:03 ET via pJ0): unblock asks show in Development area and he answers them there. Admin queues the
// answer; the Studio relay (X-Unblock-Relay, loopback only) posts it to POST /api/asks/<ticket>/answer. The relay
// answers as Alex in Admin, like the page does, with three extra rules: it never carries a secret or paste value
// (Admin never collects them), it answers only an open ask at the revision Admin showed, and it can't bounce.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const RELAY = 'relay-asks-0123456789abcdefghijklmnopqrstuv'
const state = mkdtempSync(join(tmpdir(), 'unblock-relay-ask-'))
Object.assign(process.env, {
  UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: join(state, 'config'), UNBLOCK_SECRET_BACKEND: 'env',
  UNBLOCK_PUBLIC_ORIGIN: 'https://studio.tailnet.test:8797', UNBLOCK_TRUSTED_PROXY: 'tailscale', UNBLOCK_ALLOWED_USERS: 'alex@example.test',
  UNBLOCK_ADMIN_RELAY_TOKEN: RELAY,
})
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const bearer = { Authorization: `Bearer ${loadOrCreateSecret()}` }
const relay = { 'X-Unblock-Relay': RELAY }
let daemon, number = 0

function raw(path, { method = 'GET', headers = bearer, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks)) } catch {} resolve({ status: res.statusCode, json }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const post = (path, body, headers) => raw(path, { method: 'POST', body, headers })
const tried = ['Checked the available tools and could not do it alone.']
const question = () => ({ kind: 'file', purpose: 'question', title: `Region ${++number}`, why: 'The deploy needs a region.', tried,
  fields: [{ name: 'region', label: 'Region', type: 'choice', choices: [{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }] }, { name: 'note', label: 'Anything else', type: 'text', required: false }] })
const withSecret = () => ({ kind: 'file', purpose: 'blocker', title: `Key ${++number}`, why: 'The service needs its key.', tried, only_you: 'credential', links: [{ label: 'API keys', url: 'https://dashboard.example.test/settings/api-keys' }],
  fields: [{ name: 'api_key', label: 'API key', type: 'secret', env_name: 'SERVICE_API_KEY' }, { name: 'ready', label: 'Ready to go on', type: 'confirm' }] })
const withPaste = () => ({ kind: 'file', purpose: 'blocker', title: `Paste ${++number}`, why: 'I need the output of a command only you can run.', tried, only_you: 'credential', links: [{ label: 'Keychain', url: 'https://developer.example.test/account/resources/certificates/list' }],
  fields: [{ name: 'out', label: 'Output', type: 'paste', command: 'security find-identity -v -p codesigning' }] })
const message = () => ({ kind: 'file', purpose: 'message', title: `Message ${++number}`, why: 'This needs your approval.', tried, only_you: 'message',
  message: { to: 'person@example.test', via: 'email', subject: 'Hello', text: 'Please review.' } })
async function create(ask) { const r = await post('/api/asks', { ask }, bearer); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json }
let cid = 0
const answer = (ask, extra = {}) => post(`/api/asks/${ask.ticket}/answer`, { revision: ask.revision, via: 'admin', client_id: `adm-${++cid}`, ...extra }, relay)

test.before(async () => { daemon = await startDaemon({ port: 0 }) })
test.after(async () => { await daemon.close(); rmSync(state, { recursive: true, force: true }) })

test('the relay answers an open ask as Alex in Admin', async () => {
  const ask = await create(question())
  const r = await answer(ask, { values: { region: 'eu', note: 'EU for GDPR.' }, reply: 'Thanks.' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ask.answers.region, 'eu')
  assert.match(String(r.json.ask.answered_via), /^admin\b/, 'recorded as answered in Admin')
  const read = await raw(`/api/asks/${ask.ticket}`, { headers: bearer })
  assert.equal(read.json.answers.region, 'eu')
})

test('an approval answers from Admin the way a click on the page does', async () => {
  const ask = await create(message())
  const r = await answer(ask, { values: { verdict: 'approve' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.ask.answers.verdict, 'approve')
  assert.match(String(r.json.ask.answered_via), /^admin\b/)
})

test('the relay never carries a secret or a paste value, even an empty one', async () => {
  const s = await create(withSecret())
  for (const value of ['sk-live-abc', '']) {
    const r = await answer(s, { values: { api_key: value, ready: true } })
    assert.equal(r.status, 400, JSON.stringify(r.json))
    assert.equal(r.json.code, 'RELAY_NO_SECRETS')
  }
  const p = await create(withPaste())
  const r = await answer(p, { values: { out: '1) ABCD "Developer ID"' } })
  assert.equal(r.status, 400)
  assert.equal(r.json.code, 'RELAY_NO_SECRETS')
  assert.equal((await raw(`/api/asks/${s.ticket}`, { headers: bearer })).json.status, 'open', 'a refused answer changes nothing')
  assert.equal((await raw(`/api/asks/${p.ticket}`, { headers: bearer })).json.status, 'open')
})

test('a stale or settled ask is a 409 the relay drops; a repeat never writes twice', async () => {
  const ask = await create(question())
  const stale = await answer(ask, { revision: ask.revision + 1, values: { region: 'us' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.code, 'STALE_REVISION')
  const first = await answer(ask, { values: { region: 'us' } })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  const again = await answer(ask, { values: { region: 'eu' } })
  assert.equal(again.status, 409, 'an ask already answered is settled for the relay')
  assert.equal((await raw(`/api/asks/${ask.ticket}`, { headers: bearer })).json.answers.region, 'us')
})

test('the relay body is exactly values, reply, revision, via admin and a client_id; nothing else opens', async () => {
  const ask = await create(question())
  const ok = { values: { region: 'us' } }
  assert.equal((await answer(ask, { ...ok, bounce: true, reply: 'Wrong ask.' })).status, 400, 'no bounce from Admin')
  assert.equal((await answer(ask, { ...ok, field_bounce: { region: 'why?' } })).status, 400)
  assert.equal((await answer(ask, { ...ok, via: 'voice' })).status, 400)
  assert.equal((await answer(ask, { ...ok, client_id: 'bad id!' })).status, 400)
  assert.equal((await post(`/api/asks/${ask.ticket}/answer`, { ...ok, revision: ask.revision, via: 'admin' }, relay)).status, 400, 'client_id required')
  assert.equal((await raw(`/api/asks/${ask.ticket}`, { headers: bearer })).json.status, 'open')
  // Still closed to the relay: the flat answer route, drafts, reading or filing asks.
  assert.equal((await post('/api/answer', { ticket: ask.ticket, revision: ask.revision, values: ok.values }, relay)).status, 403)
  assert.equal((await post(`/api/asks/${ask.ticket}/draft`, { values: ok.values }, relay)).status, 403)
  assert.equal((await raw('/api/asks', { headers: relay })).status, 403)
  assert.equal((await raw(`/api/asks/${ask.ticket}`, { headers: relay })).status, 403)
  assert.equal((await post('/api/asks', { ask: question() }, relay)).status, 403)
})
