// Owner: Opus (r17, approve scope). Implementers make it pass and never edit it.
// Alex, 2026-09-29: "the scoping tool needs a submit scoping + final comment button because typically that's what
// i'll do." Approving marks the scope approved (who, when in ET, the revision), closes open comments with the lane's
// recommendation standing, sends the lane one line (APPROVED, his note verbatim, "Move to build."), logs it in the
// scoping INDEX, and moves the lane's herdr tab from SCOPING to IN FLIGHT. "Approve with changes" asks the lane to fold
// his note in first; "Not yet" only sends the note. Only Alex approves: the page, voice or the Admin relay, never a lane.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-e2e-0123456789abcdefghijklmnopqrstuv'
const at = '2026-09-29T19:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first. Then the voice. The runner is Executor.' },
]
const on = (quote) => anchorInSection(sections[1], quote)
const scopeWith = (slug) => ({
  version: 2, slug, title: 'Demo scope', pane: 'w5H:pT1', revision: 3, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: on('We build the page first'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Page first', messages: [{ from: 'agent', text: 'Page or voice first?', at }], created_at: at },
    { id: 'T2', anchor: on('Then the voice'), author: 'alex', kind: 'comment', status: 'open',
      messages: [{ from: 'alex', text: 'Voice can wait.', at }], created_at: at },
    { id: 'T3', anchor: on('The runner is Executor'), author: 'agent', kind: 'question', status: 'parked', parked_at: at,
      recommendation: 'Executor', messages: [{ from: 'agent', text: 'Which runner?', at }], created_at: at },
  ],
})

// herdr answers pane and tab lookups; herdr-lane records the section move.
function stubs() {
  const dir = mkdtempSync(join(tmpdir(), 'approve-stubs-'))
  const herdrLog = join(dir, 'herdr.log'), laneLog = join(dir, 'lane.log')
  const herdr = join(dir, 'herdr'), lane = join(dir, 'herdr-lane')
  writeFileSync(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> '${herdrLog}'
case "$1 $2" in
  "pane get") echo '{"result":{"pane":{"pane_id":"w5H:pT1","tab_id":"w5H:tAB","agent_status":"idle"}}}' ;;
  "tab get") echo '{"result":{"tab":{"tab_id":"w5H:tAB","label":"[scoping] demo scope"}}}' ;;
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

const ET = /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M ET$/

test('Alex approves with a note: approved, comments closed with the recommendation, one lane line, INDEX, tab moved', async () => {
  const h = await startScopeHarness(scopeWith('demo'))
  const { request, bearer, until } = h
  const s = stubs()
  const approve = (body, headers = human) => request('/api/scope/demo/approve', { method: 'POST', headers, body })
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  const index = join(process.env.UNBLOCK_SCOPING_DIR, 'INDEX.md')
  writeFileSync(index, '# Scoping\n\n## Scoping (w5H)\n| Tab | Pane |\n|---|---|\n')
  try {
    const events = await h.stream('/api/scope/demo/events')

    // 1. Lanes never approve; bad bodies change nothing.
    assert.equal((await approve({ mode: 'approve', comment: 'ship' }, bearer)).status, 403)
    assert.equal((await approve({ mode: 'maybe' })).status, 400)
    assert.equal((await approve({ mode: 'approve', comment: 42 })).status, 400)
    assert.equal((await approve({ mode: 'approve_with_changes', comment: '  ' })).status, 400, 'with changes needs a note')
    assert.equal((await approve({ mode: 'not_yet' })).status, 400, 'not yet needs a note')
    assert.equal((await approve({ mode: 'approve', comment: 'x'.repeat(4001) })).status, 400)
    assert.equal((await get()).approval, undefined)

    // 2. Approve with his final note.
    const note = 'Use Aside to make the ElevenLabs key, then just finish it.\nKeep the page light.'
    const ok = await approve({ mode: 'approve', comment: note, client_id: 'appr-1' })
    assert.equal(ok.status, 200, ok.text)
    assert.deepEqual(ok.json.closed, ['T1', 'T2'], 'open comments close; the parked one stays parked')
    const scope = await get()
    assert.equal(scope.approval.mode, 'approve')
    assert.equal(scope.approval.by, 'alex')
    assert.equal(scope.approval.who, 'alex@example.com')
    assert.equal(scope.approval.revision, 3)
    assert.equal(scope.approval.comment, note, 'his note is stored verbatim')
    assert.ok(Date.parse(scope.approval.at))
    assert.match(scope.approval.at_et, ET)
    const [t1, t2, t3] = scope.threads
    assert.equal(t1.status, 'resolved'); assert.equal(t1.resolution.how, 'approve'); assert.equal(t1.resolution.decision, 'Page first')
    assert.equal(t2.status, 'resolved'); assert.equal(t2.resolution.how, 'approve'); assert.equal(t2.resolution.decision, 'Approved with the scope')
    assert.equal(t3.status, 'parked')
    await events.next('scope', (d) => d.scope?.approval?.mode === 'approve')

    // 3. The lane gets one line: APPROVED, his note verbatim (on one line), move to build.
    const want = `[scoping demo] APPROVED by Alex (r3, ${scope.approval.at_et}). Alex's note: "Use Aside to make the ElevenLabs key, then just finish it. Keep the page light." Move to build. 2 open comments closed with your recommendations.`
    await until(() => s.herdrLines().includes(`agent prompt w5H:pT1 ${want}`), 'the approval line in the lane pane')
    assert.equal(s.herdrLines().split('\n').filter((line) => line.includes('APPROVED')).length, 1, 'sent once')
    assert.ok(!s.herdrLines().includes('(new T'), 'closing comments sends no per-comment notes')

    // 4. INDEX log and the tab move out of SCOPING.
    const logged = readFileSync(index, 'utf8')
    assert.match(logged, /## Approvals\n/)
    assert.match(logged, /- [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M ET · demo r3 · approved · "Use Aside to make the ElevenLabs key/)
    assert.ok(logged.startsWith('# Scoping\n\n## Scoping (w5H)'), 'the rest of INDEX is untouched')
    await until(() => s.laneLines().includes('section w5H:tAB inflight --by alex --note scope approved r3'), 'the tab moves to IN FLIGHT')
    await until(() => s.herdrLines().includes('tab rename w5H:tAB demo scope'), 'the [scoping] prefix is dropped')

    // 5. A retry never lands twice; a second approval is refused.
    const again = await approve({ mode: 'approve', comment: note, client_id: 'appr-1' })
    assert.equal(again.status, 200); assert.equal(again.json.duplicate, true)
    assert.equal((await approve({ mode: 'approve', comment: 'again', client_id: 'appr-2' })).status, 409)
    assert.equal((await approve({ mode: 'not_yet', comment: 'wait', client_id: 'appr-3' })).status, 409)
    events.close()
  } finally { await h.close() }
})

test('not yet sends only his note; with changes asks the lane to fold it in first; the Admin relay approves as Alex', async () => {
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = RELAY
  const h = await startScopeHarness(scopeWith('demo'))
  const { request, until } = h
  const s = stubs()
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  const index = join(process.env.UNBLOCK_SCOPING_DIR, 'INDEX.md')
  try {
    // Not yet: no approval of the doc, comments stay open, the tab stays, the lane hears his note.
    const wait = await request('/api/scope/demo/approve', { method: 'POST', headers: human, body: { mode: 'not_yet', comment: 'Show me the phone layout first.' } })
    assert.equal(wait.status, 200, wait.text)
    assert.deepEqual(wait.json.closed, [])
    const held = await get()
    assert.equal(held.approval.mode, 'not_yet')
    assert.ok(held.threads.filter((t) => t.status === 'open').length === 2)
    await until(() => s.herdrLines().includes('agent prompt w5H:pT1 [scoping demo] NOT YET from Alex (r3): "Show me the phone layout first." Keep scoping; answer it on the doc.'), 'the not-yet line')
    assert.match(readFileSync(index, 'utf8'), /· demo r3 · not yet · "Show me the phone layout first\."/, 'INDEX is created with the log when missing')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(s.laneLines(), '', 'not yet never moves the tab')

    // With changes, from Admin (the relay): approves, marks it in Admin, asks for the fold first.
    const relayed = await request('/api/scope/demo/approve', { method: 'POST', headers: { 'X-Unblock-Relay': RELAY },
      body: { mode: 'approve_with_changes', comment: 'Drop the settings page.', client_id: 'admin-1' } })
    assert.equal(relayed.status, 200, relayed.text)
    const done = await get()
    assert.equal(done.approval.mode, 'approve_with_changes')
    assert.equal(done.approval.via, 'admin')
    assert.deepEqual(relayed.json.closed, ['T1', 'T2'])
    await until(() => s.herdrLines().includes(`agent prompt w5H:pT1 [scoping demo] APPROVED WITH CHANGES by Alex in Admin (r3, ${done.approval.at_et}). Alex's note: "Drop the settings page." Fold his note into the doc first (unblock scope patch), then move to build. 2 open comments closed with your recommendations.`), 'the with-changes line')
    await until(() => s.laneLines().includes('section w5H:tAB inflight'), 'the tab moves')
    assert.match(readFileSync(index, 'utf8'), /· demo r3 · approved with changes · "Drop the settings page\."/)
  } finally { await h.close(); delete process.env.UNBLOCK_ADMIN_RELAY_TOKEN }
})

test('a long note reaches the lane in full through APPROVAL.md; an approval with no note is fine', async () => {
  const h = await startScopeHarness(scopeWith('demo'))
  const { request, until } = h
  const s = stubs()
  try {
    const long = `Start with the key. ${'Then wire the page and test it on the phone. '.repeat(20)}Done.`.trim()
    const ok = await request('/api/scope/demo/approve', { method: 'POST', headers: human, body: { mode: 'approve', comment: long } })
    assert.equal(ok.status, 200, ok.text)
    const file = join(process.env.UNBLOCK_SCOPING_DIR, 'demo', 'APPROVAL.md')
    assert.ok(readFileSync(file, 'utf8').includes(long), 'the full note is on disk')
    await until(() => /APPROVED by Alex .*Alex's note \(long, in full at .*APPROVAL\.md\): "Start with the key\./.test(s.herdrLines()), 'a pointer to the full note')
    const line = s.herdrLines().split('\n').find((l) => l.includes('APPROVED'))
    assert.ok(line.length < 900, 'the pane line stays short')
    assert.match(line, /Move to build\./)
  } finally { await h.close() }
  const bare = await startScopeHarness(scopeWith('demo'))
  const t = stubs()
  try {
    const ok = await bare.request('/api/scope/demo/approve', { method: 'POST', headers: human, body: { mode: 'approve' } })
    assert.equal(ok.status, 200, ok.text)
    assert.equal((await bare.request('/api/scope/demo', { headers: human })).json.scope.approval.comment, '')
    await bare.until(() => /\[scoping demo\] APPROVED by Alex \(r3, [^)]+\)\. Move to build\. 2 open comments closed/.test(t.herdrLines()), 'no note, no quote')
  } finally { await bare.close() }
})
