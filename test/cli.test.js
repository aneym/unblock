import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const state = mkdtempSync(join(process.env.UNBLOCK_TEST_TMPDIR || tmpdir(), 'unblock-cli-'))
process.env.UNBLOCK_STATE_DIR = state
process.env.UNBLOCK_CONFIG_DIR = join(state, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
const { startDaemon } = await import('../src/daemon.js')
const cli = join(import.meta.dirname, '..', 'bin', 'unblock.js')

async function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, UNBLOCK_STATE_DIR: state }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), 10000)
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data })
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    child.stdin.end(input)
  })
}

async function runDetached(args, input) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, UNBLOCK_STATE_DIR: state }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data })
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data })
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  child.stdin.end(input)
  return { child, done }
}

const common = {
  kind: 'file', why: 'A human must resolve the last step to proceed.', project: 'launch',
  only_you: 'their_account', consent_blocked_by: 'device',
  tried: ['ran railway variables and the API refused: needs the owner'],
  links: [{ url: 'https://example.com/settings/keys' }],
}

test('CLI files, lists, answers and closes asks through a real daemon', async () => {
  const daemon = await startDaemon({ port: 0 })
  process.env.UNBLOCK_PORT = String(daemon.port)
  try {
    const help = await run(['help'])
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /unblock park \[path\|\-\]/)
    assert.match(help.stdout, /unblock check \[--json\]/)
    assert.match(help.stdout, /unblock collect <ticket> \[--json\]/)
    assert.match(help.stdout, /--json works on data commands except reveal, help, ui and mcp\./)

    const blocker = await run(['file', '-'], JSON.stringify({
      ask: { ...common, title: 'Enable access', fields: [
        { name: 'account', type: 'text', label: 'Account', required: true },
        { name: 'enabled', type: 'confirm', label: 'Enabled access', required: true },
      ] },
      origin: { agent: 'claude', workspace_name: 'launch', session_id: 'cli-blocker' },
    }))
    assert.equal(blocker.status, 0, blocker.stderr)
    const blockerTicket = blocker.stdout.match(/ub_[a-z0-9]+/)[0]

    const decision = await run(['file', '--origin', 'launch-review', '--json'], JSON.stringify({
      ask: { ...common, purpose: 'decision', only_you: 'judgment', title: 'Choose rollout', fields: [
        { name: 'plan', type: 'choice', label: 'Rollout plan', required: true,
          choices: [{ value: 'first', label: 'First version' }, { value: 'later', label: 'Wait' }],
          recommend: { value: 'first', why: 'Ships sooner' } },
      ] },
      origin: { agent: 'claude', workspace_name: 'launch', session_id: 'cli-decision' },
    }))
    assert.equal(decision.status, 0, decision.stderr)
    assert.equal(JSON.parse(decision.stdout).origin.lane_name, 'launch-review')
    assert.equal(JSON.parse(decision.stdout).origin.workspace_name, 'launch')
    const decisionTicket = decision.stdout.match(/ub_[a-z0-9]+/)[0]
    const listed = await run(['list', '--json'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.deepEqual(new Set(JSON.parse(listed.stdout).asks.map((a) => a.ticket)),
      new Set([blockerTicket, decisionTicket]))

    const answered = await run(['answer', decisionTicket, 'first VERSION'])
    assert.equal(answered.status, 0, answered.stderr)
    assert.match(answered.stdout, /answered/)
    assert.equal(JSON.parse((await run(['show', decisionTicket, '--json'])).stdout).status, 'answered')

    const oldAgent = process.env.UNBLOCK_AGENT
    const oldSession = process.env.CLAUDE_SESSION_ID
    process.env.UNBLOCK_AGENT = 'claude'
    process.env.CLAUDE_SESSION_ID = 'cli-decision'
    const checked = await run(['check', '--json'])
    assert.equal(checked.status, 0, checked.stderr)
    assert.equal(JSON.parse(checked.stdout).asks[0].ticket, decisionTicket)
    assert.equal(JSON.parse((await run(['show', decisionTicket, '--json'])).stdout).status, 'collected')
    if (oldAgent === undefined) delete process.env.UNBLOCK_AGENT
    else process.env.UNBLOCK_AGENT = oldAgent
    if (oldSession === undefined) delete process.env.CLAUDE_SESSION_ID
    else process.env.CLAUDE_SESSION_ID = oldSession

    const collectAsk = await run(['file', '--json'], JSON.stringify({
      ...common, title: 'Collect one answer', fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true }],
    }))
    const collectTicket = JSON.parse(collectAsk.stdout).ticket
    assert.equal((await run(['answer', collectTicket, 'collected value'])).status, 0)
    const collected = await run(['collect', collectTicket, '--json'])
    assert.equal(collected.status, 0, collected.stderr)
    assert.equal(JSON.parse(collected.stdout).ask.status, 'collected')
    assert.match(collected.stdout, /collected value/)

    const parked = await runDetached(['park', '--json'], JSON.stringify({
      ask: { ...common, title: 'Wait for an answer', fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true }] },
      origin: { agent: 'cli', session_id: 'cli-park' },
    }))
    let parkTicket
    for (let attempt = 0; attempt < 20 && !parkTicket; attempt++) {
      const auth = JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8')).auth
      const response = await fetch(`http://127.0.0.1:${process.env.UNBLOCK_PORT}/api/asks?profile=*`, { headers: { authorization: `Bearer ${auth}` } })
      const asks = (await response.json()).asks ?? []
      parkTicket = asks.find((ask) => ask.title === 'Wait for an answer')?.ticket
      if (!parkTicket) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.ok(parkTicket, 'park creates an ask before blocking')
    assert.equal((await run(['answer', parkTicket, 'parked value'])).status, 0)
    const parkedResult = await parked.done
    assert.equal(parkedResult.status, 0, parkedResult.stderr)
    assert.match(parkedResult.stdout, /parked value/)
    assert.equal(JSON.parse(parkedResult.stdout).ask.status, 'collected')

    const refused = await run(['answer', blockerTicket, 'one value'])
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /account.*enabled/)
    const closed = await run(['close', blockerTicket, 'No longer needed'])
    assert.equal(closed.status, 0, closed.stderr)
    assert.equal((await run(['show', blockerTicket, '--json'])).status, 0)
    assert.equal(JSON.parse((await run(['show', blockerTicket, '--json'])).stdout).status, 'cancelled')
    assert.equal((await run(['close', blockerTicket, 'Again'])).status, 5)
    assert.equal((await run(['show', 'ub_nope00'])).status, 3)
    assert.equal((await run(['answer'])).status, 2)
    assert.equal((await run(['file'], '{}')).status, 4)
  } finally {
    await daemon.close()
    rmSync(state, { recursive: true, force: true })
  }
})
