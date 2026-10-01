// Owner: Opus (pHY, 2026-10-01). Implementers never edit it.
// Alex approved scope-page-tabs from Admin at 13:06 ET (scope note 217). The daemon held it while the PM worked, then
// after the 15-minute cap typed it into the Claude tab with `herdr agent prompt`. Approvals skipped lane-post, which
// comments have used since r35. Rule (p6 2026-09-30): lanes are messaged only through lane-post; nothing is typed into a
// Claude tab. So under supervision, an approval goes out through lane-post at once, whatever the pane is doing, as its
// own task post (not joined to the comment line). It keeps the bulletin id like a comment does, and the daemon never
// runs `agent prompt` for it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-01T17:00:00Z'
const sections = [
  { id: 'title', heading: 'Development', body_md: 'Projects as a board.' },
  { id: 'plan', heading: 'The plan', body_md: 'Scope opens first. Blockers are a lens.' },
]
const scope = { version: 2, slug: 'tabs', title: 'Development', pane: 'w5H:pHY', revision: 5, updated_at: at, doc: { sections }, threads: [] }

test('an approval reaches the working lane through lane-post at once, and nothing is typed into the tab', async () => {
  const h = await startScopeHarness(scope)
  const dir = dirname(process.env.HERDR_BIN_PATH), paneLog = join(dir, 'pane.log'), postLog = join(dir, 'lane-post.log')
  // The pane is busy the whole time: before this fix, the approval waited and then got typed in.
  writeFileSync(process.env.HERDR_BIN_PATH, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${paneLog}'\ncase "$1 $2" in "agent get") printf '{"result":{"agent":{"agent_status":"working","name":"Scoping pages"}}}';; esac\n`)
  const post = join(dir, 'lane-post-stub')
  writeFileSync(post, `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> '${postLog}'; done; printf '\\n' >> '${postLog}'\nn=$(cat '${join(dir, 'n')}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${join(dir, 'n')}'\necho "b-20261001170635-000$n"\n`)
  chmodSync(post, 0o700)
  process.env.UNBLOCK_LANE_POST_BIN = post
  process.env.UNBLOCK_SCOPE_HOLD_MAX_MS = '600000'
  const posts = () => existsSync(postLog) ? readFileSync(postLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f')) : []
  const paneLines = () => existsSync(paneLog) ? readFileSync(paneLog, 'utf8') : ''
  const notes = async () => (await h.request('/api/scope/tabs', { headers: human })).json.notes.filter((note) => note.from === 'alex')
  const until = async (check, what) => { const end = Date.now() + 8000; while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 50)) } assert.fail(`${what} not reached within 8s`) }
  try {
    // A comment and the approval arrive together.
    const comment = await h.request('/api/scope/tabs/threads', { method: 'POST', headers: human,
      body: { text: 'Blockers first in Today.', client_id: 'c-1', anchor: anchorInSection(sections[1], 'Blockers are a lens') } })
    assert.ok([200, 201].includes(comment.status), comment.text)
    const ok = await h.request('/api/scope/tabs/approve', { method: 'POST', headers: human,
      body: { mode: 'approve', comment: 'internalize all my comments and then fully see this through.', client_id: 'appr-217' } })
    assert.equal(ok.status, 200, ok.text)

    await until(() => posts().some((args) => args.some((a) => a.includes('APPROVED by Alex'))), 'the approval reached lane-post')
    const approval = posts().find((args) => args.some((a) => a.includes('APPROVED by Alex')))
    const flag = (name) => approval[approval.indexOf(name) + 1]
    assert.equal(flag('--to'), 'w5H:pHY')
    assert.equal(flag('--kind'), 'task')
    assert.equal(flag('--wake'), 'auto')
    assert.ok(!approval.some((a) => a.includes('Blockers first in Today')), 'the approval is its own post, not joined to the comment line')
    assert.ok(posts().some((args) => args.some((a) => a.includes('Blockers first in Today'))), 'the comment went out too')

    await until(async () => (await notes()).some((note) => note.event === 'approve' && note.delivery === 'delivered'), 'the approval note marked delivered')
    const note = (await notes()).find((n) => n.event === 'approve')
    assert.match(note.bulletin ?? '', /^b-20261001170635-000\d$/, 'the approval keeps the bulletin id lane-post printed')

    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(!paneLines().split('\n').some((line) => line.startsWith('agent prompt')), 'nothing is typed into the Claude tab')
  } finally {
    delete process.env.UNBLOCK_LANE_POST_BIN
    delete process.env.UNBLOCK_SCOPE_HOLD_MAX_MS
    await h.close()
  }
})
