// Owner: Opus (r28, passkeys removed). Implementers make it pass and never edit it.
// Alex (2026-09-30 ~02:50Z): "remove passkey stuff from unblock, dont want or need that right now".
// Consent, message and permission asks approve with a plain click, on the tailnet page and on a share link,
// with no assertion. The passkey routes are gone. The agent's bearer still can't answer for Alex.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const state = mkdtempSync(join(tmpdir(), 'unblock-click-'))
Object.assign(process.env, {
  UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: join(state, 'config'), UNBLOCK_SECRET_BACKEND: 'env',
  UNBLOCK_PUBLIC_ORIGIN: 'https://studio.tailnet.test:8797', UNBLOCK_TRUSTED_PROXY: 'tailscale', UNBLOCK_ALLOWED_USERS: 'alex@example.test',
})
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const bearer = { Authorization: `Bearer ${loadOrCreateSecret()}` }
const human = { Host: 'studio.tailnet.test:8797', 'tailscale-user-login': 'alex@example.test' }
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
const base = { kind: 'file', why: 'This needs your approval.', tried: ['Checked the available tools and could not do it alone.'] }
const asks = {
  consent: () => ({ ...base, title: `Consent ${++number}`, purpose: 'consent', only_you: 'their_account', plan: { site: 'example.com', start_url: 'https://example.com/settings/new', steps: ['Open the settings page'], changes: 'Updates a setting', untouched: 'Other settings' } }),
  message: () => ({ ...base, title: `Message ${++number}`, purpose: 'message', only_you: 'message', message: { to: 'person@example.test', via: 'email', subject: 'Hello', text: 'Please review.' } }),
  permission: () => ({ kind: 'file', title: `Permission ${++number}`, purpose: 'permission', why: 'This operation needs a person.', permission: { tool: 'Bash', command: 'cat /Users/alex/project', summary: 'Read a project file' } }),
}
const verdicts = { consent: 'approve', message: 'approve', permission: 'allow_once' }
async function create(purpose) { const r = await post('/api/asks', { ask: asks[purpose]() }, bearer); assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json }

test.before(async () => { daemon = await startDaemon({ port: 0 }) })
test.after(async () => { await daemon.close(); rmSync(state, { recursive: true, force: true }) })

test('consent, message and permission asks approve with a plain click on the page, no passkey', async () => {
  for (const purpose of Object.keys(asks)) {
    const ask = await create(purpose)
    const bot = await post('/api/answer', { ticket: ask.ticket, revision: ask.revision, values: { verdict: verdicts[purpose] } }, bearer)
    assert.equal(bot.status, 403, `${purpose}: the agent's bearer never answers for Alex`)
    const click = await post('/api/answer', { ticket: ask.ticket, revision: ask.revision, values: { verdict: verdicts[purpose] } }, human)
    assert.equal(click.status, 200, `${purpose}: ${JSON.stringify(click.json)}`)
    assert.equal(click.json.ask.answers.verdict, verdicts[purpose])
    assert.ok(!String(click.json.ask.answered_via ?? '').startsWith('passkey'), `${purpose}: answered_via is not a passkey`)
  }
})

test('the same asks approve through a share link Alex made, no passkey', async () => {
  for (const purpose of Object.keys(asks)) {
    const ask = await create(purpose)
    const link = await post('/api/links', { ticket: ask.ticket }, human)
    assert.equal(link.status, 201, JSON.stringify(link.json))
    const click = await post(`/u/${link.json.token}/api/answer`, { ticket: ask.ticket, revision: ask.revision, values: { verdict: verdicts[purpose] } }, {})
    assert.equal(click.status, 200, `${purpose}: ${JSON.stringify(click.json)}`)
    assert.equal(click.json.ask.answers.verdict, verdicts[purpose])
  }
})

test('passkey routes and code are gone', async () => {
  for (const path of ['/api/passkeys', '/api/passkeys/enroll/options', '/api/passkeys/approve/options']) {
    const r = await raw(path, { headers: human })
    assert.equal(r.status, 404, `${path} should be gone`)
  }
  for (const file of ['src/passkey.js', 'src/webauthn.js', 'web/src/lib/passkey.ts']) assert.ok(!existsSync(join(import.meta.dirname, '..', file)), `${file} should be deleted`)
})
