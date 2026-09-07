/**
 * The tailnet boundary: which Host and Origin headers the daemon serves, whose
 * proxy identity it trusts, and what a capability link can reach. These are
 * the checks that were missing when a daemon with no public origin 403'd every
 * hosted link for a day.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-host-'))
const configDir = join(stateDir, 'config')
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = configDir
process.env.UNBLOCK_SECRET_BACKEND = 'env'
// The daemon reads these from the config file, exactly as production does.
delete process.env.UNBLOCK_PUBLIC_ORIGIN
delete process.env.UNBLOCK_TRUSTED_PROXY
delete process.env.UNBLOCK_ALLOWED_USERS

const PUBLIC_HOST = 'studio.tailf266ac.ts.net'
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}:8797`
const ALLOWED_USER = 'a.neyman17@gmail.com'

const { mkdirSync } = await import('node:fs')
mkdirSync(configDir, { recursive: true })
writeFileSync(
  join(configDir, 'config.json'),
  JSON.stringify({ public_origin: PUBLIC_ORIGIN, trusted_proxy: 'tailscale', allowed_users: [ALLOWED_USER] }),
)

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const authSecret = loadOrCreateSecret()

let daemon

/**
 * Raw request with full control over headers. node:http rather than fetch,
 * because undici silently drops a caller-set Host header — which would make
 * every host check below pass against loopback and prove nothing.
 */
function raw(pathname, { method = 'GET', headers = {}, body } = {}) {
  const payload = body ? JSON.stringify(body) : undefined
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: daemon.port,
        path: pathname,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            /* html */
          }
          resolve({ status: res.statusCode, json, text })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const authed = (extra = {}) => ({ Authorization: `Bearer ${authSecret}`, ...extra })
const viaTailnet = (extra = {}) => ({
  Host: `${PUBLIC_HOST}:8797`,
  'tailscale-user-login': ALLOWED_USER,
  'tailscale-user-name': 'Alex',
  ...extra,
})

const textField = (name, extras = {}) => ({ name, type: 'text', label: name, required: true, ...extras })

async function createAsk(ask, origin = { session_id: `s-${Math.random()}` }) {
  const { status, json } = await raw('/api/asks', { method: 'POST', headers: authed(), body: { ask, origin } })
  assert.equal(status, 201, JSON.stringify(json))
  return json
}

test.before(async () => {
  daemon = await startDaemon({ port: 0 })
})
test.after(async () => {
  await daemon.close()
  rmSync(stateDir, { recursive: true, force: true })
})

test('health reports the origin it took from the config file', async () => {
  const { status, json } = await raw('/api/health')
  assert.equal(status, 200)
  assert.equal(json.public_origin, PUBLIC_ORIGIN)
  assert.equal(json.trusted_proxy, 'tailscale')
  assert.equal(json.config.present, true)
  assert.ok(json.config.applied.includes('UNBLOCK_PUBLIC_ORIGIN'))
})

test('Host: loopback names and the configured tailnet host are served', async () => {
  for (const host of ['127.0.0.1', 'localhost', `${PUBLIC_HOST}:8797`, PUBLIC_HOST]) {
    const { status } = await raw('/api/health', { headers: { Host: host } })
    assert.equal(status, 200, `Host ${host}`)
  }
})

test('Host: anything else is refused before authentication runs', async () => {
  for (const host of ['evil.example', 'evil.tailf266ac.ts.net:8797', `${PUBLIC_HOST}.evil.example`, 'xstudio.tailf266ac.ts.net']) {
    const { status, json } = await raw('/api/health', { headers: { Host: host } })
    assert.equal(status, 403, `Host ${host}`)
    assert.equal(json.error, 'invalid host')
    // Even a valid daemon secret does not help on the wrong host.
    const authedTry = await raw('/api/asks', { headers: authed({ Host: host }) })
    assert.equal(authedTry.status, 403)
  }
})

test('Origin: the public origin may write, an attacker origin may not', async () => {
  const ask = await createAsk({ kind: 'file', title: 'Origin check', why: 'why', fields: [textField('answer')] })
  const link = await raw('/api/links', { method: 'POST', headers: authed(), body: { ticket: ask.ticket } })
  assert.equal(link.status, 201)
  const token = link.json.token

  const evil = await raw(`/u/${token}/api/draft`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: { values: { answer: 'x' } },
  })
  assert.equal(evil.status, 403)
  assert.equal(evil.json.error, 'invalid origin')

  const lookalike = await raw(`/u/${token}/api/draft`, {
    method: 'POST',
    headers: { Origin: `http://${PUBLIC_HOST}:8797` }, // scheme downgrade
    body: { values: { answer: 'x' } },
  })
  assert.equal(lookalike.status, 403)

  const good = await raw(`/u/${token}/api/draft`, {
    method: 'POST',
    headers: { Host: `${PUBLIC_HOST}:8797`, Origin: PUBLIC_ORIGIN },
    body: { values: { answer: 'drafted over the tailnet' } },
  })
  assert.equal(good.status, 200)
  assert.equal(good.json.ask.draft.answer, 'drafted over the tailnet')
})

test('proxy identity: trusted only on the public host, only for an allowed login', async () => {
  // Right host, right user: the canonical page and its API answer without a token.
  const page = await raw('/', { headers: viaTailnet() })
  assert.equal(page.status, 200)
  assert.match(page.text, /__UNBLOCK_BOOT__/)
  assert.match(page.text, new RegExp(ALLOWED_USER.replace('.', '\\.')))
  const queue = await raw('/api/queue', { headers: viaTailnet() })
  assert.equal(queue.status, 200)
  assert.ok(Array.isArray(queue.json.asks))

  // Same headers on a loopback Host: a local process cannot forge its way in.
  const forged = await raw('/api/queue', { headers: { 'tailscale-user-login': ALLOWED_USER } })
  assert.equal(forged.status, 401)

  // Right host, wrong user.
  const stranger = await raw('/api/queue', { headers: viaTailnet({ 'tailscale-user-login': 'someone@else.example' }) })
  assert.equal(stranger.status, 401)

  // Right host, no identity header (a Funnel hit would look like this).
  const anonymous = await raw('/api/queue', { headers: { Host: `${PUBLIC_HOST}:8797` } })
  assert.equal(anonymous.status, 401)
  const root = await raw('/', { headers: { Host: `${PUBLIC_HOST}:8797` } })
  assert.equal(root.status, 401) // no panel for an unidentified viewer
})

test('capability links: scoped, single-ask, expiring, burned on completion', async () => {
  const mine = await createAsk({ kind: 'file', title: 'Mine', why: 'why', fields: [textField('answer')] })
  const other = await createAsk({ kind: 'file', title: 'Other', why: 'why', fields: [textField('answer')] })
  const minted = await raw('/api/links', {
    method: 'POST',
    headers: authed(),
    body: { ticket: mine.ticket, ttl_seconds: 86400 },
  })
  assert.equal(minted.status, 201)
  const token = minted.json.token
  assert.ok(minted.json.expires_at - Date.now() > 86_000_000)

  // The form loads over the tailnet host and its scoped queue is exactly one ask.
  const form = await raw(`/u/${token}`, { headers: { Host: `${PUBLIC_HOST}:8797` } })
  assert.equal(form.status, 200)
  assert.match(form.text, new RegExp(`__UNBLOCK_TOKEN__=${JSON.stringify(token)}`))
  const scoped = await raw(`/u/${token}/api/queue`, { headers: { Host: `${PUBLIC_HOST}:8797` } })
  assert.equal(scoped.status, 200)
  assert.deepEqual(scoped.json.asks.map((a) => a.ticket), [mine.ticket])

  // A scoped link cannot answer a different ask, and the attempt does not
  // land on the scoped one either.
  const crossed = await raw(`/u/${token}/api/answer`, {
    method: 'POST',
    body: { ticket: other.ticket, values: { answer: 'nope' } },
  })
  assert.equal(crossed.status, 403)
  const untouched = await raw(`/api/asks/${mine.ticket}`, { headers: authed() })
  assert.equal(untouched.json.status, 'open')
  assert.deepEqual(untouched.json.answers, {})
  const otherUntouched = await raw(`/api/asks/${other.ticket}`, { headers: authed() })
  assert.equal(otherUntouched.json.status, 'open')

  // A bogus token is gone, not a hint.
  const bogus = await raw(`/u/${'A'.repeat(32)}/api/queue`)
  assert.equal(bogus.status, 410)

  // Completing burns it; the answer persists and reads back by ticket.
  const answered = await raw(`/u/${token}/api/answer`, {
    method: 'POST',
    headers: { Host: `${PUBLIC_HOST}:8797`, Origin: PUBLIC_ORIGIN },
    body: { values: { answer: 'yes, ship it' }, reply: 'and tell me when it lands' },
  })
  assert.equal(answered.status, 200)
  assert.equal(answered.json.complete, true)
  const burned = await raw(`/u/${token}/api/queue`)
  assert.equal(burned.status, 410)
  const persisted = await raw(`/api/asks/${mine.ticket}`, { headers: authed() })
  assert.equal(persisted.json.status, 'answered')
  assert.equal(persisted.json.answers.answer, 'yes, ship it')
  assert.equal(persisted.json.reply, 'and tell me when it lands')
  assert.ok(persisted.json.answered_at > 0)
})

test('an expired link is dead even though the ask is still open', async () => {
  const ask = await createAsk({ kind: 'file', title: 'Expiring', why: 'why', fields: [textField('answer')] })
  // 30s is the floor the store clamps to, so expire it from the outside.
  const minted = await raw('/api/links', { method: 'POST', headers: authed(), body: { ticket: ask.ticket, ttl_seconds: 30 } })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(stateDir, 'queue.db'))
  db.prepare('UPDATE links SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, minted.json.token)
  db.close()
  const dead = await raw(`/u/${minted.json.token}/api/queue`)
  assert.equal(dead.status, 410)
  const stillOpen = await raw(`/api/asks/${ask.ticket}`, { headers: authed() })
  assert.equal(stillOpen.json.status, 'open')
})

test('decision vs secret: a decision may not carry a secret, a blocker secret comes back as a reference only', async () => {
  const rejected = await raw('/api/asks', {
    method: 'POST',
    headers: authed(),
    body: {
      ask: {
        kind: 'file',
        purpose: 'decision',
        title: 'Which key',
        why: 'why',
        fields: [{ name: 'api_key', type: 'secret', label: 'key', recommend: { value: 'x', why: 'y' } }],
      },
      origin: { session_id: 'decision-secret' },
    },
  })
  assert.equal(rejected.status, 400)
  assert.match(rejected.json.error, /decision cannot ask for a secret/)

  const decision = await createAsk({
    kind: 'file',
    purpose: 'decision',
    title: 'Provider',
    why: 'why',
    fields: [
      {
        name: 'provider',
        type: 'choice',
        label: 'Provider',
        required: true,
        choices: ['anthropic', 'openai'],
        recommend: { value: 'anthropic', why: 'already integrated' },
      },
    ],
  })
  assert.equal(decision.purpose, 'decision')
  assert.equal(decision.fields[0].recommend.value, 'anthropic')

  const blocker = await createAsk({
    kind: 'file',
    purpose: 'blocker',
    title: 'Add the key',
    why: 'why',
    fields: [{ name: 'api_key', type: 'secret', label: 'API key', required: true, env_name: 'HOST_TEST_KEY' }],
  })
  const needle = `needle-${Date.now()}`
  const link = await raw('/api/links', { method: 'POST', headers: authed(), body: { ticket: blocker.ticket } })
  const answered = await raw(`/u/${link.json.token}/api/answer`, {
    method: 'POST',
    headers: { Host: `${PUBLIC_HOST}:8797`, Origin: PUBLIC_ORIGIN },
    body: { values: { api_key: needle } },
  })
  assert.equal(answered.status, 200)
  assert.equal(JSON.stringify(answered.json).includes(needle), false)
  const record = answered.json.ask.answers.api_key
  assert.deepEqual(Object.keys(record).sort(), ['env_name', 'hint', 'ref', 'resolve', 'store'])
  assert.equal(answered.json.ask.answer_is_ref.api_key, true)

  // The read-back over the tailnet identity route is a reference too.
  const readBack = await raw(`/api/asks/${blocker.ticket}`, { headers: viaTailnet() })
  assert.equal(readBack.status, 200)
  assert.equal(JSON.stringify(readBack.json).includes(needle), false)
  assert.equal(readBack.json.answers.api_key.ref, record.ref)

  // A plaintext secret pushed straight at the store is refused.
  const smuggled = await createAsk({
    kind: 'file',
    title: 'Smuggle',
    why: 'why',
    fields: [{ name: 'token', type: 'secret', label: 't', required: true }],
  })
  const refused = await raw(`/api/asks/${smuggled.ticket}/answer`, {
    method: 'POST',
    headers: authed(),
    body: { values: { token: ['not', 'a', 'string'] } },
  })
  assert.equal(refused.status, 400)
  assert.equal(refused.json.code, 'SECRET_NOT_REFERENCED')
})

test('cancel: an open ask closes, an answered one is protected', async () => {
  const stale = await createAsk({ kind: 'file', title: 'Stale question', why: 'why', fields: [textField('answer')] })
  const cancelled = await raw(`/api/asks/${stale.ticket}/cancel`, {
    method: 'POST',
    headers: authed(),
    body: { note: 'superseded by a narrower ask' },
  })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.json.ask.status, 'cancelled')
  assert.equal(cancelled.json.ask.note, 'superseded by a narrower ask')

  const answered = await createAsk({ kind: 'file', title: 'Answered', why: 'why', fields: [textField('answer')] })
  await raw(`/api/asks/${answered.ticket}/answer`, {
    method: 'POST',
    headers: authed(),
    body: { values: { answer: 'the human said this' } },
  })
  const refused = await raw(`/api/asks/${answered.ticket}/cancel`, {
    method: 'POST',
    headers: authed(),
    body: { note: 'trying to erase it' },
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.code, 'ASK_NOT_OPEN')
  assert.equal(refused.json.status, 'answered')
  const intact = await raw(`/api/asks/${answered.ticket}`, { headers: authed() })
  assert.equal(intact.json.status, 'answered')
  assert.equal(intact.json.answers.answer, 'the human said this')
  assert.equal(intact.json.note, undefined)
})
