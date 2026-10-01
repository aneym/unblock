// Owner: Opus (r48, audit x383). Implementers never edit it.
// Alex: spoken scope notes interrupted Claude Code instead of queueing. On 09-29 17:15-17:32 ET his 21 hands-free
// notes on handsfree-dev (unblock scope_notes ids 17-37) were typed into the lane one by one. Since r35 every note
// goes out through lane-post, which types a wake only into an idle pane; a working pane gets notes from its hook at
// the next tool call. This replays those 21 at their real gaps (1 s of the call = 4 ms here) and checks the lane
// gets one turn per pause: nothing typed while it works, one wake when it was idle, every note delivered.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T21:00:00Z'
const sections = [
  { id: 'title', heading: 'Hands-free dev', body_md: 'Talk to a lane while it works.' },
  { id: 'flow', heading: 'The flow', body_md: 'Alex talks. The lane listens and edits the doc.' },
]
const scope = { version: 2, slug: 'handsfree-dev', title: 'Hands-free dev', pane: 'w5H:pHG', revision: 8, updated_at: at, doc: { sections }, threads: [] }

// Seconds after 17:15:35 ET, and whether the note was a reply to an earlier thread (ids 22 and 32 replied; 27 was an own answer).
const REPLAY = [[0], [100], [144], [205], [245], [336, 'reply'], [370], [402], [447], [541], [585, 'reply'], [640], [675], [709],
  [740], [764, 'reply'], [816], [885], [909], [998], [1016]]

async function replay(paneStatus) {
  const h = await startScopeHarness(scope)
  const herdr = process.env.HERDR_BIN_PATH, dir = dirname(herdr), paneLog = join(dir, 'pane.log')
  const statusFile = join(dir, 'pane-status'), postLog = join(dir, 'lane-post.log'), wakeLog = join(dir, 'wakes.log')
  writeFileSync(statusFile, paneStatus)
  writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${paneLog}'\ncase "$1 $2" in "agent get") printf '{"result":{"agent":{"agent_status":"%s"}}}' "$(cat '${statusFile}')";; esac\n`)
  // lane-post's own rule (factory-runtime/bin/lane-post): a task with --wake auto types one wake line only into an
  // idle or done pane; that wake starts a turn, so the pane is working after it. Everything else waits for the hook.
  const postBin = join(dir, 'lane-post-stub')
  writeFileSync(postBin, `#!/bin/sh
for a in "$@"; do printf '%s\\037' "$a" >> '${postLog}'; done; printf '\\n' >> '${postLog}'
wake=no; kind=info; prev=
for a in "$@"; do [ "$prev" = --wake ] && wake=$a; [ "$prev" = --kind ] && kind=$a; prev=$a; done
status=$(cat '${statusFile}')
if [ "$kind" = task ] && [ "$wake" = auto ] && { [ "$status" = idle ] || [ "$status" = done ]; }; then
  echo wake >> '${wakeLog}'; printf working > '${statusFile}'
fi
`)
  chmodSync(postBin, 0o700)
  process.env.UNBLOCK_LANE_POST_BIN = postBin
  const lines = (file) => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  try {
    const threads = []
    let last = 0
    for (const [second, kind] of REPLAY) {
      await new Promise((resolve) => setTimeout(resolve, (second - last) * 4))
      last = second
      const body = { text: `note at +${second}s`, client_id: `r-${second}` }
      const res = kind === 'reply'
        ? await h.request(`/api/scope/handsfree-dev/threads/${threads.at(-1)}/reply`, { method: 'POST', headers: human, body })
        : await h.request('/api/scope/handsfree-dev/threads', { method: 'POST', headers: human, body: { ...body, anchor: anchorInSection(sections[1], 'The lane listens') } })
      assert.ok([200, 201].includes(res.status), res.text)
      if (kind !== 'reply') threads.push(res.json.thread.id)
    }
    await h.until(async () => {
      const notes = (await h.request('/api/scope/handsfree-dev', { headers: human })).json.notes.filter((note) => note.author === 'alex')
      return notes.length === REPLAY.length && notes.every((note) => note.delivery === 'delivered')
    }, 'all 21 notes delivered')
    const posted = lines(postLog).join('\n')
    for (const [second] of REPLAY) assert.ok(posted.includes(`note at +${second}s`), `note +${second}s reached lane-post`)
    assert.ok(!h.paneLines().split('\n').some((line) => line.startsWith('agent prompt')), 'nothing is typed into the pane')
    return lines(wakeLog).length
  } finally { delete process.env.UNBLOCK_LANE_POST_BIN; await h.close() }
}

test('replay of the 21 hands-free notes: a working lane is never interrupted', async () => {
  assert.equal(await replay('working'), 0)
})

test('replay of the 21 hands-free notes: an idle lane gets one turn, the rest arrive inside it', async () => {
  assert.equal(await replay('idle'), 1)
})
