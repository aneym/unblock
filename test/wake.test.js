import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-wake-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const authSecret = loadOrCreateSecret()

async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authSecret}`,
      ...(options.headers || {}),
    },
  })
  return { response, body: await response.json() }
}

const post = (base, pathname, body) => json(base, pathname, { method: 'POST', body: JSON.stringify(body) })

const field = { name: 'answer', type: 'text', label: 'Answer', required: true }
const askBody = (kind, title, origin, extras = {}) => ({
  ask: { kind, title, why: `Human input unblocks ${title}.`, fields: [field], ...extras },
  origin,
})

const hermes = (session) => ({ agent: 'hermes', session_id: session, session_key: `key:${session}`, profiles: ['bot'] })

test('wake contract: filed answers become a durable, single-lease wake for the origin session', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`

  await t.test('answering a filed ask promises a wake keyed to the exact session', async () => {
    const created = await post(base, '/api/asks', askBody('file', 'Pick a name', hermes('sess-A')))
    assert.equal(created.response.status, 201)
    assert.equal(created.body.origin.session_key, 'key:sess-A')

    const before = await json(base, '/api/wakes?agent=hermes&session_id=sess-A')
    assert.deepEqual(before.body.wakes, [])

    const answered = await post(base, `/api/asks/${created.body.ticket}/answer`, { values: { answer: 'unblock' } })
    assert.equal(answered.body.complete, true)

    const owed = await json(base, '/api/wakes?agent=hermes&session_id=sess-A')
    assert.equal(owed.body.wakes.length, 1)
    assert.equal(owed.body.wakes[0].ticket, created.body.ticket)
    assert.equal(owed.body.wakes[0].status, 'pending')
    // Listing never carries the answer: a host scans for WHICH sessions to
    // claim for, and only the claim (scoped to one session) reveals values.
    assert.equal('ask' in owed.body.wakes[0], false)
    assert.equal(JSON.stringify(owed.body).includes('unblock'), false)

    // Another session, same agent, sees nothing. Exact origin routing.
    const other = await json(base, '/api/wakes?agent=hermes&session_id=sess-B')
    assert.deepEqual(other.body.wakes, [])
    const otherClaim = await post(base, '/api/wakes/claim', { origin: hermes('sess-B') })
    assert.deepEqual(otherClaim.body.wakes, [])

    // The unscoped list is the recovery scan: who is owed, and nothing else.
    const all = await json(base, '/api/wakes')
    assert.deepEqual(all.body.wakes.map((w) => w.origin.session_id), ['sess-A'])
  })

  await t.test('claim is a lease: one winner, retry after a failed ack, done after a delivered ack', async () => {
    const created = await post(base, '/api/asks', askBody('file', 'Lease me', hermes('sess-L')))
    await post(base, `/api/asks/${created.body.ticket}/answer`, { values: { answer: 'yes' } })

    const first = await post(base, '/api/wakes/claim', { origin: hermes('sess-L'), lease_seconds: 30 })
    assert.equal(first.body.wakes.length, 1)
    assert.equal(first.body.wakes[0].ask.answers.answer, 'yes')
    assert.equal(first.body.wakes[0].attempts, 1)
    assert.equal(first.body.outstanding, 0)
    const token = first.body.wakes[0].claim_token
    assert.ok(token)

    // A second claimer during the lease gets nothing: no duplicate delivery.
    // The lease length belongs to the holder, so asking with the shortest
    // allowed lease cannot shorten the live one and steal it.
    assert.equal(first.body.wakes[0].lease_until > Date.now() + 25_000, true)
    const second = await post(base, '/api/wakes/claim', { origin: hermes('sess-L'), lease_seconds: 5 })
    assert.deepEqual(second.body.wakes, [])

    // A stale token cannot settle somebody else's lease.
    const wrong = await post(base, `/api/wakes/${created.body.ticket}/ack`, { claim_token: 'nope', delivered: true })
    assert.equal(wrong.response.status, 409)

    // Delivery failed: the lease is released and the reason is kept.
    const failed = await post(base, `/api/wakes/${created.body.ticket}/ack`, { claim_token: token, delivered: false, error: 'session not live here' })
    assert.equal(failed.response.status, 200)
    assert.equal(failed.body.wake.status, 'pending')
    assert.equal(failed.body.wake.last_error, 'session not live here')
    assert.equal(failed.body.ask.status, 'answered')

    // The next claim wins again, attempts count up.
    const retry = await post(base, '/api/wakes/claim', { origin: hermes('sess-L') })
    assert.equal(retry.body.wakes.length, 1)
    assert.equal(retry.body.wakes[0].attempts, 2)

    // Delivered: the wake is settled AND the ask is collected in one step.
    const done = await post(base, `/api/wakes/${created.body.ticket}/ack`, { claim_token: retry.body.wakes[0].claim_token, delivered: true })
    assert.equal(done.body.wake.status, 'delivered')
    assert.equal(done.body.ask.status, 'collected')

    // Idempotent: acking again changes nothing and claims find nothing.
    const again = await post(base, `/api/wakes/${created.body.ticket}/ack`, { claim_token: 'anything', delivered: true })
    assert.equal(again.body.wake.status, 'delivered')
    const empty = await post(base, '/api/wakes/claim', { origin: hermes('sess-L') })
    assert.deepEqual(empty.body.wakes, [])
    const pending = await json(base, '/api/pending?agent=hermes&session_id=sess-L')
    assert.deepEqual(pending.body.asks, [])
  })

  await t.test('a bounce owes a wake too, and unblock_check collecting first voids it', async () => {
    const bounced = await post(base, '/api/asks', askBody('file', 'Bounce me', hermes('sess-V')))
    await post(base, `/api/asks/${bounced.body.ticket}/answer`, { bounce: true, reply: 'wrong question' })
    const collectedFirst = await post(base, '/api/asks', askBody('file', 'Collect me', hermes('sess-V')))
    await post(base, `/api/asks/${collectedFirst.body.ticket}/answer`, { values: { answer: 'ok' } })

    let owed = await json(base, '/api/wakes?agent=hermes&session_id=sess-V')
    assert.deepEqual(owed.body.wakes.map((w) => w.ticket).sort(), [bounced.body.ticket, collectedFirst.body.ticket].sort())

    // The agent happened to call unblock_check before the wake fired.
    await post(base, `/api/asks/${collectedFirst.body.ticket}/collect`, {})
    owed = await json(base, '/api/wakes?agent=hermes&session_id=sess-V')
    assert.deepEqual(owed.body.wakes.map((w) => w.ticket), [bounced.body.ticket])

    const claim = await post(base, '/api/wakes/claim', { origin: hermes('sess-V') })
    assert.equal(claim.body.wakes.length, 1)
    assert.equal(claim.body.wakes[0].ask.status, 'bounced')
    assert.equal(claim.body.wakes[0].ask.reply, 'wrong question')
  })

  await t.test('parked asks never get a wake: the park call is already waiting', async () => {
    const parked = await post(base, '/api/asks', askBody('park', 'Gate', hermes('sess-P')))
    await post(base, `/api/asks/${parked.body.ticket}/answer`, { values: { answer: 'go' } })
    const owed = await json(base, '/api/wakes?agent=hermes&session_id=sess-P')
    assert.deepEqual(owed.body.wakes, [])
    // The park poller still sees it through the normal channel.
    const pending = await json(base, '/api/pending?agent=hermes&session_id=sess-P')
    assert.deepEqual(pending.body.asks.map((a) => a.ticket), [parked.body.ticket])
  })

  await t.test('cancelling an answered filed ask withdraws its wake', async () => {
    const created = await post(base, '/api/asks', askBody('file', 'Cancel me', hermes('sess-C')))
    await post(base, `/api/asks/${created.body.ticket}/answer`, { values: { answer: 'x' } })
    await post(base, `/api/asks/${created.body.ticket}/cancel`, { note: 'no longer needed' })
    const claim = await post(base, '/api/wakes/claim', { origin: hermes('sess-C') })
    assert.deepEqual(claim.body.wakes, [])
  })

  await t.test('outstanding counts the filed asks still open for that session only', async () => {
    await post(base, '/api/asks', askBody('file', 'Open one', hermes('sess-O')))
    await post(base, '/api/asks', askBody('file', 'Open two', hermes('sess-O')))
    await post(base, '/api/asks', askBody('file', 'Someone else', hermes('sess-O2')))
    const claim = await post(base, '/api/wakes/claim', { origin: hermes('sess-O') })
    assert.equal(claim.body.outstanding, 2)
  })

  await t.test('a claim needs a session or pane, and the SSE stream announces who is owed', async () => {
    const bad = await post(base, '/api/wakes/claim', { origin: { agent: 'hermes' } })
    assert.equal(bad.response.status, 400)

    const controller = new AbortController()
    const stream = await fetch(`${base}/api/events`, {
      headers: { Authorization: `Bearer ${authSecret}` },
      signal: controller.signal,
    })
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    const created = await post(base, '/api/asks', askBody('file', 'Announce me', hermes('sess-S')))
    await post(base, `/api/asks/${created.body.ticket}/answer`, { values: { answer: 'secret-ish value' } })
    while (!seen.includes('event: wake')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
    controller.abort()
    const line = seen.split('\n').find((l, i, arr) => arr[i - 1] === 'event: wake')
    const payload = JSON.parse(line.replace(/^data: /, ''))
    assert.equal(payload.ticket, created.body.ticket)
    assert.equal(payload.agent_key, 'sess-S')
    assert.equal(seen.includes('secret-ish value'), false)
  })

  await daemon.close()
})

test.after(() => rmSync(stateDir, { recursive: true, force: true }))
