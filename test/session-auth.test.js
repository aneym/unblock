// Local session auth: a full login wall that never depends on Tailscale or a
// capability link, while the approval gate stays exactly as strong — the
// bearer still cannot answer consent/spend/message/permission asks, but a
// signed-in human session can.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const state = mkdtempSync(join(process.env.UNBLOCK_TEST_TMPDIR || tmpdir(), 'unblock-session-'))
process.env.UNBLOCK_STATE_DIR = state
process.env.UNBLOCK_CONFIG_DIR = join(state, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
delete process.env.UNBLOCK_PUBLIC_ORIGIN
delete process.env.UNBLOCK_TRUSTED_PROXY

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const auth = await import('../src/auth.js')
const bearer = { authorization: `Bearer ${loadOrCreateSecret()}` }
const PASSPHRASE = 'correct horse battery'
let daemon, base, number = 0

async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await response.json() } catch { /* not every response is JSON */ }
  return { status: response.status, json, setCookie: response.headers.get('set-cookie') }
}
const asSession = (cookie) => ({ headers: { cookie } })
const cookieOf = (result) => result.setCookie.split(';')[0]

function cli(...args) {
  return spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, UNBLOCK_STATE_DIR: state },
  })
}

test.before(async () => {
  daemon = await startDaemon({ port: 0 })
  base = `http://127.0.0.1:${daemon.port}`
})
test.after(async () => {
  await daemon.close()
  rmSync(state, { recursive: true, force: true })
})

test('the wall: the shell loads, the API does not, until a session exists', async () => {
  const before = await call('/api/session')
  assert.equal(before.status, 200)
  assert.deepEqual(before.json, { configured: false, authenticated: false, viewer: null })

  // Setup never runs over HTTP: no process can claim the credential by
  // racing the first request.
  const raced = await call('/api/session', { method: 'POST', body: { passphrase: 'attacker-guess' } })
  assert.equal(raced.status, 409)
  assert.equal(raced.json.code, 'NO_PASSPHRASE')

  // The React shell itself is not secret — it must load so the sign-in
  // screen can render — but every queue call behind it is refused.
  const page = await call('/')
  assert.equal(page.status, 200)
  const closed = await call('/api/asks')
  assert.equal(closed.status, 401)
  assert.equal(closed.json.error, 'unauthorized')
  assert.equal(closed.json.code, 'UNAUTHORIZED')

  // The agent's bearer keeps its API: the wall gates people, not agents.
  assert.equal((await call('/api/asks', { headers: bearer })).status, 200)

  // CLI: status works everywhere; setup refuses anything but a TTY.
  assert.match(cli('auth', 'status').stdout, /no passphrase configured/)
  const nonTty = cli('auth', 'setup')
  assert.notEqual(nonTty.status, 0)
  assert.match(nonTty.stderr, /interactive terminal/)
})

test('sign-in: passphrase exchanges for an HttpOnly session, rate limited', async () => {
  auth.configurePassphrase(PASSPHRASE)
  assert.equal(auth.isConfigured(), true)
  assert.match(cli('auth', 'status').stdout, /passphrase configured/)

  const wrong = await call('/api/session', { method: 'POST', body: { passphrase: 'not it' } })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.json.code, 'BAD_PASSPHRASE')

  for (let i = 0; i < 4; i += 1) {
    assert.equal((await call('/api/session', { method: 'POST', body: { passphrase: 'still not it' } })).status, 401)
  }
  const locked = await call('/api/session', { method: 'POST', body: { passphrase: PASSPHRASE } })
  assert.equal(locked.status, 429)
  assert.equal(locked.json.code, 'RATE_LIMITED')
  auth.resetLoginFailures()

  const signedIn = await call('/api/session', { method: 'POST', body: { passphrase: PASSPHRASE } })
  assert.equal(signedIn.status, 200)
  assert.equal(signedIn.json.authenticated, true)
  assert.ok(signedIn.json.viewer.login, 'the session carries a viewer')
  assert.match(signedIn.setCookie, /^unblock_session=/)
  assert.match(signedIn.setCookie, /HttpOnly/)
  assert.match(signedIn.setCookie, /SameSite=Strict/)
  const cookie = cookieOf(signedIn)

  const queue = await call('/api/asks', asSession(cookie))
  assert.equal(queue.status, 200)
  const who = await call('/api/session', asSession(cookie))
  assert.deepEqual(who.json.viewer, signedIn.json.viewer)
  assert.equal(who.json.authenticated, true)

  // A short passphrase never reaches the disk.
  auth.clearPassphrase()
  const short = await call('/api/session', { method: 'POST', body: { passphrase: 'x'.repeat(7) } })
  assert.equal(short.status, 409, 'no passphrase configured again')
  auth.configurePassphrase(PASSPHRASE)
})

test('approvals: the bearer still cannot, a signed-in human can', async () => {
  const created = await call('/api/asks', {
    method: 'POST', headers: bearer,
    body: { ask: {
      kind: 'file', purpose: 'message', only_you: 'message', project: 'auth-test',
      title: `Session gate ${++number}`,
      why: 'Sending this needs a human approval before the agent may act.',
      tried: ['Checked the API docs and the outbound queue; a person still has to approve it.'],
      message: { to: 'person@example.test', via: 'email', subject: 'Hello', text: 'Please review.' },
    } },
  })
  assert.equal(created.status, 201, JSON.stringify(created.json))
  const ask = created.json
  const path = `/api/asks/${ask.ticket}`
  const verdict = { revision: ask.revision, values: { verdict: 'approve' } }

  const bearerDraft = await call(`${path}/draft`, { method: 'POST', headers: bearer, body: { values: { verdict: 'approve' } } })
  assert.equal(bearerDraft.status, 403)
  assert.equal(bearerDraft.json.code, 'HUMAN_ONLY')
  const bearerAnswer = await call(`${path}/answer`, { method: 'POST', headers: bearer, body: verdict })
  assert.equal(bearerAnswer.status, 403)
  assert.equal(bearerAnswer.json.code, 'HUMAN_ONLY')

  const signedIn = await call('/api/session', { method: 'POST', body: { passphrase: PASSPHRASE } })
  const cookie = cookieOf(signedIn)

  const sessionDraft = await call(`${path}/draft`, { method: 'POST', ...asSession(cookie), body: { values: { verdict: 'approve' } } })
  assert.equal(sessionDraft.status, 200, JSON.stringify(sessionDraft.json))
  const current = await call(path, asSession(cookie))
  const sessionAnswer = await call(`${path}/answer`, { method: 'POST', ...asSession(cookie), body: { revision: current.json.revision, values: { verdict: 'approve' } } })
  assert.equal(sessionAnswer.status, 200, JSON.stringify(sessionAnswer.json))
  assert.equal(sessionAnswer.json.complete, true)
  assert.equal(sessionAnswer.json.ask.status, 'answered')

  // A link minted by a signed-in human carries that human's identity, so it
  // can approve; one minted by the bearer stays refused.
  const mine = await call('/api/asks', {
    method: 'POST', headers: bearer,
    body: { ask: {
      kind: 'file', purpose: 'message', only_you: 'message', project: 'auth-test',
      title: `Session link ${number}`,
      why: 'Sending this needs a human approval before the agent may act.',
      tried: ['Checked the API docs and the outbound queue; a person still has to approve it.'],
      message: { to: 'person@example.test', via: 'email', subject: 'Hello', text: 'Please review.' },
    } },
  })
  const link = await call('/api/links', { method: 'POST', ...asSession(cookie), body: { ticket: mine.json.ticket } })
  assert.equal(link.status, 201)
  const viaLink = await call(`/u/${link.json.token}/api/answer`, {
    method: 'POST',
    body: { ticket: mine.json.ticket, revision: mine.json.revision, values: { verdict: 'approve' } },
  })
  assert.equal(viaLink.status, 200, JSON.stringify(viaLink.json))

  const agentLink = await call('/api/links', { method: 'POST', headers: bearer, body: { ticket: ask.ticket } })
  assert.equal(agentLink.status, 201)
  const refused = await call(`/u/${agentLink.json.token}/api/answer`, {
    method: 'POST',
    body: { ticket: ask.ticket, revision: ask.revision, values: { verdict: 'approve' } },
  })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.code, 'HUMAN_ONLY')
})

test('sign-out destroys the session on the spot', async () => {
  const signedIn = await call('/api/session', { method: 'POST', body: { passphrase: PASSPHRASE } })
  const cookie = cookieOf(signedIn)
  assert.equal((await call('/api/asks', asSession(cookie))).status, 200)

  const out = await call('/api/session', { method: 'DELETE', ...asSession(cookie) })
  assert.equal(out.status, 200)
  assert.equal(out.json.authenticated, false)
  assert.match(out.setCookie, /Max-Age=0/)
  assert.equal((await call('/api/asks', asSession(cookie))).status, 401)
})