// Owner: Opus (r19, live-doc approvals on Studio). Implementers make it pass and never edit it.
// Alex approves a Rails live doc in Admin (pKH H1); Rails' relay tells the lane (H2). The Studio-only half is here:
// a poller reads `livedoc --json list/show`, and for each new approval it logs the same INDEX "## Approvals" line
// /s/ writes and, for approve modes, moves the lane's tab to In flight. State survives a restart, so nothing
// is logged or moved twice. It never throws, even when livedoc fails.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLivedocApprovals } from '../src/scope-approvals.js'

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'livedoc-approvals-'))
  const root = join(dir, 'scoping'), data = join(dir, 'data'), log = join(dir, 'calls.log')
  mkdirSync(root); mkdirSync(data)
  writeFileSync(join(root, 'INDEX.md'), '# Scoping index\n\n## Lanes\n- live-docs\n')
  const docs = {}
  const save = () => {
    writeFileSync(join(data, 'list.json'), JSON.stringify({ docs: Object.values(docs).map((d) => d.doc) }))
    for (const d of Object.values(docs)) writeFileSync(join(data, `${d.doc.slug}.json`), JSON.stringify(d))
  }
  const put = (slug, pane, approval, seq = 4) => { docs[slug] = { doc: { slug, title: slug, kind: 'scope', pane, seq }, blocks: [], threads: [], approval, presence: [] }; save() }
  const livedoc = join(dir, 'livedoc'), herdr = join(dir, 'herdr'), lane = join(dir, 'herdr-lane')
  writeFileSync(livedoc, `#!/bin/sh
echo "livedoc $*" >> '${log}'
[ -f '${data}/fail' ] && exit 1
[ "$1" = "--json" ] || exit 2
if [ "$2" = "list" ]; then cat '${data}/list.json'; exit 0; fi
if [ "$2" = "show" ]; then cat "${data}/$3.json"; exit 0; fi
exit 2
`)
  writeFileSync(herdr, `#!/bin/sh
echo "herdr $*" >> '${log}'
if [ "$1 $2" = "pane get" ]; then echo '{"result":{"pane":{"tab_id":"tab-'"$3"'"}}}'; fi
if [ "$1 $2" = "tab get" ]; then echo '{"result":{"tab":{"label":"[scoping] Lane for '"$3"'"}}}'; fi
exit 0
`)
  writeFileSync(lane, `#!/bin/sh\necho "herdr-lane $*" >> '${log}'\n`)
  for (const f of [livedoc, herdr, lane]) chmodSync(f, 0o755)
  // A state file already exists, so these runs act on every approval (r26: a first run with no state only records).
  mkdirSync(join(dir, 'state'))
  writeFileSync(join(dir, 'state', 'livedoc-approvals.json'), JSON.stringify({ seen: [] }))
  const make = () => createLivedocApprovals({ root, stateFile: join(dir, 'state', 'livedoc-approvals.json'), livedoc, herdr, herdrLane: lane })
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter((l) => !l.startsWith('livedoc ')) : []
  const index = () => readFileSync(join(root, 'INDEX.md'), 'utf8')
  return { put, make, calls, index, fail: (on) => on ? writeFileSync(join(data, 'fail'), '') : existsSync(join(data, 'fail')) && writeFileSync(join(data, 'fail'), '') && false, data, dir }
}

const approval = (mode, at, comment = '', revision = 3) => ({ mode, by: 'alex', who: 'alex@example.com', at, at_et: 'Sep 29, 9:14 PM ET', revision, comment, via: 'admin' })

test('a new live-doc approval is logged once and moves the tab; not yet only logs; restart logs nothing again', async () => {
  const w = world()
  w.put('quiet-doc', 'w5H:pQ1', null)
  w.put('live-docs', 'w5H:pKH', approval('approve', '2026-09-30T01:14:00Z', 'Ship it   with\nthe phone view first.'))
  w.put('held-doc', 'w5H:pH1', approval('not_yet', '2026-09-30T01:15:00Z', 'Needs the cost table.'))
  const poller = w.make()
  await poller.tick()
  const lines = w.index().split('\n')
  const approvals = lines.slice(lines.indexOf('## Approvals') + 1).filter((l) => l.startsWith('- '))
  assert.deepEqual(approvals.sort(), [
    '- Sep 29, 9:14 PM ET · held-doc r3 · not yet · "Needs the cost table."',
    '- Sep 29, 9:14 PM ET · live-docs r3 · approved · "Ship it with the phone view first."',
  ].sort(), 'the same line /s/ writes, note compacted')
  assert.ok(w.index().startsWith('# Scoping index\n\n## Lanes\n- live-docs\n'), 'the rest of INDEX is kept')
  assert.deepEqual(w.calls(), [
    'herdr pane get w5H:pKH',
    'herdr tab get tab-w5H:pKH',
    'herdr tab rename tab-w5H:pKH Lane for tab-w5H:pKH',
    'herdr-lane section tab-w5H:pKH inflight --by alex --note scope approved r3',
  ], 'only the approved doc moves; not yet and no approval move nothing')

  await poller.tick()
  const again = w.make()
  await again.tick()
  assert.equal(w.index().match(/· live-docs r3 ·/g).length, 1, 'never logged twice, across a restart')
  assert.equal(w.calls().length, 4, 'never moved twice')

  // Not yet, then approved later: the approval is new (a new at), so it logs and moves.
  w.put('held-doc', 'w5H:pH1', approval('approve_with_changes', '2026-09-30T02:00:00Z', 'Fold in the cost table.', 5))
  await again.tick()
  assert.match(w.index(), /· held-doc r5 · approved with changes · "Fold in the cost table\."/)
  assert.ok(w.calls().includes('herdr-lane section tab-w5H:pH1 inflight --by alex --note scope approved r5'))
})

test('no pane means no tab move; a failing livedoc never throws and loses nothing', async () => {
  const w = world()
  w.put('no-pane', null, approval('approve', '2026-09-30T03:00:00Z'))
  w.fail(true)
  const poller = w.make()
  await poller.tick()
  assert.ok(!w.index().includes('no-pane'), 'nothing logged while livedoc fails')
  writeFileSync(join(w.data, 'fail'), ''); await import('node:fs').then((fs) => fs.rmSync(join(w.data, 'fail')))
  await poller.tick()
  assert.match(w.index(), /· no-pane r3 · approved · \(no note\)/, 'logged once livedoc answers')
  assert.deepEqual(w.calls(), [], 'no pane, no herdr calls')
})

test('start and stop run the poll on an interval and stop cleanly', async () => {
  const w = world()
  w.put('live-docs', 'w5H:pKH', approval('approve', '2026-09-30T04:00:00Z', 'Go.'))
  const poller = w.make()
  poller.start(50)
  const deadline = Date.now() + 3000
  while (!w.index().includes('live-docs r3') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  poller.stop()
  assert.match(w.index(), /live-docs r3 · approved · "Go\."/)
})
