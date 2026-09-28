import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-test-'))
const configDir = join(stateDir, 'config')
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = configDir
process.env.UNBLOCK_SECRET_BACKEND = 'env'
process.env.UNBLOCK_REPING_AFTER_MS = '20'
const paneLog = join(stateDir, 'pane-notices')
const herdrBin = join(stateDir, 'herdr-stub')
writeFileSync(herdrBin, `#!/bin/sh\ncase "$1 $2" in\n  "pane get")
    if [ -f '${stateDir}/pane-missing' ]; then printf '{"result":{}}'
    elif [ -f '${stateDir}/pane-busy' ]; then printf '{"result":{"pane":{"agent_status":"blocked"}}}'
    else printf '{"result":{"pane":{"agent_status":"idle"}}}'; fi ;;\n  "pane read") printf 'Ready' ;;\n  "agent prompt") printf 'notice\\n' >> '${paneLog}' ;;\nesac\n`)
chmodSync(herdrBin, 0o700)
process.env.HERDR_BIN_PATH = herdrBin

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
  return { kind, title, why: `Human input unblocks ${title}.`, fields, only_you: 'message', tried: ['Checked the CLI and API; only the human can send this message.'], ...extras }
}

const textField = (name) => ({ name, type: 'text', label: name, required: true })

test('daemon API contract', async (t) => {
  let daemon = await startDaemon({ port: 0 })
  let base = `http://127.0.0.1:${daemon.port}`

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

  await t.test('rejects eval origins and gates worktree origins without exposing asks', async () => {
    const file = (title, origin) => json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: ask('file', title, [textField('answer')]), origin }),
    })
    const before = (await json(base, '/api/asks')).body.asks.length
    for (const origin of [
      { cwd: '/Users/aneyman/.agent-rails/orch-lab/run/one' },
      { repo: '/Users/aneyman/.agent-rails/orch-lab/repo' },
      { kind: 'eval', cwd: '/workspace/ordinary' },
    ]) {
      const result = await file(`Eval ${JSON.stringify(origin)}`, origin)
      assert.equal(result.response.status, 403)
      assert.equal(result.body.code, 'EVAL_ORIGIN')
    }
    assert.equal((await json(base, '/api/asks')).body.asks.length, before)
    const path = '/workspace/my-wt/branch'
    const accepted = await file('Allowed worktree', { cwd: path })
    assert.equal(accepted.response.status, 201)
    await daemon.close()
    process.env.UNBLOCK_REFUSE_WORKTREE_ORIGINS = 'true'
    // Restart in the isolated test state to apply the durable flag.
    const flagged = await startDaemon({ port: 0 })
    try {
      const gated = await json(`http://127.0.0.1:${flagged.port}`, '/api/asks', {
        method: 'POST', body: JSON.stringify({ ask: ask('file', 'Refused worktree', [textField('answer')]), origin: { cwd: path } }),
      })
      assert.equal(gated.response.status, 403)
      assert.equal(gated.body.code, 'WORKTREE_ORIGIN')
    } finally {
      await flagged.close()
      delete process.env.UNBLOCK_REFUSE_WORKTREE_ORIGINS
      daemon = await startDaemon({ port: 0 })
      base = `http://127.0.0.1:${daemon.port}`
    }
  })

  await t.test('only a self-filed question re-pings once through the guarded pane', async () => {
    const origin = { session_id: 'reping-test', pane_id: 'test:p1' }
    const created = await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: ask('file', 'Re-ping question', [textField('answer')], {
        purpose: 'question', blocks: ['Staging verification', 'Release notes'], minutes: 240,
      }), origin }),
    })
    assert.equal(created.response.status, 201)
    assert.equal(created.body.blocks, 'Staging verification, Release notes')
    assert.equal(created.body.minutes, 240)
    const list = await json(base, '/api/asks')
    assert.equal(list.body.asks.find((item) => item.ticket === created.body.ticket).blocks, created.body.blocks)
    const answered = await json(base, `/api/asks/${created.body.ticket}/answer`, {
      method: 'POST', body: JSON.stringify({ values: { answer: 'Done' } }),
    })
    assert.equal(answered.body.complete, true)
    assert.equal(existsSync(paneLog), false, 'daemon must not first-deliver')
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(join(stateDir, 'pane-busy'), '')
    await daemon.sweep()
    assert.equal(existsSync(paneLog), false, 'busy permission pane is not prompted')
    assert.equal((await json(base, `/api/asks/${created.body.ticket}`)).body.repinged_at, undefined)
    rmSync(join(stateDir, 'pane-busy'))
    await daemon.sweep()
    const repinged = await json(base, `/api/asks/${created.body.ticket}`)
    assert.ok(repinged.body.repinged_at)
    assert.equal(readFileSync(paneLog, 'utf8').trim().split('\n').length, 1)
    await daemon.sweep()
    assert.equal(readFileSync(paneLog, 'utf8').trim().split('\n').length, 1)
    const collected = await json(base, `/api/asks/${created.body.ticket}/collect`, { method: 'POST', body: '{}' })
    assert.equal(collected.body.ask.status, 'collected')
  })

  await t.test('missing panes stop retries without prompting anyone', async () => {
    const origin = { session_id: 'missing-pane', pane_id: 'test:gone' }
    const created = await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: ask('file', 'Missing pane question', [textField('answer')], { purpose: 'question' }), origin }),
    })
    await json(base, `/api/asks/${created.body.ticket}/answer`, {
      method: 'POST', body: JSON.stringify({ values: { answer: 'Done' } }),
    })
    await new Promise((r) => setTimeout(r, 30))
    writeFileSync(join(stateDir, 'pane-missing'), '')
    try {
      await daemon.sweep()
      const closed = await json(base, `/api/asks/${created.body.ticket}`)
      assert.ok(closed.body.reping_unavailable_at)
      await daemon.sweep()
      assert.equal(readFileSync(paneLog, 'utf8').trim().split('\n').length, 1)
    } finally { rmSync(join(stateDir, 'pane-missing')) }
  })

  await t.test('permission and detected asks never re-ping', async () => {
    const origin = { session_id: 'excluded', pane_id: 'test:p1' }
    for (const [title, extra, source] of [
      ['Ordinary filed', {}, origin],
      ['Detected waiting', { purpose: 'question' }, { ...origin, detected: true }],
      ['Permission question', { purpose: 'permission', permission: { tool: 'Bash', summary: 'Approve shell operation' }, fields: undefined }, origin],
    ]) {
      const created = await json(base, '/api/asks', {
        method: 'POST', body: JSON.stringify({ ask: ask('file', title, [textField('answer')], extra), origin: source }),
      })
      assert.equal(created.response.status, 201)
      // Approval answers require a verified page. An answered permission ask
      // is covered by a separate gated suite; this sweep also excludes it.
      if (title !== 'Permission question') {
        await json(base, `/api/asks/${created.body.ticket}/answer`, {
          method: 'POST', body: JSON.stringify({ values: { answer: 'Done' } }),
        })
      }
    }
    await new Promise((r) => setTimeout(r, 30))
    await daemon.sweep()
    assert.equal(readFileSync(paneLog, 'utf8').trim().split('\n').length, 1)
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

  await t.test('per-field context flows through answer, scrubbed, and hydrates back', async () => {
    const created = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({
        ask: ask('file', 'Context request', [textField('host')]),
        origin: { session_id: 'context-session' },
      }),
    })
    const answered = await json(base, `/api/asks/${created.body.ticket}/answer`, {
      method: 'POST',
      body: JSON.stringify({
        values: { host: 'db-1' },
        field_context: { host: 'only until Friday' },
      }),
    })
    assert.equal(answered.body.complete, true)
    assert.equal(answered.body.ask.field_context.host, 'only until Friday')
  })

  await t.test('one open blocker per project and title, with editable instructions', async () => {
    const first = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({ ask: ask('file', 'Approve the message!', [textField('done')], { project: 'launch' }), origin: { session_id: 'unique-one' } }),
    })
    assert.equal(first.response.status, 201)
    const duplicate = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({ ask: ask('park', 'approve THE message', [textField('done')], { project: 'launch' }), origin: { session_id: 'unique-two' } }),
    })
    assert.equal(duplicate.response.status, 409)
    assert.equal(duplicate.body.ticket, first.body.ticket)
    const updated = await json(base, `/api/asks/${first.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Send the message', steps: ['Open the contact page'], links: [{ url: 'https://example.com/contacts/123' }] }),
    })
    assert.equal(updated.response.status, 200)
    const fetched = await json(base, `/api/asks/${first.body.ticket}`)
    assert.equal(fetched.body.title, 'Send the message')
    assert.deepEqual(fetched.body.steps, ['Open the contact page'])
    assert.deepEqual(fetched.body.links, [{ url: 'https://example.com/contacts/123', label: 'https://example.com/contacts/123' }])
    assert.deepEqual(fetched.body.tried, first.body.tried)
    assert.equal(fetched.body.only_you, 'message')
  })

  await daemon.close()
  const dbBytes = readFileSync(join(stateDir, 'queue.db'))
  assert.equal(dbBytes.includes(Buffer.from(secretNeedle)), false)
  assert.equal(dbBytes.includes(Buffer.from('$TEST_API_KEY')), true)
})

test.after(() => rmSync(stateDir, { recursive: true, force: true }))
