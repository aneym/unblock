// Scenario for daily-workflow slice 8 (agent-rails docs/prd/daily-workflow/PRD.md):
// "An ask that sits for a day goes back to the lane that filed it. If your past
// answers settle it, the lane closes it and quotes you. After three days, an ask
// moves to a weekly 'decide or drop' list and stops counting toward today."
// The recheck reaches the lane through lane-post (hook delivery), never by typing
// into its pane. Thresholds are env seams; the defaults are 24 h and 72 h.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-recheck-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
const recheckAfterMs = 1500
const weeklyAfterMs = 4000
process.env.UNBLOCK_RECHECK_AFTER_MS = String(recheckAfterMs)
process.env.UNBLOCK_WEEKLY_AFTER_MS = String(weeklyAfterMs)
const postLog = join(stateDir, 'lane-posts')
const lanePost = join(stateDir, 'lane-post-stub')
writeFileSync(lanePost, `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> '${postLog}'; done\nprintf '\\n' >> '${postLog}'\n`)
chmodSync(lanePost, 0o700)
process.env.UNBLOCK_LANE_POST_BIN = lanePost
// Typing into a pane is the wrong channel for this; a herdr call would land here.
const herdrLog = join(stateDir, 'herdr-calls')
const herdr = join(stateDir, 'herdr-stub')
writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${herdrLog}'\nprintf '{"result":{"pane":{"agent_status":"idle"}}}'\n`)
chmodSync(herdr, 0o700)
process.env.HERDR_BIN_PATH = herdr

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

const decision = (title) => ({
  kind: 'file', purpose: 'decision', title, why: `The lane needs a call on ${title}.`,
  only_you: 'judgment', tried: ['The spec and past steers do not settle this.'],
  fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true, recommend: { value: 'Keep it short', why: 'Matches the other tabs.' } }],
})
const created = (res) => { assert.equal(res.response.status, 201, JSON.stringify(res.body)); return res.body }
const posts = () => (existsSync(postLog) ? readFileSync(postLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\x1f').filter(Boolean)) : [])
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('a day-old ask goes back to its lane once; a three-day-old ask moves to the weekly list', async () => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`
  try {
    const stale = created(await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: decision('Name the new tab'), origin: { session_id: 's-a', pane_id: 'w5H:pAA' } }),
    }))
    const staleCreatedAt = Date.now()
    const answered = created(await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: decision('Pick the chip color'), origin: { session_id: 's-b', pane_id: 'w5H:pBB' } }),
    }))
    await json(base, `/api/asks/${answered.ticket}/answer`, { method: 'POST', body: JSON.stringify({ values: { answer: 'blue' } }) })

    // Fresh asks are not rechecked.
    await daemon.sweep()
    assert.deepEqual(posts(), [])

    await wait(Math.max(0, staleCreatedAt + recheckAfterMs + 50 - Date.now()))
    await daemon.sweep()
    const sent = posts()
    assert.equal(sent.length, 1, 'only the still-open ask is sent back, once')
    const args = sent[0]
    assert.ok(args.includes('post'))
    assert.equal(args[args.indexOf('--to') + 1], 'w5H:pAA', 'it goes to the lane that filed it')
    assert.equal(args[args.indexOf('--kind') + 1], 'task')
    const text = args[args.length - 1]
    assert.match(text, new RegExp(stale.ticket))
    assert.match(text, /Name the new tab/)
    assert.match(text, /unblock_cancel/, 'the lane is told how to close it')
    assert.match(text, /quote/i, 'and to quote Alex when his past answers settle it')
    assert.equal(existsSync(herdrLog) && readFileSync(herdrLog, 'utf8').includes('agent prompt'), false, 'never typed into a pane')
    const rechecked = (await json(base, `/api/asks/${stale.ticket}`)).body
    assert.ok(rechecked.rechecked_at, 'the ask records when it was sent back')
    assert.equal(rechecked.status, 'open', 'the recheck alone closes nothing')

    await daemon.sweep()
    assert.equal(posts().length, 1, 'a second sweep does not send it again')

    // Three days on, still open: it leaves today's list for the weekly one.
    await wait(Math.max(0, staleCreatedAt + weeklyAfterMs + 50 - Date.now()))
    await daemon.sweep()
    const weekly = (await json(base, `/api/asks/${stale.ticket}`)).body
    assert.ok(weekly.weekly_at, 'the ask records when it moved to the weekly list')
    assert.equal(weekly.status, 'open', 'decide or drop is still Alex\'s call')
    assert.equal(posts().length, 1, 'moving to the weekly list sends nothing new')

    const fresh = created(await json(base, '/api/asks', {
      method: 'POST', body: JSON.stringify({ ask: decision('Order the nav'), origin: { session_id: 's-c', pane_id: 'w5H:pCC' } }),
    }))
    const asks = (await json(base, '/api/asks')).body.asks
    const deck = qm.selectDeck({ asks })
    const today = deck.items.flatMap((item) => item.asks.map((ask) => ask.ticket))
    assert.deepEqual(today, [fresh.ticket], 'the weekly ask no longer counts toward today')
    assert.equal(deck.remaining, 1)
    assert.deepEqual(deck.weekly.map((ask) => ask.ticket), [stale.ticket], 'it sits on the weekly decide-or-drop list')
  } finally {
    await daemon.close()
  }
})
