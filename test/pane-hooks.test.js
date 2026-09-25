import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-pane-hooks-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
const { ASK_PURPOSES } = await import('../src/schema.js')
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const { permissionVerdict } = await import('../hooks/lib.js')
const auth = loadOrCreateSecret()

// Run the real hook boundary asynchronously so the in-process daemon can reply.
function hook(name, input, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`hooks/${name}.js`], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HERDR_PANE_ID: 'test:p1', HERDR_SOCKET_PATH: join(stateDir, 'missing.sock'), ...overrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.end(JSON.stringify(input))
  })
}

const question = (questionText = 'Which approach works?') => ({
  cwd: '/workspace/house', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: questionText, header: 'Approach', multiSelect: false, options: [
    { label: 'First', description: 'Try this' }, { label: 'Second (Recommended)', description: 'Prefer this' },
  ] }] },
})

const permission = (command) => ({
  cwd: '/workspace/house', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command },
})

async function json(base, path) {
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${auth}` } })
  return response.json()
}

function ticket(result) {
  assert.equal(result.code, 0)
  const decision = JSON.parse(result.stdout).hookSpecificOutput
  assert.equal(decision.permissionDecision, 'deny')
  assert.match(decision.permissionDecisionReason, /ub_[a-z0-9]+/)
  return decision.permissionDecisionReason.match(/ub_[a-z0-9]+/)[0]
}

test('Claude pane hooks file decisions and fail open outside their gate', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const two = question()
    two.tool_input.questions.push({ question: 'Which parts?', header: 'Parts', multiSelect: true, options: [
      { label: 'Left', description: 'Left side' }, { label: 'Right', description: 'Right side' },
    ] })
    const filed = await json(base, `/api/asks/${ticket(await hook('claude-ask', two))}`)
    assert.equal(filed.purpose, ASK_PURPOSES.includes('question') ? 'question' : 'decision')
    assert.equal(filed.fields.length, 2)
    assert.equal(filed.fields[0].recommend.value, 'Second')
    assert.deepEqual(filed.fields[0].choices.map((c) => c.label), ['First', 'Second'])
    if (ASK_PURPOSES.includes('question')) {
      assert.deepEqual(filed.fields[0].choices.map((c) => c.description), ['Try this', 'Prefer this'])
      assert.equal(filed.summary, filed.title)
      assert.equal(filed.only_you, null)
      assert.ok(!filed.fields[1].recommend, 'an unmarked question gets no invented recommendation')
    }
    assert.equal(filed.fields[1].multi, true)

    for (const env of [
      { UNBLOCK_STATE_DIR: join(stateDir, 'empty') },
      { UNBLOCK_ALLOW_DIALOG: '1' },
      { HERDR_PANE_ID: '' },
    ]) {
      const result = await hook('claude-ask', question('Do something else?'), env)
      assert.equal(result.code, 0)
      assert.equal(result.stdout, '')
    }

    const pathAsk = await json(base, `/api/asks/${ticket(await hook('claude-ask', question('Use /Users/alex/project/config v2?')))}`)
    assert.match(pathAsk.title, /config version 2/)
    assert.doesNotMatch(pathAsk.fields[0].label, /\/Users\/|\bv2\b/)

    const first = await hook('claude-permission', permission('ls -la'))
    assert.deepEqual(first, { code: 0, stdout: '' })
    const list = await json(base, '/api/asks?profile=*')
    const permissionAsk = list.asks.find((ask) => ASK_PURPOSES.includes('permission') ? ask.permission?.command?.includes('ls -la') : ask.why.includes('ls -la'))
    assert.ok(permissionAsk)
    assert.equal(permissionAsk.status, 'open')
    assert.equal(permissionAsk.purpose, ASK_PURPOSES.includes('permission') ? 'permission' : 'decision')
    assert.deepEqual(permissionAsk.fields[0].choices.map((c) => c.value), ['allow_once', 'deny'])
    assert.equal(permissionAsk.fields[0].choices.some((c) => /always/i.test(c.label + c.value)), false)

    const redaction = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 API_KEY=shortvalue AUTH_TOKEN=anothersecret'
    assert.deepEqual(await hook('claude-permission', permission(`echo ${redaction}`)), { code: 0, stdout: '' })
    const after = await json(base, '/api/asks?profile=*')
    const redacted = after.asks.find((ask) => (ASK_PURPOSES.includes('permission') ? ask.permission?.command : ask.why)?.includes('[redacted]'))
    assert.ok(redacted)
    assert.doesNotMatch(ASK_PURPOSES.includes('permission') ? redacted.permission.command : redacted.why, /abcdefghijklmnopqrstuvwxyz0123456789|shortvalue|anothersecret/)
    assert.equal((await json(base, `/api/asks/${permissionAsk.ticket}`)).status, 'cancelled')
    assert.equal(redacted.status, 'open')

    if (ASK_PURPOSES.includes('permission')) {
      // An open same-title decision ask answers with a bearer token; the permission hook must not adopt it.
      const legacy = { kind: 'file', purpose: 'decision', only_you: 'judgment', project: 'house', title: redacted.title,
        why: 'An older permission ask filed before the daemon knew the permission purpose.',
        tried: ['Filed by the older hook before the upgrade.'],
        fields: [{ name: 'decision', type: 'choice', label: 'Let it run this once?', choices: [{ value: 'allow_once', label: 'Allow once' }, { value: 'deny', label: 'Deny' }],
          recommend: { value: 'allow_once', why: 'Claude chose this step itself.' }, must_decide: true }] }
      const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      await post(`/api/asks/${redacted.ticket}/cancel`, { note: 'test' })
      const posted = await post('/api/asks', { ask: legacy, origin: { pane_id: 'test:p1' } })
      assert.equal(posted.status, 201)
      const old = (await posted.json()).ticket
      assert.deepEqual(await hook('claude-permission', permission('touch adopted')), { code: 0, stdout: '' })
      const now = await json(base, '/api/asks?profile=*')
      assert.equal(now.asks.some((ask) => ask.status === 'open' && ask.permission?.command?.includes('touch adopted')), false)
      assert.equal(existsSync(join(stateDir, 'pane-asks', `${old}.json`)), false)
    }
  } finally {
    await daemon.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a watcher acts only on the verdict its ask purpose allows', () => {
  assert.equal(permissionVerdict({ purpose: 'permission', answers: { verdict: 'allow_once' } }), 'allow_once')
  assert.equal(permissionVerdict({ purpose: 'permission', answers: { decision: 'allow_once' } }), undefined)
  assert.equal(permissionVerdict({ purpose: 'decision', answers: { decision: 'deny' } }), 'deny')
  assert.equal(permissionVerdict({ purpose: 'question', answers: { decision: 'allow_once' } }), undefined)
  assert.equal(permissionVerdict({ purpose: 'permission', answers: { verdict: 'always' } }), undefined)
})
