// Owner test: one recheck nag per card per window (2026-10-10, P0 from w5H:p164).
// Case: ub_pxxshm's 30-min recheck went out three times in two minutes, and once more after
// `unblock keep`. lane-post often runs past 5 s (it syncs bulletins after posting); the daemon
// killed it at 5 s, counted a failure and re-sent on the next sweep.
// The daemon, its sweep and the CLI are real; lane-post is a stub that logs each post.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-recheck-once-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
process.env.UNBLOCK_LIVEDOC_APPROVALS = '0'
for (const name of ['UNBLOCK_PORT', 'UNBLOCK_AUTH', 'UNBLOCK_ORIGIN_PID', 'HERDR_SESSION_ID', 'CLAUDE_SESSION_ID', 'UNBLOCK_LANE_POST_TIMEOUT_MS']) delete process.env[name]

// lane-post stub: logs the pane it posts to, then behaves as the file `mode` says:
// "slow" sleeps 5.5 s (past the old 5 s kill) and logs "done", "fail" exits 1, anything else exits 0.
const postLog = join(stateDir, 'posts')
const modeFile = join(stateDir, 'mode')
const lanePost = join(stateDir, 'lane-post-stub')
writeFileSync(lanePost, `#!/bin/sh
to=''; prev=''
for a in "$@"; do [ "$prev" = '--to' ] && to="$a"; prev="$a"; done
echo "post $to" >> '${postLog}'
mode=$(cat '${modeFile}')
if [ "$mode" = slow ]; then sleep 5.5; echo "done $to" >> '${postLog}'; fi
[ "$mode" = fail ] && exit 1
exit 0
`)
chmodSync(lanePost, 0o700)
process.env.UNBLOCK_LANE_POST_BIN = lanePost

const cli = fileURLToPath(new URL('../bin/unblock.js', import.meta.url))
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const authSecret = loadOrCreateSecret()
const OFF = String(60 * 60 * 1000)

async function daemonWith(env) {
  for (const [name, value] of Object.entries({ UNBLOCK_RECHECK_REPLY_MS: OFF, ...env })) process.env[name] = value
  const daemon = await startDaemon({ port: 0 })
  return { daemon, base: `http://127.0.0.1:${daemon.port}` }
}
async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authSecret}` } })
  return { response, body: await response.json() }
}
async function file(base, title, pane) {
  const ask = { kind: 'file', purpose: 'decision', title, why: `The lane needs a call on ${title}.`, only_you: 'judgment',
    tried: ['The spec and past steers do not settle this.'], fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true, recommend: { value: 'Keep it short', why: 'Matches the other tabs.' } }] }
  const res = await json(base, '/api/asks', { method: 'POST', body: JSON.stringify({ ask, origin: { agent: 'claude', pane_id: pane } }) })
  assert.equal(res.response.status, 201, JSON.stringify(res.body))
  return res.body
}
const get = async (base, ticket) => (await json(base, `/api/asks/${ticket}`)).body
const lines = (prefix, pane) => (existsSync(postLog) ? readFileSync(postLog, 'utf8').split('\n') : []).filter((l) => l === `${prefix} ${pane}`).length
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
function keep(ticket) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const name of ['UNBLOCK_PORT', 'UNBLOCK_AUTH', 'UNBLOCK_ORIGIN_PID']) delete env[name]
    const child = spawn(process.execPath, [cli, 'keep', ticket, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => { assert.equal(code, 0, err); resolve(JSON.parse(out)) })
  })
}

test('a lane-post that runs past its deadline is not killed or resent: one nag across many sweeps', async () => {
  writeFileSync(modeFile, 'slow')
  const { daemon, base } = await daemonWith({ UNBLOCK_SWEEP_MS: '200', UNBLOCK_RECHECK_AFTER_MS: '300', UNBLOCK_LANE_POST_TIMEOUT_MS: '1500' })
  try {
    const ask = await file(base, 'Pick the slow lane title', 'w5P:pSlow')
    await wait(12500)
    assert.equal(lines('post', 'w5P:pSlow'), 1, 'exactly one nag in the window, however slow lane-post is')
    assert.equal(lines('done', 'w5P:pSlow'), 1, 'the slow post ran to the end; it was detached, not killed')
    const now = await get(base, ask.ticket)
    assert.ok(now.rechecked_at, 'a post still running at the deadline counts as sent')
    assert.equal(now.set_aside_at, undefined, 'a slow post never sets the ask aside')
  } finally {
    await daemon.close()
  }
})

test('after keep, no nag until the keep window ends; then exactly one', async () => {
  writeFileSync(modeFile, 'ok')
  const { daemon, base } = await daemonWith({ UNBLOCK_SWEEP_MS: '100', UNBLOCK_RECHECK_AFTER_MS: '1500' })
  try {
    const ask = await file(base, 'Pick the kept lane title', 'w5P:pKept')
    await wait(900)
    const kept = await keep(ask.ticket)
    const keptAt = kept.ask.kept_at
    assert.ok(keptAt)
    await wait(Math.max(0, keptAt + 1200 - Date.now()))
    assert.equal(lines('post', 'w5P:pKept'), 0, 'past the filing window but inside the keep window: no nag')
    await wait(Math.max(0, keptAt + 2600 - Date.now()))
    assert.equal(lines('post', 'w5P:pKept'), 1, 'the keep window ended: one nag')
    await wait(800)
    assert.equal(lines('post', 'w5P:pKept'), 1, 'and only one')
  } finally {
    await daemon.close()
  }
})

test('a post that fails retries only in the next window, then sets the ask aside', async () => {
  writeFileSync(modeFile, 'fail')
  const { daemon, base } = await daemonWith({ UNBLOCK_SWEEP_MS: '100', UNBLOCK_RECHECK_AFTER_MS: '1000' })
  try {
    const ask = await file(base, 'Pick the failing lane title', 'w5P:pFail')
    const filedAt = Date.now()
    await wait(Math.max(0, filedAt + 1700 - Date.now()))
    assert.equal(lines('post', 'w5P:pFail'), 1, 'one attempt in the first window, not one per sweep')
    assert.equal((await get(base, ask.ticket)).set_aside_at, undefined)
    await wait(Math.max(0, filedAt + 3000 - Date.now()))
    assert.equal(lines('post', 'w5P:pFail'), 2, 'one retry in the next window')
    const aside = await get(base, ask.ticket)
    assert.equal(aside.set_aside_reason, 'origin_unreachable', 'the second failure sets it aside')
    await wait(1200)
    assert.equal(lines('post', 'w5P:pFail'), 2, 'nothing more once set aside')
  } finally {
    await daemon.close()
  }
})
