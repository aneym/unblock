import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

// The page retries a send whose reply never arrived (a phone waking on a dead
// connection). These pin what makes that safe, and the log that records it.
const stateDir = mkdtempSync(join(tmpdir(), 'unblock-retry-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const { Store } = await import('../src/store.js')
const { SecretStore } = await import('../src/secrets.js')
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

const envText = () => readFileSync(join(stateDir, 'config', 'secrets.env'), 'utf8')
const scopedLine = (ticket, name) => `UB_${`${ticket}-${name}`.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`
const envKey = (record) => record.resolve.match(/grep '\^([A-Z0-9_]+)='/)[1]

async function secretAsk(base, title, { extra = [], ttl_seconds } = {}) {
  const created = await post(base, '/api/asks', {
    ask: {
      kind: 'file', title, why: 'Human input unblocks the key.', only_you: 'credential', ttl_seconds,
      tried: ['Checked everything an agent can check before asking the human.'],
      fields: [
        { name: 'api_key', type: 'secret', label: 'API key', required: true, env_name: 'SHARED_KEY' }, ...extra,
      ],
      links: [{ url: 'https://example.com/settings/api-keys', label: 'API keys page' }],
    }, origin: { session_id: title },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return created.body.ticket
}

test('collected secrets with the same env name resolve independently', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const a = await secretAsk(base, 'scoped-secret-a')
  const first = await post(base, '/api/answer', { ticket: a, values: { api_key: 'alpha' } })
  assert.equal(first.status, 200)
  assert.equal((await post(base, `/api/asks/${a}/collect`, {})).status, 200)
  const b = await secretAsk(base, 'scoped-secret-b')
  const second = await post(base, '/api/answer', { ticket: b, values: { api_key: 'bravo' } })
  assert.equal(second.status, 200)
  for (const [result, expected] of [[first, 'alpha'], [second, 'bravo']]) {
    const record = result.body.ask.answers.api_key
    assert.equal(record.env_name, 'SHARED_KEY')
    assert.equal(record.ref, '$SHARED_KEY')
    assert.equal(execFileSync('/bin/sh', ['-c', `${record.resolve}; printf %s "$SHARED_KEY"`], { env: { ...process.env, SHARED_KEY: '' }, encoding: 'utf8' }), expected)
    assert.equal(await new SecretStore({ backend: 'env' }).reveal(record), expected)
  }
})

test('re-answer failure preserves a committed secret; success retires the old key', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 're-answer-committed-secret', { extra: [
    { name: 'other_key', type: 'secret', label: 'Other key', required: false, env_name: 'OTHER_KEY' },
  ] })
  const first = await post(base, '/api/answer', { ticket, values: { api_key: 'one' } })
  assert.equal(first.status, 200)
  const old = first.body.ask.answers.api_key
  const resolve = (record) => execFileSync('/bin/sh', ['-c', `${record.resolve}; printf %s "$SHARED_KEY"`], { encoding: 'utf8' })
  assert.equal(resolve(old), 'one')

  // A second secret has an invalid type; store.answer rejects after api_key was put.
  const rejected = await post(base, '/api/answer', {
    ticket, values: { api_key: 'two', other_key: ['invalid'] },
  })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'SECRET_NOT_REFERENCED')
  assert.equal(resolve(old), 'one')
  const current = await fetch(`${base}/api/asks/${ticket}`, { headers: { Authorization: `Bearer ${authSecret}` } }).then((res) => res.json())
  assert.deepEqual(current.answers.api_key, old)
  assert.equal(envText().split('\n').filter((line) => line.startsWith(scopedLine(ticket, 'api_key'))).length, 1)

  const successful = await post(base, '/api/answer', { ticket, values: { api_key: 'two' } })
  assert.equal(successful.status, 200)
  const next = successful.body.ask.answers.api_key
  assert.notEqual(envKey(old), envKey(next))
  assert.equal(resolve(next), 'two')
  assert.doesNotMatch(envText(), new RegExp(`^${envKey(old)}=`, 'm'))
  assert.match(envText(), new RegExp(`^${envKey(next)}=`, 'm'))
})

test('a later SQLite write failure rolls back the reference and removes the new secret', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'rollback-reference', { extra: [
    { name: 'verdict', type: 'text', label: 'Verdict', required: true },
  ] })
  const db = new DatabaseSync(join(stateDir, 'queue.db'))
  t.after(() => db.close())
  db.exec(`CREATE TRIGGER reject_second_answer BEFORE INSERT ON answers
    WHEN NEW.field_name = 'verdict' AND NEW.ask_id = (SELECT id FROM asks WHERE ticket = '${ticket}')
    BEGIN SELECT RAISE(FAIL, 'second answer failed'); END`)
  const failed = await post(base, '/api/answer', {
    ticket, values: { api_key: 'rollback-value', verdict: 'keep' },
  })
  assert.equal(failed.status, 500)
  const ask = await fetch(`${base}/api/asks/${ticket}`, { headers: { Authorization: `Bearer ${authSecret}` } }).then((res) => res.json())
  assert.equal(ask.status, 'open')
  assert.deepEqual(ask.answers, {})
  assert.deepEqual(ask.answer_is_ref, {})
  assert.doesNotMatch(envText(), new RegExp(scopedLine(ticket, 'api_key')))
})

test('a bounced secret is not left in the secret store after a successful answer', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'bounced-secret')
  const sent = await post(base, '/api/answer', {
    ticket, values: { api_key: 'bounced-value' }, field_bounce: { api_key: 'wrong question' },
  })
  assert.equal(sent.status, 200)
  assert.deepEqual(sent.body.ask.answers.api_key, { $bounce: 'wrong question' })
  assert.equal(sent.body.ask.answer_is_ref.api_key, undefined)
  assert.doesNotMatch(envText(), new RegExp(scopedLine(ticket, 'api_key')))
})

test('an update waits for a secret answer before revising the ask', async (t) => {
  let started, release
  const putStarted = new Promise((resolve) => { started = resolve })
  const resumePut = new Promise((resolve) => { release = resolve })
  const real = new SecretStore({ backend: 'env' })
  const secretStore = {
    backend: () => real.backend(), backendIfResolved: () => real.backendIfResolved(),
    async put(input) { started(); await resumePut; return real.put(input) },
    delete: (record) => real.delete(record),
  }
  const daemon = await startDaemon({ port: 0, secretStore })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'update-during-put')
  const answer = post(base, '/api/answer', { ticket, values: { api_key: 'race-value' } })
  await putStarted
  const update = post(base, `/api/asks/${ticket}/update`, {
    title: 'Updated question', why: 'Human input unblocks the key.', only_you: 'credential',
    tried: ['Checked everything an agent can check before asking the human.'],
    fields: [{ name: 'verdict', type: 'text', label: 'Verdict', required: true }],
    links: [{ url: 'https://example.com/settings/api-keys', label: 'API keys page' }],
  })
  try {
    assert.equal(await Promise.race([update.then(() => 'updated'), new Promise((resolve) => setTimeout(() => resolve('pending'), 100))]), 'pending')
  } finally { release() }
  assert.equal((await answer).status, 200)
  assert.equal((await update).status, 409)
})

test('sweep waits for a secret put before changing ask status', async (t) => {
  let started, release
  const putStarted = new Promise((resolve) => { started = resolve })
  const resumePut = new Promise((resolve) => { release = resolve })
  const real = new SecretStore({ backend: 'env' })
  const secretStore = {
    backend: () => real.backend(), backendIfResolved: () => real.backendIfResolved(),
    async put(input) { started(); await resumePut; return real.put(input) },
    delete: (record) => real.delete(record),
  }
  const daemon = await startDaemon({ port: 0, secretStore })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'sweep-during-put', { ttl_seconds: 1 })
  const answer = post(base, '/api/answer', { ticket, values: { api_key: 'race-value' } })
  await putStarted
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const sweeping = daemon.sweep()
  try {
    const first = await Promise.race([
      sweeping.then(() => 'swept'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
    ])
    assert.equal(first, 'pending')
  } finally { release() }
  const answered = await answer
  await sweeping
  const stored = await fetch(`${base}/api/asks/${ticket}`, { headers: { Authorization: `Bearer ${authSecret}` } }).then((response) => response.json())
  assert.equal(stored.status, answered.status === 410 ? 'expired' : 'answered')
  if (answered.status === 410) assert.doesNotMatch(envText(), new RegExp(scopedLine(ticket, 'api_key')))
  else assert.equal(answered.status, 200)
})

test('failed answer compensates a successful secret put', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'failed-secret-answer')
  // The store rejects a secret field that was not converted to a reference.
  // An array bypasses the daemon string put check; another valid secret is put first.
  const created = await secretAsk(base, 'failed-second-secret', { extra: [
    { name: 'other_key', type: 'secret', label: 'Other key', required: true, env_name: 'OTHER_KEY' },
  ] })
  const rejected = await post(base, '/api/answer', { ticket: created, values: { api_key: 'stored-first', other_key: ['invalid'] } })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'SECRET_NOT_REFERENCED')
  assert.doesNotMatch(envText(), new RegExp(scopedLine(created, 'api_key')))
  assert.equal((await post(base, '/api/answer', { ticket, values: { api_key: 'still works' } })).status, 200)
})

test('draft revision rejects stale writes, permits ahead revisions and survives restart', async () => {
  let daemon = await startDaemon({ port: 0 })
  let base = `http://127.0.0.1:${daemon.port}`
  try {
    const ticket = await fileAsk(base, 'draft-order')
    const first = await post(base, '/api/draft', { ticket, base_rev: 0, values: { verdict: 'newer' }, reply: 'newer note' })
    assert.equal(first.status, 200)
    assert.equal(first.body.ask.draft_rev, 1)
    const older = await post(base, '/api/draft', { ticket, base_rev: 0, values: { verdict: 'older' }, reply: 'older note' })
    assert.equal(older.status, 409)
    assert.equal(older.body.code, 'DRAFT_STALE')
    assert.equal(older.body.draft_rev, 1)
    await daemon.close()
    daemon = await startDaemon({ port: 0 })
    base = `http://127.0.0.1:${daemon.port}`
    const stillStale = await post(base, '/api/draft', { ticket, base_rev: 0, values: { verdict: 'lost' } })
    assert.equal(stillStale.status, 409)
    const ahead = await post(base, '/api/draft', { ticket, base_rev: 2, values: { verdict: 'beacon' } })
    assert.equal(ahead.status, 200)
    assert.equal(ahead.body.ask.draft_rev, 2)
    assert.equal(ahead.body.ask.draft.verdict, 'beacon')
    assert.equal(ahead.body.ask.draft_reply, 'newer note')
    const farAhead = await post(base, '/api/draft', { ticket, base_rev: 4, values: { verdict: 'forged' } })
    assert.equal(farAhead.status, 409)
    assert.equal(farAhead.body.code, 'DRAFT_STALE')
  } finally { await daemon.close() }
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

function countingSecretStore() {
  const real = new SecretStore({ backend: 'env' })
  const calls = { put: 0, delete: 0 }
  return {
    calls,
    backend: () => real.backend(), backendIfResolved: () => real.backendIfResolved(),
    put(input) { calls.put += 1; return real.put(input) },
    delete(record) { calls.delete += 1; return real.delete(record) },
  }
}

const partlyAnswered = { extra: [{ name: 'verdict', type: 'text', label: 'Verdict', required: true }] }

test('a retry after collection never reaches the secret store', async (t) => {
  const secretStore = countingSecretStore()
  const daemon = await startDaemon({ port: 0, secretStore })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'no-put-after-collect')
  assert.equal((await post(base, '/api/answer', { ticket, values: { api_key: 'first' } })).status, 200)
  assert.equal((await post(base, `/api/asks/${ticket}/collect`, {})).status, 200)
  assert.equal((await post(base, '/api/answer', { ticket, values: { api_key: 'late' } })).status, 410)
  assert.deepEqual(secretStore.calls, { put: 1, delete: 0 })
})

test('two open asks sharing an env name each resolve their own secret', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const a = await secretAsk(base, 'shared-open-a')
  const b = await secretAsk(base, 'shared-open-b')
  const first = await post(base, '/api/answer', { ticket: a, values: { api_key: 'alpha' } })
  const second = await post(base, '/api/answer', { ticket: b, values: { api_key: 'bravo' } })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  const resolve = (record) => execFileSync('/bin/sh', ['-c', `${record.resolve}; printf %s "$SHARED_KEY"`], { env: { ...process.env, SHARED_KEY: '' }, encoding: 'utf8' })
  for (const [ticket, expected] of [[a, 'alpha'], [b, 'bravo']]) {
    const collected = await post(base, `/api/asks/${ticket}/collect`, {})
    assert.equal(collected.status, 200)
    assert.equal(resolve(collected.body.ask.answers.api_key), expected)
  }
})

test('cancelling a partly answered ask removes its secret', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'cancel-partial-secret', partlyAnswered)
  const partial = await post(base, '/api/answer', { ticket, values: { api_key: 'half-done' } })
  assert.equal(partial.status, 200)
  assert.equal(partial.body.ask.status, 'open')
  const key = envKey(partial.body.ask.answers.api_key)
  assert.match(envText(), new RegExp(`^${key}=`, 'm'))
  assert.equal((await post(base, `/api/asks/${ticket}/cancel`, {})).status, 200)
  assert.doesNotMatch(envText(), new RegExp(`^${key}=`, 'm'))
})

test('expiry removes a partly answered secret', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'expire-partial-secret', { ...partlyAnswered, ttl_seconds: 1 })
  const partial = await post(base, '/api/answer', { ticket, values: { api_key: 'half-done' } })
  assert.equal(partial.status, 200)
  const key = envKey(partial.body.ask.answers.api_key)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await daemon.sweep()
  const current = await fetch(`${base}/api/asks/${ticket}`, { headers: { Authorization: `Bearer ${authSecret}` } }).then((res) => res.json())
  assert.equal(current.status, 'expired')
  assert.doesNotMatch(envText(), new RegExp(`^${key}=`, 'm'))
})

test('pruning an old uncollected ask removes its secret; a collected one keeps resolving', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const orphaned = await secretAsk(base, 'prune-orphaned-secret')
  const collected = await secretAsk(base, 'prune-collected-secret')
  const lost = await post(base, '/api/answer', { ticket: orphaned, values: { api_key: 'never-delivered' } })
  const kept = await post(base, '/api/answer', { ticket: collected, values: { api_key: 'delivered' } })
  assert.equal((await post(base, `/api/asks/${collected}/collect`, {})).status, 200)
  const db = new DatabaseSync(join(stateDir, 'queue.db'))
  try {
    db.prepare(`UPDATE asks SET status = 'orphaned' WHERE ticket = ?`).run(orphaned)
    db.prepare('UPDATE asks SET closed_at = 1 WHERE ticket IN (?, ?)').run(orphaned, collected)
  } finally { db.close() }
  await daemon.sweep()
  assert.doesNotMatch(envText(), new RegExp(`^${envKey(lost.body.ask.answers.api_key)}=`, 'm'))
  assert.match(envText(), new RegExp(`^${envKey(kept.body.ask.answers.api_key)}=`, 'm'))
})

test('sending back a partly answered ask removes its secret', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'bounce-partial-secret', partlyAnswered)
  const partial = await post(base, '/api/answer', { ticket, values: { api_key: 'half-done' } })
  const key = envKey(partial.body.ask.answers.api_key)
  assert.match(envText(), new RegExp(`^${key}=`, 'm'))
  assert.equal((await post(base, '/api/answer', { ticket, reply: 'wrong ask', bounce: true })).status, 200)
  assert.doesNotMatch(envText(), new RegExp(`^${key}=`, 'm'))
})

test('sending back one committed secret field removes the old secret', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'field-bounce-committed-secret', partlyAnswered)
  const partial = await post(base, '/api/answer', { ticket, values: { api_key: 'half-done' } })
  const key = envKey(partial.body.ask.answers.api_key)
  const bounced = await post(base, '/api/answer', { ticket, values: { verdict: 'keep' }, field_bounce: { api_key: 'wrong account' } })
  assert.equal(bounced.status, 200)
  assert.ok(!bounced.body.ask.answer_is_ref.api_key)
  assert.doesNotMatch(envText(), new RegExp(`^${key}=`, 'm'))
})

test('a failed delete keeps the old ask until a later sweep removes its secret', async (t) => {
  const real = new SecretStore({ backend: 'env' })
  let failDeletes = true
  const secretStore = {
    backend: () => real.backend(), backendIfResolved: () => real.backendIfResolved(),
    put: (input) => real.put(input),
    delete: async (record) => (failDeletes ? false : real.delete(record)),
  }
  const daemon = await startDaemon({ port: 0, secretStore })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'prune-delete-fails')
  const answered = await post(base, '/api/answer', { ticket, values: { api_key: 'never-delivered' } })
  const key = envKey(answered.body.ask.answers.api_key)
  const db = new DatabaseSync(join(stateDir, 'queue.db'))
  try {
    db.prepare(`UPDATE asks SET status = 'orphaned', closed_at = 1 WHERE ticket = ?`).run(ticket)
  } finally { db.close() }
  const read = () => fetch(`${base}/api/asks/${ticket}`, { headers: { Authorization: `Bearer ${authSecret}` } })
  await daemon.sweep()
  assert.equal((await read()).status, 200)
  assert.match(envText(), new RegExp(`^${key}=`, 'm'))
  failDeletes = false
  await daemon.sweep()
  assert.equal((await read()).status, 404)
  assert.doesNotMatch(envText(), new RegExp(`^${key}=`, 'm'))
})

test('a failed delete of a replaced secret is retried by the sweeper', async (t) => {
  const real = new SecretStore({ backend: 'env' })
  let failDeletes = true
  const secretStore = {
    backend: () => real.backend(), backendIfResolved: () => real.backendIfResolved(),
    put: (input) => real.put(input),
    delete: async (record) => (failDeletes ? false : real.delete(record)),
  }
  const daemon = await startDaemon({ port: 0, secretStore })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'replace-delete-fails', partlyAnswered)
  const first = await post(base, '/api/answer', { ticket, values: { api_key: 'one' } })
  const second = await post(base, '/api/answer', { ticket, values: { api_key: 'two' } })
  const [oldKey, newKey] = [first, second].map((result) => envKey(result.body.ask.answers.api_key))
  assert.match(envText(), new RegExp(`^${oldKey}=`, 'm'))
  failDeletes = false
  await daemon.sweep()
  assert.doesNotMatch(envText(), new RegExp(`^${oldKey}=`, 'm'))
  assert.match(envText(), new RegExp(`^${newKey}=`, 'm'))
})

test('an orphan collected while the sweep is pruning keeps its secret', async (t) => {
  const real = new SecretStore({ backend: 'env' })
  let entered, release
  const deleting = new Promise((resolve) => { entered = resolve })
  const resume = new Promise((resolve) => { release = resolve })
  const secretStore = {
    backend: () => real.backend(), backendIfResolved: () => real.backendIfResolved(),
    put: (input) => real.put(input),
    async delete(record) { entered(); await resume; return real.delete(record) },
  }
  const daemon = await startDaemon({ port: 0, secretStore })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const first = await secretAsk(base, 'prune-race-first')
  const second = await secretAsk(base, 'prune-race-second')
  await post(base, '/api/answer', { ticket: first, values: { api_key: 'first' } })
  const claimed = await post(base, '/api/answer', { ticket: second, values: { api_key: 'second' } })
  const db = new DatabaseSync(join(stateDir, 'queue.db'))
  try {
    db.prepare(`UPDATE asks SET status = 'orphaned', closed_at = 1 WHERE ticket IN (?, ?)`).run(first, second)
  } finally { db.close() }
  const sweeping = daemon.sweep()
  await deleting // the sweep has listed both and is removing the first one's secret
  assert.equal((await post(base, `/api/asks/${second}/collect`, {})).status, 200)
  release()
  await sweeping
  assert.match(envText(), new RegExp(`^${envKey(claimed.body.ask.answers.api_key)}=`, 'm'))
})

test('a keychain secret counts as deleted only when the lookup says it is gone', async (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'unblock-fake-security-'))
  writeFileSync(join(bin, 'security'), '#!/bin/sh\n[ "$1" = "-i" ] && { cat >/dev/null; exit 0; }\nexit "$FAKE_LOOKUP_EXIT"\n', { mode: 0o755 })
  const saved = { PATH: process.env.PATH, FAKE_LOOKUP_EXIT: process.env.FAKE_LOOKUP_EXIT }
  t.after(() => { process.env.PATH = saved.PATH; if (saved.FAKE_LOOKUP_EXIT === undefined) delete process.env.FAKE_LOOKUP_EXIT; else process.env.FAKE_LOOKUP_EXIT = saved.FAKE_LOOKUP_EXIT })
  process.env.PATH = `${bin}:${process.env.PATH}`
  const record = { store: 'keychain', ref: 'unblock-test-slug' }
  const secrets = new SecretStore({ backend: 'env' })
  for (const [code, gone] of [['44', true], ['0', false], ['1', false]]) {
    process.env.FAKE_LOOKUP_EXIT = code
    assert.equal(await secrets.delete(record), gone, `lookup exit ${code}`)
  }
})

test('a retired secret is queued before its delete is tried', async (t) => {
  const real = new SecretStore({ backend: 'env' })
  let blocking = false, entered, release
  const deleting = new Promise((resolve) => { entered = resolve })
  const resume = new Promise((resolve) => { release = resolve })
  const secretStore = {
    backend: () => real.backend(), backendIfResolved: () => real.backendIfResolved(),
    put: (input) => real.put(input),
    async delete(record) { if (blocking) { entered(); await resume } return real.delete(record) },
  }
  const daemon = await startDaemon({ port: 0, secretStore })
  t.after(() => daemon.close())
  const base = `http://127.0.0.1:${daemon.port}`
  const ticket = await secretAsk(base, 'queue-before-delete', partlyAnswered)
  assert.equal((await post(base, '/api/answer', { ticket, values: { api_key: 'one' } })).status, 200)
  blocking = true
  const replacing = post(base, '/api/answer', { ticket, values: { api_key: 'two' } })
  await deleting
  const queued = () => {
    const db = new DatabaseSync(join(stateDir, 'queue.db'))
    try { return db.prepare('SELECT COUNT(*) AS n FROM secret_deletes').get().n } finally { db.close() }
  }
  const before = queued()
  release()
  assert.equal((await replacing).status, 200)
  assert.equal(before, 1, 'the old secret is queued while its delete is in flight')
  assert.equal(queued(), 0)
})

test('a 1Password delete uses the vault named in the reference', async (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'unblock-fake-op-'))
  const log = join(bin, 'args')
  writeFileSync(join(bin, 'op'), `#!/bin/sh\necho "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 })
  const savedPath = process.env.PATH
  t.after(() => { process.env.PATH = savedPath })
  process.env.PATH = `${bin}:${process.env.PATH}`
  const secrets = new SecretStore({ backend: 'env', vault: 'Today' })
  assert.equal(await secrets.delete({ store: 'op', ref: 'op://Then/item123/credential' }), true)
  assert.equal(readFileSync(log, 'utf8').trim(), 'item delete item123 --vault Then')
})
