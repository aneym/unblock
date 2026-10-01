// Owner: Opus (pHY approval-relay, 2026-10-01). Implementers make it pass and never edit it.
// p6, 14:35 ET: the relay sent p6 the shared-primitives APPROVED note three times as tasks (b-…182651-4ac0,
// 182705-2635, 182705-b5c2), each typed into its tab. That scope was approved Sep 29 and was already building; a PM
// had just relayed the old approval (pm-relay) and the daemon restarted mid-send. Rules:
// 1. One post per scope per approval: the post carries --ref scope:<slug>:<mode>:r<revision>, and when a bulletin with
//    that ref is already on the board, the daemon posts nothing and marks the note delivered with that bulletin.
// 2. An approval recorded long after Alex gave it (a backfill) goes as --kind info --wake never.
// 3. It goes to the scope's own pane (scope.pane), the PM's.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-01T15:00:00Z'
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 4, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }] }, threads: [],
}
const REF = 'scope:demo:approve:r4'

async function setup() {
  const h = await startScopeHarness(scope)
  const dir = dirname(process.env.HERDR_BIN_PATH), paneLog = join(dir, 'pane.log'), postLog = join(dir, 'lane-post.log')
  const lanes = join(dir, 'lanes')
  mkdirSync(lanes, { recursive: true })
  writeFileSync(process.env.HERDR_BIN_PATH, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${paneLog}'\ncase "$1 $2" in "agent get") printf '{"result":{"agent":{"agent_status":"working"}}}';; esac\n`)
  const post = join(dir, 'lane-post-stub')
  writeFileSync(post, `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> '${postLog}'; done; printf '\\n' >> '${postLog}'\necho "b-20261001190000-00a1"\n`)
  chmodSync(post, 0o700)
  process.env.UNBLOCK_LANE_POST_BIN = post
  process.env.LANE_BULLETIN_HOME = lanes
  const posts = () => existsSync(postLog) ? readFileSync(postLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f')) : []
  const approvalPosts = () => posts().filter((args) => args.some((a) => a.includes('APPROVED by Alex')))
  const notes = async () => (await h.request('/api/scope/demo', { headers: human })).json.notes.filter((note) => note.event === 'approve')
  const prompted = () => (existsSync(paneLog) ? readFileSync(paneLog, 'utf8') : '').split('\n').some((line) => line.startsWith('agent prompt'))
  const relay = (body) => h.request('/api/scope/demo/pm-approve', { method: 'POST', headers: h.bearer, body: { by: 'alex', quote: 'lgtm, see it through', ...body } })
  const close = async () => { delete process.env.UNBLOCK_LANE_POST_BIN; delete process.env.LANE_BULLETIN_HOME; await h.close() }
  return { h, lanes, approvalPosts, notes, prompted, relay, close }
}

const until = async (check, what) => { const end = Date.now() + 8000; while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)) } assert.fail(`${what} not reached within 8s`) }
const flag = (args, name) => args[args.indexOf(name) + 1]

test('a fresh approval wakes the scope PM once, as a task with the approval ref', async () => {
  const t = await setup()
  try {
    assert.equal((await t.relay({ pane: 'w5H:pHY' })).status, 200)
    await until(() => t.approvalPosts().length > 0, 'the approval reached lane-post')
    const [args] = t.approvalPosts()
    assert.equal(flag(args, '--to'), 'w5H:pT1', 'to the scope pane, not the relaying pane')
    assert.equal(flag(args, '--kind'), 'task')
    assert.equal(flag(args, '--wake'), 'auto')
    assert.equal(flag(args, '--ref'), REF)
    await until(async () => (await t.notes()).some((note) => note.delivery === 'delivered'), 'the note marked delivered')
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(t.approvalPosts().length, 1, 'posted once')
    assert.ok(!t.prompted(), 'nothing typed into the tab')
  } finally { await t.close() }
})

test('an approval relayed days after Alex gave it is a backfill: info, no wake', async () => {
  const t = await setup()
  try {
    const old = new Date(Date.now() - 2 * 24 * 3600_000).toISOString()
    assert.equal((await t.relay({ at: old })).status, 200)
    await until(() => t.approvalPosts().length > 0, 'the backfill reached lane-post')
    const [args] = t.approvalPosts()
    assert.equal(flag(args, '--to'), 'w5H:pT1')
    assert.equal(flag(args, '--kind'), 'info')
    assert.equal(flag(args, '--wake'), 'never')
    assert.equal(flag(args, '--ref'), REF)
    assert.ok(!t.prompted())
  } finally { await t.close() }
})

test('when the board already has this approval, nothing is posted again', async () => {
  const t = await setup()
  try {
    // A daemon posted it, then died before marking the note (the 18:27Z restart).
    writeFileSync(join(t.lanes, 'bulletin.jsonl'), JSON.stringify({ id: 'b-20261001182651-4ac0', ts: '2026-10-01T18:26:51Z',
      from: 'scope:demo', to: ['w5H:pT1'], kind: 'task', topic: 'scope-demo', text: '[scoping demo] APPROVED by Alex (r4).', ref: REF }) + '\n')
    assert.equal((await t.relay({})).status, 200)
    await until(async () => (await t.notes()).some((note) => note.delivery === 'delivered'), 'the note marked delivered')
    const [note] = await t.notes()
    assert.equal(note.bulletin, 'b-20261001182651-4ac0', 'it keeps the bulletin already posted')
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(t.approvalPosts().length, 0, 'no second post')
    assert.ok(!t.prompted())
  } finally { await t.close() }
})
