import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// The page retries a send whose reply never arrived (a phone waking on a dead
// connection). These pin what makes that safe, and the log that records it.
const stateDir = mkdtempSync(join(tmpdir(), 'unblock-retry-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const authSecret = loadOrCreateSecret()

async function post(base, pathname, body, { auth = true } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${authSecret}` } : {}),
      'User-Agent': 'Mozilla/5.0 (iPhone) test',
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function fileAsk(base, title) {
  const created = await post(base, '/api/asks', {
    ask: {
      kind: 'file', purpose: 'decision', title, why: `Human input unblocks ${title}.`, only_you: 'judgment',
      tried: ['Checked everything an agent can check before asking the human.'],
      fields: [{ name: 'verdict', type: 'text', label: 'Verdict', required: true, recommend: { value: 'keep', why: 'It already works.' } }],
    },
    origin: { session_id: `retry-${title}` },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return created.body.ticket
}

test('a repeated send is safe and ends in 410 once the agent has it', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  t.after(() => daemon.close())

  await t.test('the same answer twice before collection lands once, unchanged', async () => {
    const ticket = await fileAsk(base, 'answer-twice')
    const first = await post(base, '/api/answer', { ticket, values: { verdict: 'keep' } })
    const again = await post(base, '/api/answer', { ticket, values: { verdict: 'keep' } })
    assert.equal(first.status, 200)
    assert.equal(again.status, 200)
    assert.equal(again.body.ask.status, 'answered')
    assert.equal(again.body.ask.answers.verdict, 'keep')
  })

  await t.test('a retried answer after the agent collected is 410, not a server error', async () => {
    const ticket = await fileAsk(base, 'answer-after-collect')
    assert.equal((await post(base, '/api/answer', { ticket, values: { verdict: 'keep' } })).status, 200)
    assert.equal((await post(base, `/api/asks/${ticket}/collect`, {})).status, 200)
    const retry = await post(base, '/api/answer', { ticket, values: { verdict: 'keep' } })
    assert.equal(retry.status, 410)
  })

  await t.test('a retried send-back after the first one landed is 410', async () => {
    const ticket = await fileAsk(base, 'bounce-twice')
    assert.equal((await post(base, '/api/answer', { ticket, reply: 'wrong ask', bounce: true })).status, 200)
    const retry = await post(base, '/api/answer', { ticket, reply: 'wrong ask', bounce: true })
    assert.equal(retry.status, 410)
  })
})

test('client failure log', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  const file = join(stateDir, 'client-errors.log')
  t.after(() => daemon.close())

  await t.test('refuses a caller with no identity and writes nothing', async () => {
    const refused = await post(base, '/api/client-log', { events: [{ path: '/api/answer' }] }, { auth: false })
    assert.equal(refused.status, 401)
    assert.throws(() => statSync(file))
  })

  await t.test('one line per event, listed keys only, no forged lines, owner-only file', async () => {
    const logged = await post(base, '/api/client-log', {
      events: [{
        path: '/api/answer', outcome: 'failed', attempts: 3, message: 'Load failed\nforged\tline',
        online: true, visibility: 'visible', values: { verdict: 'not-for-the-log' },
      }],
    })
    assert.equal(logged.body.logged, 1)
    const text = readFileSync(file, 'utf8')
    assert.equal(text.split('\n').filter(Boolean).length, 1)
    const columns = text.trimEnd().split('\t')
    assert.equal(columns.length, 9)
    assert.equal(columns[2], '/api/answer')
    assert.equal(columns[5], 'Load failed forged line')
    assert.match(columns[8], /iPhone/)
    assert.doesNotMatch(text, /not-for-the-log/)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })

  await t.test('takes at most 20 events per report and stops past 1 MB', async () => {
    const many = Array.from({ length: 25 }, () => ({ path: '/api/draft', outcome: 'recovered' }))
    assert.equal((await post(base, '/api/client-log', { events: many })).body.logged, 20)
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
    assert.equal((await post(base, '/api/client-log', { events: many })).body.logged, 0)
    assert.equal(statSync(file).size, 1024 * 1024 + 1)
  })
})
