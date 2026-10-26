import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-pane-hooks-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
const { ASK_PURPOSES } = await import('../src/schema.js')
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
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

test('the question hook files asks from herdr panes and leaves the dialog alone outside its gate', async () => {
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
      assert.equal(filed.summary, '2 questions: Approach, Parts')
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
  } finally {
    await daemon.close()
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5 }) // detached watchers may still be writing
  }
})
