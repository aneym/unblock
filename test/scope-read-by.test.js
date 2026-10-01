// Owner: Opus (p6 scope-sending-stale, 2026-10-01). Implementers never edit it.
// Alex, 07:53 ET on chatgpt-utility-apps: "scoping sending still seems to not be actually working to the right agent".
// Both notes had reached the PM, but the page only ever said "Sent", with no sign the PM got them. Now each note the
// daemon hands to lane-post keeps the bulletin id lane-post prints. When the lane's hook takes that bulletin, it writes a
// row to bulletin-delivered.jsonl under LANE_BULLETIN_HOME (a row superseded by a later bulletin counts too). The
// note then carries read_at and read_by, the pane's agent name from herdr, or the pane id when herdr gives no name.
// delivery stays 'delivered'. Each lane-post call writes one line to the daemon log (console.error) with its exit
// code and stderr. The log never carries more than 80 characters of the note.
import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-01T11:50:00Z'
const sections = [
  { id: 'title', heading: 'ChatGPT apps', body_md: 'Utility apps in ChatGPT.' },
  { id: 'plan', heading: 'The plan', body_md: 'We ship the calendar app first. Then the inbox app.' },
]
const scope = { version: 2, slug: 'apps', title: 'ChatGPT apps', pane: 'w5H:pWB', revision: 3, updated_at: at, doc: { sections }, threads: [] }
const LONG = 'The calendar app needs the free/busy view before anything else, and it must never book over a hold. ' + 'x'.repeat(200)

async function harness({ agentName = 'Apps PM', exit = 0, stderr = '' } = {}) {
  const h = await startScopeHarness(scope)
  const dir = dirname(process.env.HERDR_BIN_PATH), lanes = join(dir, 'lanes')
  mkdirSync(lanes, { recursive: true })
  process.env.LANE_BULLETIN_HOME = lanes
  const name = agentName ? `,"name":"${agentName}"` : ''
  writeFileSync(process.env.HERDR_BIN_PATH, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(dir, 'pane.log')}'\ncase "$1 $2" in "agent get") printf '{"result":{"agent":{"agent_status":"working"${name}}}}';; esac\n`)
  let n = 0
  const post = join(dir, 'lane-post-stub')
  // Prints a bulletin id on stdout the way lane-post does, then the configured stderr and exit code.
  writeFileSync(post, `#!/bin/sh\nn=$(cat '${join(dir, 'n')}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${join(dir, 'n')}'\n${exit ? '' : 'echo "b-20261001115144-000$n"\n'}${stderr ? `echo '${stderr}' >&2\n` : ''}exit ${exit}\n`)
  chmodSync(post, 0o700)
  process.env.UNBLOCK_LANE_POST_BIN = post
  const logged = []
  const original = console.error
  console.error = (...args) => { logged.push(args.join(' ')); original(...args) }
  const delivered = (row) => appendFileSync(join(lanes, 'bulletin-delivered.jsonl'), JSON.stringify(row) + '\n')
  const notes = async () => (await h.request('/api/scope/apps', { headers: human })).json.notes.filter((note) => note.from === 'alex')
  const comment = (text, client_id) => h.request('/api/scope/apps/threads', { method: 'POST', headers: human,
    body: { text, client_id, anchor: anchorInSection(sections[1], 'We ship the calendar app first') } })
  // The daemon's own until() gives up after 2 s; a lane-post round trip can take longer under load.
  const until = async (check, what) => { const end = Date.now() + 8000; while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)) } assert.fail(`${what} not reached within 8s`) }
  const done = async () => { console.error = original; delete process.env.UNBLOCK_LANE_POST_BIN; delete process.env.LANE_BULLETIN_HOME; await h.close() }
  return { h, notes, comment, delivered, logged, until, done }
}

test('a delivered note is read once the lane takes its bulletin, and names who read it', async () => {
  const t = await harness()
  try {
    assert.ok([200, 201].includes((await t.comment(LONG, 'c-one')).status))
    await t.until(async () => (await t.notes())[0]?.delivery === 'delivered', 'note delivered')
    let [note] = await t.notes()
    assert.equal(note.bulletin, 'b-20261001115144-0001', 'the note keeps the bulletin id lane-post printed')
    assert.equal(note.read_at ?? null, null, 'not read before the hook takes it')
    assert.equal(note.read_by ?? null, null)

    // Another pane taking the same bulletin is not the lane reading it.
    t.delivered({ id: 'b-20261001115144-0001', pane: 'w5H:pOTHER', ts: '2026-10-01T11:51:50Z' })
    await new Promise((resolve) => setTimeout(resolve, 400));
    [note] = await t.notes()
    assert.equal(note.read_at ?? null, null, 'a row for another pane does not count')

    t.delivered({ id: 'b-20261001115144-0001', pane: 'w5H:pWB', ts: '2026-10-01T11:52:10.5Z' })
    await t.until(async () => (await t.notes())[0]?.read_at, 'note read');
    [note] = await t.notes()
    assert.equal(note.read_at, '2026-10-01T11:52:10.5Z', 'read_at is when the hook took it')
    assert.equal(note.read_by, 'Apps PM', "read_by is the pane's agent name")
    assert.equal(note.delivery, 'delivered', 'delivery stays delivered')

    // A second note whose bulletin was superseded by a later one before the hook ran still counts as read.
    assert.ok([200, 201].includes((await t.comment('Then the inbox app.', 'c-two')).status))
    await t.until(async () => (await t.notes())[1]?.bulletin, 'second note posted')
    const second = (await t.notes())[1]
    t.delivered({ id: second.bulletin, pane: 'w5H:pWB', ts: '2026-10-01T11:53:00Z', superseded_by: 'b-20261001115300-ffff' })
    await t.until(async () => (await t.notes())[1]?.read_at === '2026-10-01T11:53:00Z', 'superseded note read')

    // One log line per lane-post call: the exit code, and no more than 80 characters of the note.
    const lines = t.logged.filter((line) => line.includes('lane-post'))
    assert.equal(lines.length, 2, lines.join('\n'))
    assert.match(lines[0], /exit=0/)
    assert.ok(!lines.some((line) => line.includes(LONG.slice(0, 81))), 'the log carries at most 80 characters of the note')
  } finally { await t.done() }
})

test('with no agent name from herdr, read_by is the pane id', async () => {
  const t = await harness({ agentName: '' })
  try {
    assert.ok([200, 201].includes((await t.comment('Calendar first.', 'c-three')).status))
    await t.until(async () => (await t.notes())[0]?.bulletin, 'posted')
    t.delivered({ id: (await t.notes())[0].bulletin, pane: 'w5H:pWB', ts: '2026-10-01T11:54:00Z' })
    await t.until(async () => (await t.notes())[0]?.read_by === 'w5H:pWB', 'read by pane id')
  } finally { await t.done() }
})

test("a failing lane-post logs its exit code and stderr, and the note isn't sent or read", async () => {
  const t = await harness({ exit: 1, stderr: 'lane-post: unknown panes: w5H:pWB' })
  try {
    assert.ok([200, 201].includes((await t.comment('Calendar first.', 'c-four')).status))
    await t.until(async () => t.logged.some((line) => line.includes('lane-post') && /exit=1/.test(line) && line.includes('unknown panes: w5H:pWB')), 'failure logged')
    const [note] = await t.notes()
    assert.notEqual(note.delivery, 'delivered')
    assert.equal(note.bulletin ?? null, null)
    assert.equal(note.read_at ?? null, null)
  } finally { await t.done() }
})
