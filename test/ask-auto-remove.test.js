// Owner test for spec AP (r42): handled asks remove themselves.
// Alex (2026-09-30 ~15:27 ET): "if i answered unblocks that were handled, we
// need to make sure that they're actually automatically removed btw."
// Case: ub_kskh5s stayed in his queue after the Codex seat that filed it had
// finished; its pane id belonged to p6, which was still alive.
// Thresholds and the sweep interval are env seams so this runs in seconds.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-autoremove-'))
const scopingDir = join(stateDir, 'scoping')
mkdirSync(scopingDir)
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
process.env.UNBLOCK_SCOPING_DIR = scopingDir
process.env.UNBLOCK_LIVEDOC_APPROVALS = '0'
process.env.UNBLOCK_LINK_CHECK_MS = '1'
for (const name of ['UNBLOCK_PORT', 'UNBLOCK_AUTH', 'UNBLOCK_ORIGIN_PID', 'HERDR_SESSION_ID', 'CLAUDE_SESSION_ID']) delete process.env[name]

// lane-post stub: logs every call; a post to w5H:pGONE fails like a pane that no longer exists.
const postLog = join(stateDir, 'lane-posts')
const lanePost = join(stateDir, 'lane-post-stub')
writeFileSync(lanePost, `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> '${postLog}'; done\nprintf '\\n' >> '${postLog}'\nfor a in "$@"; do [ "$a" = 'w5H:pGONE' ] && exit 1; done\nexit 0\n`)
chmodSync(lanePost, 0o700)
process.env.UNBLOCK_LANE_POST_BIN = lanePost
// herdr stub: typing into a pane is the wrong channel for all of this.
const herdrLog = join(stateDir, 'herdr-calls')
const herdr = join(stateDir, 'herdr-stub')
const panePids = join(stateDir, 'pane-pids.json')
const members = new Map()
function paneMember(pane, pid) {
  members.set(pane, [...new Set([...(members.get(pane) || []), pid])])
  writeFileSync(panePids, JSON.stringify(Object.fromEntries(members)))
}
writeFileSync(herdr, `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(herdrLog)}, process.argv.slice(2).join(' ') + '\\n')
if (process.argv[3] === 'process-info') {
  const pane = process.argv[5]
  const pids = JSON.parse(fs.readFileSync(${JSON.stringify(panePids)}, 'utf8'))[pane] || []
  console.log(JSON.stringify({ result: { process_info: { pane_id: pane, foreground_processes: pids.map(pid => ({ pid, name: 'node' })) } } }))
} else console.log(JSON.stringify({ result: { pane: { agent_status: 'idle' } } }))
`)
writeFileSync(panePids, '{}')
chmodSync(herdr, 0o700)
process.env.HERDR_BIN_PATH = herdr
// gh stub: prints {"state": <contents of gh-state>} and logs its argv.
const ghState = join(stateDir, 'gh-state')
const ghLog = join(stateDir, 'gh-calls')
const gh = join(stateDir, 'gh-stub')
writeFileSync(ghState, 'OPEN')
writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\nprintf '{"state":"%s"}\\n' "$(cat '${ghState}')"\n`)
chmodSync(gh, 0o700)
process.env.UNBLOCK_GH = gh

const cli = fileURLToPath(new URL('../bin/unblock.js', import.meta.url))
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const qm = await import('../src/queue-model.js')
const authSecret = loadOrCreateSecret()

const OFF = String(60 * 60 * 1000)
async function daemonWith(env) {
  const defaults = { UNBLOCK_SWEEP_MS: OFF, UNBLOCK_RECHECK_AFTER_MS: OFF, UNBLOCK_RECHECK_REPLY_MS: OFF }
  for (const [name, value] of Object.entries({ ...defaults, ...env })) process.env[name] = value
  const daemon = await startDaemon({ port: 0 })
  return { daemon, base: `http://127.0.0.1:${daemon.port}` }
}
async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authSecret}`, ...(options.headers || {}) },
  })
  return { response, body: await response.json() }
}
const decision = (title, extra = {}) => ({
  kind: 'file', purpose: 'decision', title, why: `The lane needs a call on ${title}.`,
  only_you: 'judgment', tried: ['The spec and past steers do not settle this.'],
  fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true, recommend: { value: 'Keep it short', why: 'Matches the other tabs.' } }],
  ...extra,
})
async function file(base, ask, origin) {
  const res = await json(base, '/api/asks', { method: 'POST', body: JSON.stringify({ ask, origin }) })
  assert.equal(res.response.status, 201, JSON.stringify(res.body))
  return res.body
}
const get = async (base, ticket) => (await json(base, `/api/asks/${ticket}`)).body
const webQueue = async (base) => (await json(base, '/api/asks?profile=*')).body.asks
const tickets = (asks) => asks.map((ask) => ask.ticket)
const posts = () => (existsSync(postLog) ? readFileSync(postLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\x1f').filter(Boolean)) : [])
const postsTo = (pane) => posts().filter((args) => args[args.indexOf('--to') + 1] === pane)
const typedIntoPane = () => existsSync(herdrLog) && readFileSync(herdrLog, 'utf8').includes('agent prompt')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, ms = 4000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await wait(50)
  }
  return false
}
function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const name of ['UNBLOCK_ORIGIN_PID', 'UNBLOCK_PORT', 'UNBLOCK_AUTH']) if (!(name in extra)) delete env[name]
  return env
}
function cliCommand(args, input, extra = {}) {
  // Async: the daemon runs in this process, so a blocking spawnSync would starve it (owner fix, r42 impl report).
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--json'], { env: cliEnv(extra), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill(), 20000)
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (status) => {
      clearTimeout(timer)
      assert.equal(status, 0, `unblock ${args.join(' ')} failed: ${stderr}`)
      resolve(JSON.parse(stdout))
    })
    child.stdin.end(input)
  })
}
async function cliList(...args) { return (await cliCommand(['list', ...args])).asks }
// A process that stays alive until the test tells it to exit.
function sleeper() {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'] })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  return { pid: child.pid, stop: async () => { child.stdin.end(); await exited } }
}
// SSE listener on the queue stream; returns the `open` count of every queue event.
function queueEvents(base) {
  const counts = []
  const controller = new AbortController()
  const done = (async () => {
    try {
      const response = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${authSecret}` }, signal: controller.signal })
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let at
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const data = block.split('\n').find((line) => line.startsWith('data: '))
          if (block.includes('event: queue') && data) counts.push(JSON.parse(data.slice(6)).open)
        }
      }
    } catch { /* aborted */ }
  })()
  return { counts, stop: async () => { controller.abort(); await done } }
}

test('done scenario: an ask filed from a short-lived process closes on the next sweep after it exits and leaves list and queue', async () => {
  const { daemon, base } = await daemonWith({ UNBLOCK_SWEEP_MS: '200' })
  const events = queueEvents(base)
  // The filer runs `unblock file` through a shell, the way an agent's Bash tool does,
  // then stays alive until its stdin closes.
  const askFile = join(stateDir, 'ask-placement.json')
  writeFileSync(askFile, JSON.stringify(decision('Enable file writes for the placement repair')))
  const filerScript = join(stateDir, 'filer.mjs')
  writeFileSync(filerScript, [
    "import { spawnSync } from 'node:child_process'",
    'const [node, cli, askFile] = process.argv.slice(2)',
    "const run = spawnSync('/bin/sh', ['-c', '\"$0\" \"$1\" file --json \"$2\"; true', node, cli, askFile], { encoding: 'utf8', env: process.env })",
    "process.stdout.write(JSON.stringify({ status: run.status, stdout: run.stdout, stderr: run.stderr }) + '\\n')",
    'process.stdin.resume()',
    "process.stdin.on('end', () => process.exit(0))",
  ].join('\n'))
  const filer = spawn(process.execPath, [filerScript, process.execPath, cli, askFile], {
    stdio: ['pipe', 'pipe', 'inherit'], env: cliEnv({ HERDR_PANE_ID: 'w5H:p6', UNBLOCK_AGENT: 'codex' }),
  })
  paneMember('w5H:p6', filer.pid)
  const exited = new Promise((resolve) => filer.once('exit', resolve))
  try {
    let out = ''
    for await (const chunk of filer.stdout) { out += chunk; if (out.includes('\n')) break }
    const run = JSON.parse(out.split('\n')[0])
    assert.equal(run.status, 0, run.stderr)
    const ticket = JSON.parse(run.stdout).ticket
    assert.match(ticket, /^ub_[a-z0-9]{6}$/)

    const filed = await get(base, ticket)
    assert.equal(filed.origin.pid, filer.pid, 'the filer is the nearest non-shell ancestor of the CLI, not the shell it ran in')
    assert.equal(typeof filed.origin.pid_start, 'string', 'the daemon records the filer\'s start time at file time')
    assert.ok(filed.origin.pid_start.length > 0)
    assert.equal(filed.origin.pane_id, 'w5H:p6', 'the pane id is still recorded, as the owner to route to')

    // While the filer lives, the ask stays through several interval sweeps.
    await wait(700)
    assert.equal((await get(base, ticket)).status, 'open', 'a live origin keeps its ask')
    assert.ok(tickets(await webQueue(base)).includes(ticket))

    filer.stdin.end()
    await exited
    const closed = await until(async () => (await get(base, ticket)).status !== 'open', 3000)
    assert.ok(closed, 'the ask closes on the interval sweep after its filer exits (UNBLOCK_SWEEP_MS)')
    const ask = await get(base, ticket)
    assert.equal(ask.status, 'cancelled')
    assert.equal(ask.close_reason, 'origin_finished')
    assert.ok(ask.closed_at)
    assert.ok(!tickets(await webQueue(base)).includes(ticket), 'gone from the web queue API')
    assert.ok(!tickets(qm.todayAsks(await webQueue(base))).includes(ticket))
    assert.ok(!tickets(await cliList()).includes(ticket), 'gone from `unblock list`')
    assert.ok(await until(() => events.counts.at(-1) === 0, 1000), `the queue stream drops it at once: ${JSON.stringify(events.counts)}`)
    assert.ok(events.counts.includes(1), 'the stream counted it while it was open')
    assert.equal(postsTo('w5H:p6').length, 0, 'closing a finished origin\'s ask tells nobody')
  } finally {
    if (filer.exitCode === null) { filer.stdin.end(); await exited }
    await events.stop()
    await daemon.close()
  }
})

// OS ancestry is the simulated edge; filing, persistence and process exit are real.
function processProbe(mode) {
  const previousPath = process.env.PATH
  const tools = mkdtempSync(join(stateDir, 'process-tools-'))
  const modeFile = join(tools, 'mode')
  const set = (value) => writeFileSync(modeFile, value)
  set(mode)
  writeFileSync(join(tools, 'ps'), `#!/bin/sh
if [ "$2" = 'ppid=,comm=' ]; then
  mode=$(cat '${modeFile}')
  if [ "$mode" = ssh ]; then
    if [ "$4" = '99999999' ]; then printf '1 sshd: user@pts/0\\n'; else printf '99999999 codex\\n'; fi
  elif [ "$mode" = unknown ]; then printf '1 worker\\n'
  else printf '1 node\\n'; fi
else
  for pid in $(printf '%s' "$4" | tr ',' ' '); do
    printf '%s Mon Oct 5 12:00:00 2026\\n' "$pid"
  done
fi
`)
  chmodSync(join(tools, 'ps'), 0o700)
  process.env.PATH = `${tools}:${previousPath}`
  return { set, restore: () => { process.env.PATH = previousPath } }
}

test('SSH-origin asks outlive their transport, including explicit PID bodies', async () => {
  const probe = processProbe('ssh')
  const { daemon, base } = await daemonWith({})
  const askFile = join(stateDir, 'ssh-ask.json')
  writeFileSync(askFile, JSON.stringify(decision('Choose the remote report title')))
  const script = `
    const { spawnSync } = require('node:child_process')
    const [node, cli, askFile] = process.argv.slice(1)
    const run = spawnSync(node, [cli, 'file', '--json', askFile], { encoding: 'utf8' })
    process.stdout.write(JSON.stringify({ status: run.status, stdout: run.stdout, stderr: run.stderr }) + '\\n')
    process.stdin.resume()
    process.stdin.on('end', () => process.exit(0))
  `
  const transport = spawn(process.execPath, ['-e', script, process.execPath, cli, askFile], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: cliEnv({ HERDR_PANE_ID: 'w5H:pSSH', LANE_NAME: 'remote-report', UNBLOCK_AGENT: 'codex' }),
  })
  const exited = new Promise((resolve) => transport.once('exit', resolve))
  try {
    let output = ''
    for await (const chunk of transport.stdout) { output += chunk; if (output.includes('\n')) break }
    const run = JSON.parse(output.split('\n')[0])
    assert.equal(run.status, 0, run.stderr)
    const automatic = JSON.parse(run.stdout)
    const explicit = await file(base, decision('Choose the remote review title'), {
      agent: 'codex', pane_id: 'w5H:pSSH', pid: transport.pid,
    })
    const init = await file(base, decision('Choose the fallback review title'), { agent: 'codex', pane_id: 'w5H:pSSH', pid: 1 })
    transport.stdin.end()
    await exited
    await daemon.sweep()
    for (const ask of [explicit, automatic, init]) {
      const current = await get(base, ask.ticket)
      assert.equal(current.status, 'open', 'SSH exit must not silently cancel the ask')
      assert.equal(current.origin.pid, undefined, 'a transport is not a pane lifecycle owner')
      assert.equal(current.origin.pane_id, 'w5H:pSSH')
      assert.ok(tickets(await webQueue(base)).includes(ask.ticket))
    }
    assert.equal(automatic.origin.lane_name, 'remote-report')
  } finally {
    if (transport.exitCode === null) { transport.stdin.end(); await exited }
    await daemon.close()
    probe.restore()
  }
})

test('only verified pane agents own lifecycle; overrides work and SSH keep relinquishes PID ownership', async () => {
  const probe = processProbe('local')
  const { daemon, base } = await daemonWith({})
  const seat = sleeper()
  paneMember('w5H:pOwner', seat.pid)
  try {
    const ask = await cliCommand(['file', '-'], JSON.stringify(decision('Choose the local report title')), {
      HERDR_PANE_ID: 'w5H:pOwner', UNBLOCK_AGENT: 'codex', UNBLOCK_ORIGIN_PID: String(seat.pid),
    })
    assert.equal(ask.origin.pid, seat.pid, 'the explicit override selects the verified agent, not the CLI parent')
    assert.equal(ask.origin.pid_verified, true)
    assert.ok(ask.origin.pid_start)
    const noPid = await cliCommand(['file', '-', '--origin', 'remote-review'], JSON.stringify({
      ask: decision('Choose the lane report title'), origin: { pane_id: 'w5H:pOwner', pid: seat.pid },
    }), { UNBLOCK_ORIGIN_PID: '1' })
    assert.equal(noPid.origin.pid, undefined, 'PID 1 disables tracking even for an explicit body')
    assert.equal(noPid.origin.lane_name, 'remote-review')
    const notMember = await file(base, decision('Choose the other report title'), {
      pane_id: 'w5H:pOther', agent: 'codex', pid: seat.pid, pid_verified: true,
    })
    assert.equal(notMember.origin.pid, undefined, 'an agent PID is not proof it owns another pane')
    probe.set('unknown')
    const unknown = await file(base, decision('Choose the unknown report title'), {
      pane_id: 'w5H:pOwner', agent: 'codex', pid: seat.pid,
    })
    assert.equal(unknown.origin.pid, undefined, 'unrecognized processes never own cleanup')
    probe.set('ssh')
    const kept = await cliCommand(['keep', ask.ticket])
    assert.equal(kept.ask.origin.pid, undefined, 'a remote claimant relinquishes the prior PID lifecycle')
    await seat.stop()
    await daemon.sweep()
    for (const filed of [ask, noPid, notMember, unknown]) assert.equal((await get(base, filed.ticket)).status, 'open')
  } finally {
    await seat.stop()
    await daemon.close()
    probe.restore()
  }
})

test('a pid that was not alive at file time is never recorded, so it can never close the ask', async () => {
  const { daemon, base } = await daemonWith({})
  try {
    const gone = sleeper()
    await gone.stop()
    const ask = await file(base, decision('Pick the report title'), { agent: 'codex', pane_id: 'w5H:pT2', pid: gone.pid })
    assert.equal(ask.origin.pid, undefined, 'a dead pid is dropped at file time')
    await daemon.sweep()
    assert.equal((await get(base, ask.ticket)).status, 'open')
  } finally {
    await daemon.close()
  }
})

test('a live origin stays; another process can claim an ask with keep', async () => {
  const { daemon, base } = await daemonWith({})
  const seat = sleeper()
  try {
    paneMember('w5H:pT3', process.pid)
    paneMember('w5H:pT3', seat.pid)
    const live = await file(base, decision('Order the nav tabs'), { agent: 'claude', pane_id: 'w5H:pT3', pid: process.pid })
    assert.equal(live.origin.pid, process.pid)
    const claimed = await cliCommand(['file', '-'], JSON.stringify(decision('Name the review lane')), {
      UNBLOCK_AGENT: 'codex', HERDR_PANE_ID: 'w5H:pT3', UNBLOCK_ORIGIN_PID: String(seat.pid),
    })
    assert.equal(claimed.origin.pid, seat.pid)
    const kept = await json(base, `/api/asks/${claimed.ticket}/keep`, { method: 'POST', body: JSON.stringify({ pid: process.pid }) })
    assert.equal(kept.response.status, 200, JSON.stringify(kept.body))
    assert.equal(kept.body.ask.origin.pid, process.pid, 'keep with a pid moves liveness to the claimer')
    assert.ok(kept.body.ask.kept_at)
    await seat.stop()
    await daemon.sweep()
    await daemon.sweep()
    assert.equal((await get(base, live.ticket)).status, 'open', 'a live origin keeps its ask')
    assert.equal((await get(base, claimed.ticket)).status, 'open', 'a claimed ask outlives its filer')
    const today = tickets(qm.todayAsks(await webQueue(base)))
    assert.ok(today.includes(live.ticket) && today.includes(claimed.ticket))

    // verify-r42 must-fix: when `ps` itself fails (fork failure, timeout under load), nothing is judged gone.
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    try { await daemon.sweep(); await daemon.sweep() } finally { process.env.PATH = path }
    assert.equal((await get(base, live.ticket)).status, 'open', 'a failed ps never closes a live ask')
    assert.equal((await get(base, claimed.ticket)).status, 'open', 'a failed ps never closes a claimed ask')
  } finally {
    await seat.stop()
    await daemon.close()
  }
})

test('dead references close the ask: a deleted permission path, a merged PR, a resolved scope comment', async () => {
  const { daemon, base } = await daemonWith({})
  try {
    const worktree = mkdtempSync(join(stateDir, 'factory-why-p4-'))
    const permission = await file(base, {
      kind: 'file', purpose: 'permission', title: 'Enable file writes for the repair', why: 'The seat is read-only.',
      permission: { tool: 'Write', path: worktree, summary: 'Write the placement file' },
    }, { agent: 'codex', pane_id: 'w5H:pT4' })
    const pr = await file(base, decision('Keep the PR title', { closes_on: ['https://github.com/shelf-group/agent-rails/pull/3827'] }), { agent: 'codex', pane_id: 'w5H:pT4' })
    mkdirSync(join(scopingDir, 'demo'))
    const scopeFile = join(scopingDir, 'demo', 'scope.json')
    const scope = (status) => JSON.stringify({ version: 2, slug: 'demo', threads: [{ id: 'T1', status, kind: 'question', author: 'agent', messages: [] }] })
    writeFileSync(scopeFile, scope('open'))
    const thread = await file(base, decision('Settle the comment question', { closes_on: ['scope:demo#T1'] }), { agent: 'claude', pane_id: 'w5H:pT4' })
    assert.deepEqual(thread.closes_on, ['scope:demo#T1'], 'closes_on is stored as filed')

    await daemon.sweep()
    for (const ask of [permission, pr, thread]) assert.equal((await get(base, ask.ticket)).status, 'open', `${ask.title} stays while its reference is live`)
    assert.ok(existsSync(ghLog) && readFileSync(ghLog, 'utf8').includes('pr view https://github.com/shelf-group/agent-rails/pull/3827'), 'the PR state is read with gh (UNBLOCK_GH)')

    rmSync(worktree, { recursive: true, force: true })
    writeFileSync(ghState, 'MERGED')
    writeFileSync(scopeFile, scope('resolved'))
    await daemon.sweep()
    const reasons = {}
    for (const ask of [permission, pr, thread]) {
      const now = await get(base, ask.ticket)
      assert.equal(now.status, 'cancelled', `${ask.title} closes`)
      reasons[ask.ticket] = now.close_reason
    }
    assert.equal(reasons[permission.ticket], 'path_gone')
    assert.equal(reasons[pr.ticket], 'link_closed')
    assert.equal(reasons[thread.ticket], 'thread_resolved')
    const queue = tickets(await webQueue(base))
    for (const ask of [permission, pr, thread]) assert.ok(!queue.includes(ask.ticket))
  } finally {
    writeFileSync(ghState, 'OPEN')
    await daemon.close()
  }
})

test('recheck at the threshold asks keep or close; no reply or an unreachable origin sets the ask aside, still findable', async () => {
  const { daemon, base } = await daemonWith({ UNBLOCK_RECHECK_AFTER_MS: '300', UNBLOCK_RECHECK_REPLY_MS: '300' })
  try {
    const silent = await file(base, decision('Pick the empty state copy'), { agent: 'claude', pane_id: 'w5H:pT5a' })
    const answering = await file(base, decision('Pick the badge color'), { agent: 'claude', pane_id: 'w5H:pT5b' })
    const unreachable = await file(base, decision('Pick the footer link'), { agent: 'claude', pane_id: 'w5H:pGONE' })
    const filedAt = Date.now()
    await daemon.sweep()
    assert.equal(postsTo('w5H:pT5a').length, 0, 'fresh asks are not rechecked')

    await wait(Math.max(0, filedAt + 350 - Date.now()))
    await daemon.sweep()
    const recheckedAt = Date.now() // the reply window runs from the recheck, not the filing (owner fix: timing under load)
    const sent = postsTo('w5H:pT5a')
    assert.equal(sent.length, 1, 'the recheck goes to the origin pane once')
    const text = sent[0].at(-1)
    assert.match(text, new RegExp(silent.ticket))
    assert.match(text, new RegExp(`unblock keep ${silent.ticket}`), 'the lane is told how to keep it')
    assert.match(text, /unblock_cancel/, 'and how to close it')
    assert.equal(sent[0][sent[0].indexOf('--topic') + 1], 'unblock-recheck')
    assert.equal(typedIntoPane(), false, 'never typed into a pane')

    const kept = await json(base, `/api/asks/${answering.ticket}/keep`, { method: 'POST', body: '{}' })
    assert.equal(kept.response.status, 200, JSON.stringify(kept.body))
    await daemon.sweep()
    await daemon.sweep()
    const gone = await get(base, unreachable.ticket)
    assert.ok(gone.set_aside_at, 'an origin that cannot be reached is set aside after the retries')
    assert.equal(gone.set_aside_reason, 'origin_unreachable')

    await wait(Math.max(0, recheckedAt + 350 - Date.now()))
    await daemon.sweep()
    const aside = await get(base, silent.ticket)
    assert.ok(aside.set_aside_at, 'no reply within UNBLOCK_RECHECK_REPLY_MS sets it aside')
    assert.equal(aside.set_aside_reason, 'no_reply')
    assert.equal(aside.status, 'open', 'set aside is not closed')
    assert.equal((await get(base, answering.ticket)).set_aside_at, undefined, 'a kept ask stays in today')

    const today = tickets(qm.todayAsks(await webQueue(base)))
    assert.ok(today.includes(answering.ticket))
    assert.ok(!today.includes(silent.ticket) && !today.includes(unreachable.ticket), 'set-aside asks leave today\'s queue')
    assert.ok(!tickets(await cliList()).includes(silent.ticket), '`unblock list` leaves it out')
    assert.ok(tickets(await cliList('--aside')).includes(silent.ticket), '`unblock list --aside` still finds it')
    assert.ok(tickets(await webQueue(base)).includes(silent.ticket), 'the API still returns it, so it stays findable')
    const deck = qm.selectDeck({ asks: await webQueue(base) })
    assert.ok(!deck.items.flatMap((item) => item.asks.map((ask) => ask.ticket)).includes(silent.ticket))

    const back = await json(base, `/api/asks/${silent.ticket}/keep`, { method: 'POST', body: '{}' })
    assert.equal(back.response.status, 200)
    assert.equal(back.body.ask.set_aside_at, undefined, 'keep brings a set-aside ask back to today')
  } finally {
    await daemon.close()
  }
})

test('an answer to an ask whose origin is gone goes to the owner pane by lane-post, and Alex sees nothing more', async () => {
  const { daemon, base } = await daemonWith({})
  const seat = sleeper()
  try {
    paneMember('w5H:p6', seat.pid)
    const ask = await file(base, decision('Choose the placement rule'), { agent: 'codex', pane_id: 'w5H:p6', pid: seat.pid })
    assert.equal(ask.origin.pid, seat.pid)
    await seat.stop()
    const before = posts().length
    const answered = await json(base, `/api/asks/${ask.ticket}/answer`, { method: 'POST', body: JSON.stringify({ values: { answer: 'blue-7Q' } }) })
    assert.equal(answered.response.status, 200, JSON.stringify(answered.body))
    assert.ok(await until(() => posts().length > before, 3000), 'the owner gets a lane-post')
    const sent = posts().slice(before)
    assert.equal(sent.length, 1, 'one post, nothing else')
    const args = sent[0]
    assert.equal(args[args.indexOf('--to') + 1], 'w5H:p6', 'it goes to the pane the origin carried (the owner)')
    const text = args.at(-1)
    assert.match(text, new RegExp(ask.ticket))
    assert.match(text, /origin finished; act or drop/)
    assert.match(text, /blue-7Q/, 'the answer itself is routed')
    assert.equal(typedIntoPane(), false)
    const now = await get(base, ask.ticket)
    assert.equal(now.status, 'orphaned', 'the answer is claimable by ticket but no longer Alex\'s')
    assert.ok(now.routed_at)
    assert.ok(!tickets(await webQueue(base)).includes(ask.ticket), 'gone from the web queue, answered list included')
    await daemon.sweep()
    assert.equal(posts().length, before + 1, 'a sweep does not route it again')
  } finally {
    await seat.stop()
    await daemon.close()
  }
})

test('the statusline and today\'s counts leave out set-aside and weekly asks', () => {
  const asks = [
    { ticket: 'a', status: 'open', created_at: 1 },
    { ticket: 'b', status: 'open', created_at: 2, set_aside_at: 5 },
    { ticket: 'c', status: 'open', created_at: 3, weekly_at: 5 },
  ]
  assert.deepEqual(tickets(qm.todayAsks(asks)), ['a'])
  const statusline = readFileSync(new URL('../bin/unblock-statusline.sh', import.meta.url), 'utf8')
  assert.match(statusline, /set_aside_at/, 'the herdr statusline skips set-aside asks')
  assert.match(statusline, /weekly_at/, 'and weekly ones')
})
