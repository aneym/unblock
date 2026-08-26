import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-test-'))
const configDir = join(stateDir, 'config')
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = configDir
process.env.UNBLOCK_SECRET_BACKEND = 'env'

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const authSecret = loadOrCreateSecret()

async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      // /api is authenticated now. Local clients read this secret from
      // daemon.json; the browser never gets it and uses a link token instead.
      Authorization: `Bearer ${authSecret}`,
      ...(options.headers || {}),
    },
  })
  const body = await response.json()
  return { response, body }
}

function ask(kind, title, fields, extras = {}) {
  return { kind, title, why: `Human input unblocks ${title}.`, fields, ...extras }
}

const textField = (name) => ({ name, type: 'text', label: name, required: true })

test('daemon API contract', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`

  await t.test('creates asks and rejects a second park for one session', async () => {
    const first = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({
        ask: ask('park', 'First gate', [textField('answer')]),
        origin: { session_id: 'session-one' },
      }),
    })
    assert.equal(first.response.status, 201)
    assert.match(first.body.ticket, /^ub_/)

    const second = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({
        ask: ask('park', 'Second gate', [textField('answer')]),
        origin: { session_id: 'session-one' },
      }),
    })
    assert.equal(second.response.status, 409)
    assert.equal(second.body.ticket, first.body.ticket)
  })

  await t.test('filters profiles and counts hidden asks', async () => {
    const created = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({
        ask: ask('file', 'Work request', [textField('answer')]),
        origin: { session_id: 'work-session', profiles: ['work'] },
      }),
    })
    assert.equal(created.response.status, 201)

    const personal = await json(base, '/api/asks?profile=personal')
    assert.equal(personal.body.asks.some((item) => item.ticket === created.body.ticket), false)
    assert.ok(personal.body.hidden >= 1)

    const work = await json(base, '/api/asks?profile=work')
    assert.equal(work.body.asks.some((item) => item.ticket === created.body.ticket), true)
  })

  await t.test('keeps partial required answers open and completes the rest', async () => {
    const created = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({
        ask: ask('file', 'Two answers', [textField('first'), textField('second')]),
        origin: { session_id: 'partial-session' },
      }),
    })
    const partial = await json(base, `/api/asks/${created.body.ticket}/answer`, {
      method: 'POST',
      body: JSON.stringify({ values: { first: 'one' } }),
    })
    assert.equal(partial.body.complete, false)
    assert.equal(partial.body.ask.status, 'open')
    assert.deepEqual(partial.body.ask.missing, ['second'])

    const complete = await json(base, `/api/asks/${created.body.ticket}/answer`, {
      method: 'POST',
      body: JSON.stringify({ values: { second: 'two' } }),
    })
    assert.equal(complete.body.complete, true)
    assert.equal(complete.body.ask.status, 'answered')
  })

  let secretNeedle
  await t.test('stores a secret reference without persisting or returning plaintext', async () => {
    secretNeedle = `plaintext-secret-${Date.now()}-needle`
    const created = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({
        ask: ask('file', 'Secret request', [
          { name: 'api_key', type: 'secret', label: 'API key', required: true, env_name: 'TEST_API_KEY' },
        ]),
        origin: { session_id: 'secret-session' },
      }),
    })
    const answered = await json(base, `/api/asks/${created.body.ticket}/answer`, {
      method: 'POST',
      body: JSON.stringify({ values: { api_key: secretNeedle } }),
    })
    const serialized = JSON.stringify(answered.body)
    assert.equal(serialized.includes(secretNeedle), false)
    assert.equal(answered.body.ask.answers.api_key.store, 'env')
    assert.equal(answered.body.ask.answers.api_key.ref, '$TEST_API_KEY')
    assert.match(answered.body.ask.answers.api_key.resolve, /secrets\.env/)
    // Assert the property, not the wording: the hint must tell the agent not to
    // print the value. Pinning exact copy makes this test break on every edit.
    assert.match(answered.body.ask.answers.api_key.hint, /never echo/i)
    // The resolve fragment must load ONE variable. Sourcing the whole file
    // would put every secret ever stored into the agent's environment, so a
    // reference for this ask would leak every other ask's secrets.
    assert.match(answered.body.ask.answers.api_key.resolve, /TEST_API_KEY=/)
    assert.equal(/^\s*(set -a|\.|source)\b/.test(answered.body.ask.answers.api_key.resolve), false)
    assert.deepEqual(Object.keys(answered.body.ask.answers.api_key).sort(), [
      'env_name',
      'hint',
      'ref',
      'resolve',
      'store',
    ])
  })

  await t.test('burns a ticket link after a complete scoped answer', async () => {
    const created = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({
        ask: ask('file', 'Linked answer', [textField('answer')]),
        origin: { session_id: 'link-session' },
      }),
    })
    const minted = await json(base, '/api/links', {
      method: 'POST',
      body: JSON.stringify({ ticket: created.body.ticket }),
    })
    const answered = await json(base, `/u/${minted.body.token}/api/answer`, {
      method: 'POST',
      body: JSON.stringify({ values: { answer: 'done' } }),
    })
    assert.equal(answered.body.complete, true)
    const expired = await fetch(`${base}/u/${minted.body.token}`)
    assert.equal(expired.status, 410)
    assert.match(await expired.text(), /this link has expired/)
  })

  await daemon.close()
  const dbBytes = readFileSync(join(stateDir, 'queue.db'))
  assert.equal(dbBytes.includes(Buffer.from(secretNeedle)), false)
  assert.equal(dbBytes.includes(Buffer.from('$TEST_API_KEY')), true)
})

test.after(() => rmSync(stateDir, { recursive: true, force: true }))
