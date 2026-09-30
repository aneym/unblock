// Follow-ups to daily-workflow slice 8 (review advisories, 2026-09-30):
// 1. A weekly ask stops counting toward today everywhere, the web queue included,
//    because one helper (todayAsks) decides what "today" is.
// 2. A recheck that cannot be delivered is retried a few times, then given up,
//    instead of spawning lane-post every minute for as long as the ask is open.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-recheck2-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
process.env.UNBLOCK_RECHECK_AFTER_MS = '40'
process.env.UNBLOCK_WEEKLY_AFTER_MS = '100000'
const callLog = join(stateDir, 'lane-post-calls')
const lanePost = join(stateDir, 'lane-post-down')
writeFileSync(lanePost, `#!/bin/sh\nprintf 'call\\n' >> '${callLog}'\nexit 1\n`)
chmodSync(lanePost, 0o700)
process.env.UNBLOCK_LANE_POST_BIN = lanePost

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const qm = await import('../src/queue-model.js')
const authSecret = loadOrCreateSecret()

async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authSecret}`, ...(options.headers || {}) },
  })
  return { response, body: await response.json() }
}
const calls = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).length : 0)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('today means open and not on the weekly list, in the model and in the web queue', () => {
  assert.equal(typeof qm.todayAsks, 'function', 'queue-model exports todayAsks')
  const asks = [
    { ticket: 'a', status: 'open', created_at: 1 },
    { ticket: 'b', status: 'open', created_at: 2, weekly_at: 5 },
    { ticket: 'c', status: 'answered', created_at: 3 },
  ]
  assert.deepEqual(qm.todayAsks(asks).map((ask) => ask.ticket), ['a'])
  assert.deepEqual(qm.projectCounts(qm.todayAsks(asks)).reduce((n, [, c]) => n + c, 0), 1)
  const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /todayAsks\(/, 'the web queue builds its open list with todayAsks')
})

test('an undeliverable recheck is tried three times, then given up', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const res = await json(base, '/api/asks', {
      method: 'POST',
      body: JSON.stringify({
        ask: {
          kind: 'file', purpose: 'decision', title: 'Name the new tab', why: 'The lane needs a call on the tab name.',
          only_you: 'judgment', tried: ['The spec and past steers do not settle this.'],
          fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true, recommend: { value: 'Review', why: 'Matches the nav.' } }],
        },
        origin: { session_id: 's-a', pane_id: 'w5H:pGONE' },
      }),
    })
    assert.equal(res.response.status, 201, JSON.stringify(res.body))
    await wait(60)
    for (let i = 0; i < 5; i += 1) await daemon.sweep()
    assert.equal(calls(), 3, 'three attempts, then no more')
    const ask = (await json(base, `/api/asks/${res.body.ticket}`)).body
    assert.ok(ask.recheck_unavailable_at, 'the ask records that the recheck could not be delivered')
    assert.equal(ask.rechecked_at, undefined, 'it was never delivered')
    assert.equal(ask.status, 'open')
  } finally {
    await daemon.close()
  }
})
