// Owner: Opus (try-before-prod slice 1, ADR 0119 in agent-rails). Implementers make it pass and never edit it.
// Alex, 2026-09-30: "if i approve scope, that defaults to prod. if i approve scope to test ... we'd be able to easily
// enter the responsible lane and actually test it in the local app for review". Approve to try is a third approval:
// it approves the scope (threads close, the tab moves to IN FLIGHT) but tells the PM to build a try copy and not to
// queue. Ship it is Alex's later yes on one build: only a person records it, only on a scope approved to try, and the
// PM hears the PR, head and build it must ship.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-30T19:00:00Z'
const HEAD = 'c'.repeat(40)
const sections = [
  { id: 'title', heading: 'Voice notes', body_md: 'Hold Note on a candidate and talk.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the Note button first.' },
]
const scopeWith = (slug, extra = {}) => ({
  version: 2, slug, title: 'Voice notes', pane: 'w5H:pT1', revision: 3, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: anchorInSection(sections[1], 'We build the Note button first'), author: 'agent', kind: 'question',
      status: 'open', recommendation: 'Note first', messages: [{ from: 'agent', text: 'Note or draft first?', at }], created_at: at },
  ],
  ...extra,
})

function stubs() {
  const dir = mkdtempSync(join(tmpdir(), 'try-stubs-'))
  const herdrLog = join(dir, 'herdr.log'), laneLog = join(dir, 'lane.log')
  const herdr = join(dir, 'herdr'), lane = join(dir, 'herdr-lane')
  writeFileSync(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> '${herdrLog}'
case "$1 $2" in
  "pane get") echo '{"result":{"pane":{"pane_id":"w5H:pT1","tab_id":"w5H:tAB","agent_status":"idle"}}}' ;;
  "tab get") echo '{"result":{"tab":{"tab_id":"w5H:tAB","label":"[scoping] voice notes"}}}' ;;
  "agent get") echo '{"result":{"agent":{"agent_status":"idle"}}}' ;;
esac
`)
  writeFileSync(lane, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${laneLog}'\n`)
  chmodSync(herdr, 0o700); chmodSync(lane, 0o700)
  process.env.HERDR_BIN_PATH = herdr
  process.env.UNBLOCK_HERDR_LANE = lane
  const read = (file) => { try { return readFileSync(file, 'utf8') } catch { return '' } }
  return { herdrLines: () => read(herdrLog), laneLines: () => read(laneLog) }
}

test('Approve to try approves the scope and tells the PM to build a try copy and not queue', async () => {
  const h = await startScopeHarness(scopeWith('voice'))
  const { request, bearer, until } = h
  const s = stubs()
  const approve = (body, headers = human) => request('/api/scope/voice/approve', { method: 'POST', headers, body })
  const get = async () => (await request('/api/scope/voice', { headers: human })).json.scope
  try {
    assert.equal((await approve({ mode: 'approve_to_try' }, bearer)).status, 403, 'a lane never approves')

    const ok = await approve({ mode: 'approve_to_try', comment: 'Make the Note button bigger.', client_id: 'try-1' })
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual(ok.json.closed, ['T1'], 'approving to try closes open threads like any approval')
    const scope = await get()
    assert.equal(scope.approval.mode, 'approve_to_try')
    assert.equal(scope.approval.comment, 'Make the Note button bigger.')
    assert.match(readFileSync(join(process.env.UNBLOCK_SCOPING_DIR, 'voice', 'APPROVAL.md'), 'utf8'), /Mode: approve_to_try/)

    const want = `[scoping voice] APPROVED TO TRY by Alex (r3, ${scope.approval.at_et}). Alex's note: "Make the Note button bigger." Build it on the project branch, start a try copy, label the PR try-build and don't queue it: it ships only when Alex presses Ship it. 1 open thread closed with your recommendation.`
    await until(() => s.herdrLines().includes(`agent prompt w5H:pT1 ${want}`), 'the approve-to-try line')
    await until(() => s.laneLines().includes('section w5H:tAB inflight'), 'the tab moves to IN FLIGHT')

    assert.equal((await approve({ mode: 'approve', client_id: 'try-2' })).status, 409, 'one approval per scope')
  } finally { await h.close() }
})

test('Approve to try needs no note, and the page offers the default the PM set', async () => {
  const h = await startScopeHarness(scopeWith('voice', { approve_default: 'try' }))
  const { request, until } = h
  const s = stubs()
  try {
    const scope = (await request('/api/scope/voice', { headers: human })).json.scope
    assert.equal(scope.approve_default, 'try')
    const ok = await request('/api/scope/voice/approve', { method: 'POST', headers: human, body: { mode: 'approve_to_try' } })
    assert.equal(ok.status, 200, ok.text)
    await until(() => /\[scoping voice\] APPROVED TO TRY by Alex \(r3, [^)]+\)\. Build it on the project branch/.test(s.herdrLines()), 'no note, no quote')
  } finally { await h.close() }
  const bad = await startScopeHarness(scopeWith('voice', { approve_default: 'later' }))
  try {
    const res = await bad.request('/api/scope/voice', { headers: human })
    assert.notEqual(res.json?.scope?.approve_default, 'later', 'an unknown default is never offered')
  } finally { await bad.close() }
})

test('Ship it: only a person, only on a scope approved to try; the PM hears the PR, head and build', async () => {
  const h = await startScopeHarness(scopeWith('voice'))
  const { request, bearer, until } = h
  const s = stubs()
  const ship = (body, headers = human) => request('/api/scope/voice/ship', { method: 'POST', headers, body })
  try {
    assert.equal((await ship({ pr: 3801, head: HEAD, build: 4 })).status, 409, 'nothing to ship before Approve to try')
    const ok = await request('/api/scope/voice/approve', { method: 'POST', headers: human, body: { mode: 'approve_to_try' } })
    assert.equal(ok.status, 200, ok.text)

    assert.equal((await ship({ pr: 3801, head: HEAD, build: 4 }, bearer)).status, 403, 'a lane never ships')
    assert.equal((await ship({ pr: 0, head: HEAD, build: 4 })).status, 400)
    assert.equal((await ship({ pr: 3801, head: 'not-a-sha', build: 4 })).status, 400)
    assert.equal((await ship({ pr: 3801, head: HEAD, build: 4, extra: 1 })).status, 400)

    const shipped = await ship({ pr: 3801, head: HEAD, build: 4, client_id: 'ship-1' })
    assert.equal(shipped.status, 200, shipped.text)
    const scope = (await request('/api/scope/voice', { headers: human })).json.scope
    const [record] = scope.ships
    assert.equal(record.pr, 3801); assert.equal(record.head, HEAD); assert.equal(record.build, 4)
    assert.equal(record.by, 'alex'); assert.equal(record.who, 'alex@example.com')
    assert.ok(existsSync(join(process.env.UNBLOCK_SCOPING_DIR, 'voice', 'SHIP-3801.md')))

    await until(() => s.herdrLines().includes(`agent prompt w5H:pT1 [voice] SHIP IT from Alex (${record.at_et}): build 4, PR #3801 at ${HEAD.slice(0, 7)}. Record it with python3 scripts/queue_pr.py ship 3801 --by aneym --via button --head ${HEAD} --evidence "unblock scope voice SHIP-3801.md", then queue it.`), 'the ship line')

    const again = await ship({ pr: 3801, head: HEAD, build: 4, client_id: 'ship-1' })
    assert.equal(again.status, 200); assert.equal(again.json.duplicate, true)
    assert.equal(s.herdrLines().split('\n').filter((line) => line.includes('SHIP IT')).length, 1, 'sent once')
  } finally { await h.close() }
})
