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
const { Store } = await import('../src/store.js')
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

  await t.test('a retry after collection stores no secret', async () => {
    const created = await post(base, '/api/asks', {
      ask: {
        kind: 'file', title: 'secret-after-collect', why: 'Human input unblocks the key.', only_you: 'credential',
        tried: ['Checked everything an agent can check before asking the human.'],
        fields: [{ name: 'api_key', type: 'secret', label: 'API key', required: true, env_name: 'RETRY_TEST_KEY' }],
        links: [{ url: 'https://example.com/settings/api-keys', label: 'API keys page' }],
      },
      origin: { session_id: 'retry-secret' },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const ticket = created.body.ticket
    assert.equal((await post(base, '/api/answer', { ticket, values: { api_key: 'first-value-1234' } })).status, 200)
    assert.equal((await post(base, `/api/asks/${ticket}/collect`, {})).status, 200)
    const late = `late-value-${Date.now()}`
    assert.equal((await post(base, '/api/answer', { ticket, values: { api_key: late } })).status, 410)
    const envFile = readFileSync(join(stateDir, 'config', 'secrets.env'), 'utf8')
    assert.doesNotMatch(envFile, new RegExp(Buffer.from(late).toString('base64')))
  })

  await t.test('an orphaned ask refuses a late secret without storing it', async () => {
    const created = await post(base, '/api/asks', {
      ask: {
        kind: 'file', title: 'secret-after-orphan', why: 'Human input unblocks the key.', only_you: 'credential',
        tried: ['Checked everything an agent can check before asking the human.'],
        fields: [{ name: 'api_key', type: 'secret', label: 'API key', required: true, env_name: 'RETRY_TEST_KEY' }],
        links: [{ url: 'https://example.com/settings/api-keys', label: 'API keys page' }],
      },
      origin: { session_id: 'retry-orphan-secret' },
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const ticket = created.body.ticket
    assert.equal((await post(base, '/api/answer', { ticket, values: { api_key: 'before-orphan' } })).status, 200)
    const store = new Store(join(stateDir, 'queue.db'))
    try {
      assert.equal(store.orphan(ticket, 'agent is gone').status, 'orphaned')
    } finally {
      store.close()
    }
    const late = `orphaned-late-${Date.now()}`
    assert.equal((await post(base, '/api/answer', { ticket, values: { api_key: late } })).status, 410)
    const envFile = readFileSync(join(stateDir, 'config', 'secrets.env'), 'utf8')
    assert.doesNotMatch(envFile, new RegExp(Buffer.from(late).toString('base64')))
  })

  await t.test('a collected ask refuses drafts without changing the saved draft', async () => {
    const ticket = await fileAsk(base, 'draft-after-collect')
    assert.equal((await post(base, '/api/draft', { ticket, values: { verdict: 'original' }, reply: 'original note' })).status, 200)
    const link = await post(base, '/api/links', { ticket })
    assert.equal(link.status, 201)
    assert.equal((await post(base, `/api/asks/${ticket}/collect`, {})).status, 200)
    const late = await post(base, '/api/draft', { ticket, values: { verdict: 'late' }, reply: 'late note' })
    assert.equal(late.status, 410)
    const viaLink = await post(base, `/u/${link.body.token}/api/draft`, { values: { verdict: 'late via link' } }, { auth: false })
    assert.equal(viaLink.status, 410)
    const stored = await fetch(`${base}/api/asks/${ticket}`, { headers: { Authorization: `Bearer ${authSecret}` } })
    assert.equal(stored.status, 200)
    const ask = await stored.json()
    assert.equal(ask.draft.verdict, 'original')
    assert.equal(ask.draft_reply, 'original note')
  })

  await t.test('an answer arriving after a send-back is 410', async () => {
    const ticket = await fileAsk(base, 'answer-after-bounce')
    assert.equal((await post(base, '/api/answer', { ticket, reply: 'wrong ask', bounce: true })).status, 200)
    assert.equal((await post(base, '/api/answer', { ticket, values: { verdict: 'keep' } })).status, 410)
  })

  await t.test('a retried send-back after the first one landed is 410', async () => {
    const ticket = await fileAsk(base, 'bounce-twice')
    assert.equal((await post(base, '/api/answer', { ticket, reply: 'wrong ask', bounce: true })).status, 200)
    const retry = await post(base, '/api/answer', { ticket, reply: 'wrong ask', bounce: true })
    assert.equal(retry.status, 410)
  })
})

test('collection cannot pass an answer while its secret is being stored', async (t) => {
  let started
  let release
  const putStarted = new Promise((resolve) => { started = resolve })
  const resumePut = new Promise((resolve) => { release = resolve })
  const stored = new Map()
  const secretStore = {
    backend: async () => 'test', backendIfResolved: () => 'test',
    async put({ name, value, ticket, envName }) {
      started()
      await resumePut
      const ref = `${ticket}-${name}`
      stored.set(ref, value)
      return { ref, store: 'test', env_name: envName, resolve: ref }
    },
  }
  const daemon = await startDaemon({ port: 0, secretStore })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const created = await post(base, '/api/asks', {
    ask: {
      kind: 'file', title: 'secret-during-collect', why: 'Human input unblocks the key.', only_you: 'credential',
      tried: ['Checked everything an agent can check before asking the human.'],
      fields: [{ name: 'api_key', type: 'secret', label: 'API key', required: true, env_name: 'RETRY_RACE_KEY' }],
      links: [{ url: 'https://example.com/settings/api-keys', label: 'API keys page' }],
    },
    origin: { session_id: 'retry-race-secret' },
  })
  assert.equal(created.status, 201)
  const ticket = created.body.ticket
  const answer = post(base, '/api/answer', { ticket, values: { api_key: 'race-value' } })
  await putStarted
  const collect = post(base, `/api/asks/${ticket}/collect`, {})
  try {
    // Without the lock, collect returns while put is still blocked and its reference can change later.
    const first = await Promise.race([
      collect.then(() => 'collected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])
    assert.equal(first, 'pending')
    assert.equal(stored.size, 0)
  } finally {
    release()
  }
  const [answered, collected] = await Promise.all([answer, collect])
  assert.equal(answered.status, 200)
  assert.equal(collected.status, 200)
  assert.deepEqual(collected.body.ask.answers.api_key, answered.body.ask.answers.api_key)
  assert.equal(stored.get(collected.body.ask.answers.api_key.ref), 'race-value')
})

test('an older draft from the same page cannot overwrite a newer one', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await fileAsk(base, 'draft-order')
  const newer = await post(base, '/api/draft', {
    ticket, draft_session: 'page-1', draft_seq: 2, values: { verdict: 'newer' }, reply: 'newer note',
  })
  assert.equal(newer.status, 200)
  const older = await post(base, '/api/draft', {
    ticket, draft_session: 'page-1', draft_seq: 1, values: { verdict: 'older' }, reply: 'older note',
  })
  assert.equal(older.status, 200)
  assert.equal(older.body.ask.draft.verdict, 'newer')
  assert.equal(older.body.ask.draft_reply, 'newer note')
})

test('the store refuses an answer on a bounced ask', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const ticket = await fileAsk(base, 'store-bounced-answer')
    assert.equal((await post(base, '/api/answer', { ticket, reply: 'wrong ask', bounce: true })).status, 200)
    const store = new Store(join(stateDir, 'queue.db'))
    try {
      assert.throws(() => store.answer(ticket, { verdict: 'keep' }), { status: 410 })
      assert.equal(store.get(ticket).answers.verdict, undefined)
    } finally {
      store.close()
    }
  } finally {
    await daemon.close()
  }
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
