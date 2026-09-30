// Owner: Opus (r26, review advisories from r19, r20 and r23). Implementers make it pass and never edit it.
// deliver(): a scope that can't name a section never throws out of delivery (the next note still arrives); a
// no_pane note is marked once, not on every retry tick; a cut voice lane note never splits a surrogate pair.
// Live-doc approvals: the first run with no state records what exists without logging or moving tabs; one doc that
// can't be logged doesn't stop the others; a failed state write never logs the same line on every tick.
// Voice approve: a spoken id reads as "that one" while the filed note keeps his words; a retried confirm reuses
// the proposal's client_id, and a new proposal gets a new one.
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'
import { createLivedocApprovals } from '../src/scope-approvals.js'
import { anchorInSection } from '../src/scope-doc.js'
import { createScopeVoiceSession } from '../src/scope-voice.js'

const at = '2026-09-30T01:00:00Z'
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [
    { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
    { id: 'plan', heading: 'The plan', body_md: 'We ship the page first.' },
  ] },
  threads: [],
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Budgets are generous so a loaded Studio doesn't flake; each wait ends as soon as its condition holds.
async function waitFor(check, what, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await check()) return; await sleep(30) }
  assert.fail(`${what} not reached within ${ms / 1000}s`)
}
const prompts = (h, pane) => h.paneLines().split('\n').filter((line) => line.startsWith(`agent prompt ${pane} `))

test('a scope with no doc never throws out of delivery; the tag falls back to the section id and the next note still arrives', async () => {
  process.env.UNBLOCK_SCOPE_PAUSE_MS = '100'
  const rejections = []
  const onReject = (error) => rejections.push(error)
  process.on('unhandledRejection', onReject)
  const h = await startScopeHarness(scope)
  const flag = join(mkdtempSync(join(tmpdir(), 'scope-r26-')), 'hold')
  try {
    const stub = process.env.HERDR_BIN_PATH
    writeFileSync(flag, '')
    writeFileSync(stub, readFileSync(stub, 'utf8') + `[ "$1 $2 $3" = "agent get w5H:pT2" ] && [ -f '${flag}' ] && echo '{"result":{"agent":{"agent_status":"blocked"}}}'\nexit 0\n`)
    const posted = await h.request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: { section: 'plan', quote: 'We ship the page first' }, text: 'look here @pT2' } })
    assert.equal(posted.status, 201, posted.text)
    await waitFor(() => prompts(h, 'w5H:pT1').length === 1 && h.paneLines().split('agent get w5H:pT2').length >= 3, 'own pane delivered and the tag held')
    // A lane rewrites scope.json without its doc (a bad write); the held tag is still pending.
    const current = (await h.request('/api/scope/demo', { headers: human })).json.scope
    h.writeScope({ ...current, doc: undefined })
    await sleep(300)
    rmSync(flag)
    await waitFor(() => rejections.length || prompts(h, 'w5H:pT2').length, 'the tag delivered or delivery threw')
    assert.deepEqual(rejections.map(String), [], 'deliver() threw out of the daemon')
    assert.match(prompts(h, 'w5H:pT2')[0], /tagged you on T1 \(§plan "/, 'the heading falls back to the section id')
    h.writeScope(current)
    const next = await h.request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: { section: 'title', quote: 'Demo scope' }, text: 'second thought here' } })
    assert.equal(next.status, 201, next.text)
    await waitFor(() => prompts(h, 'w5H:pT1').some((line) => line.includes('second thought here')), 'the next note reached the pane', 10000)
  } finally {
    // A throw out of deliver() wedges the slug, and daemon close waits on it forever: end the run instead of hanging.
    if (rejections.length) setTimeout(() => process.exit(1), 60000).unref()
    else await h.close()
    process.off('unhandledRejection', onReject)
    delete process.env.UNBLOCK_SCOPE_PAUSE_MS
  }
})

test('a no_pane note is marked once, not again on every retry tick', async () => {
  const h = await startScopeHarness({ ...scope, pane: '' })
  const events = []
  const req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/scope/demo/events', headers: human }, (res) => {
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (/^event: note$/m.test(frame)) events.push(JSON.parse(frame.match(/^data: (.+)$/m)[1]))
      }
    })
  })
  req.on('error', () => {})
  req.end()
  try {
    const other = join(process.env.UNBLOCK_SCOPING_DIR, 'plan2')
    mkdirSync(other)
    writeFileSync(join(other, 'scope.json'), JSON.stringify({ ...scope, slug: 'plan2', pane: 'w5H:pOTHER' }))
    const stub = process.env.HERDR_BIN_PATH
    writeFileSync(stub, readFileSync(stub, 'utf8') + '[ "$3" = "w5H:pOTHER" ] && exit 1\nexit 0\n')
    await sleep(200)
    const posted = await h.request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: { section: 'title', quote: 'Demo scope' }, text: '@plan2 look here' } })
    assert.equal(posted.status, 201, posted.text)
    // The tag keeps failing, so delivery loops on its retry tick; each tick used to re-mark the no_pane note.
    await waitFor(() => prompts(h, 'w5H:pOTHER').length >= 4, 'the tag retried three times')
    const id = events.find((note) => note.event === 'new')?.id
    assert.ok(id, 'the new note reached the stream')
    const marks = events.filter((note) => note.id === id && note.delivery === 'no_pane').length
    assert.equal(marks, 1, `no_pane was marked ${marks} times`)
    assert.equal((await h.request('/api/scope/demo/notes', { headers: h.bearer })).json.notes[0].delivery, 'no_pane')
  } finally { req.destroy(); await h.close() }
})

test('a cut voice lane note ends on a whole character, never half a surrogate pair', async () => {
  const h = await startScopeHarness(scope)
  try {
    const text = 'word '.repeat(60) + '😀'.repeat(200)
    const prefix = "[scoping demo] Note from Alex's voice call (not a comment): "
    assert.ok(/[\uD800-\uDBFF]$/.test((prefix + text).slice(0, 699)), 'a cut at 699 code units would split a pair')
    const res = await h.request('/api/scope/demo/lane-note', { method: 'POST', headers: human, body: { text, via: 'voice' } })
    assert.equal(res.status, 200, res.text)
    await waitFor(() => prompts(h, 'w5H:pT1').length, 'the lane note reached the pane')
    const line = prompts(h, 'w5H:pT1')[0].replace(/^agent prompt \S+ /, '')
    assert.ok(line.startsWith(prefix + 'word word'), line.slice(0, 80))
    assert.ok(!line.includes('�'), 'no replacement character from a split pair')
    assert.ok(line.endsWith('😀…'), `ends on a whole emoji, then the ellipsis: ${JSON.stringify(line.slice(-4))}`)
    assert.ok(line.length <= 700, `line is ${line.length} code units`)
  } finally { await h.close() }
})

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'scope-r26-approvals-'))
  const root = join(dir, 'scoping'), data = join(dir, 'data'), log = join(dir, 'calls.log')
  mkdirSync(root); mkdirSync(data)
  writeFileSync(join(root, 'INDEX.md'), '# Scoping index\n')
  const docs = {}
  const put = (slug, approval) => {
    docs[slug] = { doc: { slug, title: slug, kind: 'scope', pane: `w5H:p${slug.replace(/[^a-z0-9]/gi, '').slice(0, 6)}`, seq: 4 }, blocks: [], threads: [], approval, presence: [] }
    writeFileSync(join(data, 'list.json'), JSON.stringify({ docs: Object.values(docs).map((d) => d.doc) }))
    writeFileSync(join(data, `${slug}.json`), JSON.stringify(docs[slug]))
  }
  const livedoc = join(dir, 'livedoc'), herdr = join(dir, 'herdr'), lane = join(dir, 'herdr-lane')
  writeFileSync(livedoc, `#!/bin/sh\n[ "$2" = "list" ] && cat '${data}/list.json' && exit 0\n[ "$2" = "show" ] && cat "${data}/$3.json" && exit 0\nexit 2\n`)
  writeFileSync(herdr, `#!/bin/sh
echo "herdr $*" >> '${log}'
if [ "$1 $2" = "pane get" ]; then echo '{"result":{"pane":{"tab_id":"tab-'"$3"'"}}}'; fi
if [ "$1 $2" = "tab get" ]; then echo '{"result":{"tab":{"label":"[scoping] Lane"}}}'; fi
exit 0
`)
  writeFileSync(lane, `#!/bin/sh\necho "herdr-lane $*" >> '${log}'\n`)
  for (const f of [livedoc, herdr, lane]) chmodSync(f, 0o755)
  const stateFile = join(dir, 'state', 'livedoc-approvals.json')
  const make = (file = stateFile) => createLivedocApprovals({ root, stateFile: file, livedoc, herdr, herdrLane: lane })
  const moves = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('herdr-lane ')) : []
  const logged = () => readFileSync(join(root, 'INDEX.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '))
  return { dir, put, make, moves, logged, stateFile }
}
const approval = (mode, when, comment = '') => ({ mode, by: 'alex', who: 'alex@example.com', at: when, at_et: 'Sep 29, 9:14 PM ET', revision: 3, comment, via: 'admin' })

test('the first run with no state file records existing approvals without logging or moving; later ones act', async () => {
  const w = world()
  w.put('old-a', approval('approve', '2026-09-20T01:00:00Z', 'Old approval.'))
  w.put('old-b', approval('not_yet', '2026-09-21T01:00:00Z', 'Old note.'))
  w.put('quiet', null)
  assert.ok(!existsSync(w.stateFile))
  await w.make().tick()
  assert.deepEqual(w.logged(), [], 'nothing logged on the first run')
  assert.deepEqual(w.moves(), [], 'no tab moved on the first run')
  assert.ok(existsSync(w.stateFile), 'the first run writes state')
  const poller = w.make()
  await poller.tick()
  assert.deepEqual(w.logged(), [], 'a restart still logs nothing old')
  w.put('quiet', approval('approve', '2026-09-30T02:00:00Z', 'Ship it.'))
  await poller.tick()
  assert.deepEqual(w.logged(), ['- Sep 29, 9:14 PM ET · quiet r3 · approved · "Ship it."'])
  assert.deepEqual(w.moves(), ['herdr-lane section tab-w5H:pquiet inflight --by alex --note scope approved r3'])
})

test('a doc that cannot be logged does not stop the docs after it', async () => {
  const w = world()
  mkdirSync(join(w.dir, 'state'))
  writeFileSync(w.stateFile, JSON.stringify({ seen: [] }))
  const broken = approval('approve', '2026-09-30T03:00:00Z')
  delete broken.comment
  w.put('a-broken', broken)
  w.put('b-good', approval('approve', '2026-09-30T03:01:00Z', 'Go.'))
  await w.make().tick()
  assert.ok(w.logged().includes('- Sep 29, 9:14 PM ET · b-good r3 · approved · "Go."'), `logged: ${JSON.stringify(w.logged())}`)
  assert.ok(w.moves().includes('herdr-lane section tab-w5H:pbgood inflight --by alex --note scope approved r3'))
})

test('a state write that keeps failing never logs the same approval again on the next tick', async () => {
  const w = world()
  const blocker = join(w.dir, 'not-a-dir')
  writeFileSync(blocker, '')
  const poller = w.make(join(blocker, 'livedoc-approvals.json'))
  w.put('live', null)
  await poller.tick()
  w.put('live', approval('approve_with_changes', '2026-09-30T04:00:00Z', 'Fold in the table.'))
  await poller.tick()
  await poller.tick()
  await poller.tick()
  assert.deepEqual(w.logged(), ['- Sep 29, 9:14 PM ET · live r3 · approved with changes · "Fold in the table."'])
  assert.equal(w.moves().length, 1, 'moved once')
})

const section = { id: 'plan', heading: 'The plan', body_md: 'First choice. Second choice.' }
const open = (id) => ({ id, anchor: anchorInSection(section, 'First choice'), status: 'open', kind: 'question', recommendation: 'First', messages: [{ from: 'agent', text: 'Which?' }] })
function voice({ failFirst = false } = {}) {
  const approvals = []
  let calls = 0
  const session = createScopeVoiceSession({
    getScope: async () => ({ slug: 'demo', scope: { revision: 3, doc: { sections: [section] }, threads: [open('T1')], approval: null } }),
    getContext: () => ({ thread: null, section: 'plan', selection: null }),
    postThread: async () => ({}), postReply: async () => ({}), postResolve: async () => ({}), postLaneNote: async () => ({}),
    postApprove: async (body) => {
      approvals.push(body)
      if (failFirst && ++calls === 1) throw new Error('socket hang up')
      return { approval: { mode: body.mode } }
    },
    onFeed: () => {}, now: () => 1_000_000,
  })
  return { say: (name, args) => session.handle(name, args), approvals }
}

test('a spoken thread or section id reads as "that one" or "that section"; the filed note keeps his words', async () => {
  const { say, approvals } = voice()
  assert.equal((await say('approve_scope', { mode: 'approve_with_changes', note: 'go with option B on T3' })).speech,
    'Approve with changes: "Go with option B on that one." The lane folds it in, then builds. Send it?')
  await say('confirm')
  assert.equal(approvals[0].comment, 'Go with option B on T3.')
  assert.equal((await say('approve_scope', { mode: 'not_yet', note: 'it needs the cost table in §plan, like thread T2 said' })).speech,
    'Not yet: "It needs the cost table in that section, like that one said." Send it?')
  assert.equal((await say('approve_scope', { mode: 'not_yet', note: 'settle T3 and T4 first' })).speech,
    'Not yet: "Settle those first." Send it?')
  assert.equal((await say('approve_scope', { mode: 'not_yet', note: 'T3 needs the cost table' })).speech,
    'Not yet: "That one needs the cost table." Send it?')
})

test('a retried confirm reuses the proposal\'s client_id; a new proposal gets a new one', async () => {
  const { say, approvals } = voice({ failFirst: true })
  await say('approve_scope', { mode: 'not_yet', note: 'it needs the cost table' })
  const lost = await say('confirm')
  assert.equal(lost.ok, false, 'the first send lost its response')
  assert.equal((await say('confirm')).speech, 'Sent. The lane keeps scoping.')
  assert.equal(approvals.length, 2)
  assert.match(approvals[0].client_id, /^[0-9a-f-]{36}$/)
  assert.equal(approvals[1].client_id, approvals[0].client_id, 'the retry is the same approval')
  await say('approve_scope', { mode: 'approve' })
  await say('confirm')
  assert.equal(approvals.length, 3)
  assert.notEqual(approvals[2].client_id, approvals[0].client_id, 'a new proposal is a new approval')
})
