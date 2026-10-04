// Owner: Opus (r35, 👀 seen + no-wait delivery). Implementers copy it to test/ and make it pass; they never edit it.
// Alex (2026-09-30 09:47 ET): "when i ask questions in line, the agent should have tools to acknowledge (eyes emoji
// reaction, removed when responded to?) so i dont need to go back to the scoping convo". And 09:52 ET: "what does
// waiting for pause mean?" A comment must not wait for the lane to go idle: it goes out through lane-post (hook
// delivery mid-turn) at once. The lane marks it seen with 👀; the 👀 clears when the lane answers, or when Alex adds
// to or closes the thread (then the lane has something new to see).
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection, validateScope } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-30T14:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We run Sol medium for the build. Then the review.' },
]
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections },
  threads: [{ id: 'T1', anchor: anchorInSection(sections[1], 'Then the review'), author: 'agent', kind: 'question', status: 'open', recommendation: 'Sonnet', messages: [{ from: 'agent', text: 'Who reviews?', at }], created_at: at }],
}

test('a comment goes out at once through lane-post; the lane marks it 👀 seen; the 👀 clears on an answer', async () => {
  const h = await startScopeHarness(scope)
  const { request, until, bearer } = h
  // herdr says the lane is busy. Before r35 the comment was held ("Waiting for the lane to pause").
  const herdr = process.env.HERDR_BIN_PATH, paneLog = join(dirname(herdr), 'pane.log')
  writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${paneLog}'\ncase "$1 $2" in "agent get") echo '{"result":{"agent":{"agent_status":"working"}}}';; esac\n`)
  const postLog = join(dirname(herdr), 'lane-post.log'), postBin = join(dirname(herdr), 'lane-post-stub')
  writeFileSync(postBin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> '${postLog}'; done\nprintf '\\n' >> '${postLog}'\n`)
  chmodSync(postBin, 0o700)
  process.env.UNBLOCK_LANE_POST_BIN = postBin
  const get = async () => (await request('/api/scope/demo', { headers: human })).json
  const thread = async (id) => (await get()).scope.threads.find((t) => t.id === id)
  const react = (id, emoji, headers = bearer) => request(`/api/scope/demo/threads/${id}/react`, { method: 'POST', headers, body: { emoji } })
  const posts = () => existsSync(postLog) ? readFileSync(postLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f').filter(Boolean)) : []
  try {
    // 1. Alex comments. It goes out through lane-post right away, although herdr says the lane is working.
    const posted = await request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: anchorInSection(sections[1], 'We run Sol medium for the build'), text: 'Sol 6.1 right?', client_id: 'c-1' } })
    assert.equal(posted.status, 201, posted.text)
    const id = posted.json.thread.id
    await until(() => posts().length === 1, 'one lane-post call')
    const args = posts()[0]
    const flag = (name) => args[args.indexOf(name) + 1]
    assert.equal(args[0], 'post')
    assert.equal(flag('--to'), 'w5H:pT1')
    assert.equal(flag('--from'), 'scope:demo')
    assert.equal(flag('--kind'), 'task')
    assert.equal(flag('--wake'), 'auto')
    assert.match(flag('--text'), /^\[scoping demo\] Alex on §The plan .*Sol 6\.1 right\?/)
    await until(async () => (await get()).notes.some((note) => note.thread === id && note.delivery === 'delivered'), 'the note is delivered, not held')
    assert.ok(!h.paneLines().split('\n').some((line) => line.startsWith('agent prompt')), 'nothing is typed into the pane')

    // 2. The lane marks it seen. Only a lane can; only 👀; only a real thread.
    const seen = await react(id, '👀')
    assert.equal(seen.status, 200, seen.text)
    const r = (await thread(id)).reaction
    assert.equal(r.emoji, '👀'); assert.equal(r.by, 'agent'); assert.ok(Date.parse(r.at))
    assert.equal((await react(id, '👀', human)).status, 403)
    assert.equal((await react(id, '🔥')).status, 400)
    assert.equal((await react('T99', '👀')).status, 404)
    assert.equal((await get()).scope.revision, 2, 'a reaction is not a doc revision')

    // 3. The lane answers: the 👀 is gone.
    assert.equal((await request(`/api/scope/demo/threads/${id}/reply`, { method: 'POST', headers: bearer, body: { text: 'Yes, Sol 6.1 medium.' } })).status, 200)
    assert.equal((await thread(id)).reaction, undefined)

    // 4. Alex adds to it: a 👀 set before goes, so the lane has something new to see. Clear by hand works too.
    await react(id, '👀')
    assert.equal((await request(`/api/scope/demo/threads/${id}/reply`, { method: 'POST', headers: human, body: { text: 'And the reviewer?', client_id: 'c-2' } })).status, 200)
    assert.equal((await thread(id)).reaction, undefined)
    await react(id, '👀')
    assert.equal((await react(id, null)).status, 200)
    assert.equal((await thread(id)).reaction, undefined)

    // 5. A lane resolve clears it; so does Alex resolving a question. (2026-10-03 resolve-rule: the lane closes his
    //    comment only with his close words, so he says them first.)
    assert.equal((await request(`/api/scope/demo/threads/${id}/reply`, { method: 'POST', headers: human, body: { text: 'ok, close it', client_id: 'c-2b' } })).status, 200)
    await react(id, '👀')
    assert.equal((await request(`/api/scope/demo/threads/${id}/resolve`, { method: 'POST', headers: bearer, body: { decision: 'Sol 6.1 medium builds.', quote: 'ok, close it' } })).status, 200)
    assert.equal((await thread(id)).reaction, undefined)
    await react('T1', '👀')
    assert.equal((await request('/api/scope/demo/threads/T1/resolve', { method: 'POST', headers: human, body: { decision: 'Sonnet', alex_words: 'Sonnet', how: 'take', client_id: 'c-3' } })).status, 200)
    assert.equal((await thread('T1')).reaction, undefined)

    // 6. The stored field is checked like every other.
    const bad = structuredClone(scope); bad.threads[0].reaction = { emoji: '🔥', by: 'agent', at }
    assert.ok(validateScope(bad).includes('invalid reaction'))
    const good = structuredClone(scope); good.threads[0].reaction = { emoji: '👀', by: 'agent', at }
    assert.deepEqual(validateScope(good), [])

    // 7. The CLI: `unblock scope react <slug> <T#>` marks it seen; `--clear` takes it off.
    const cli = (...a) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...a], { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    const on = await cli('scope', 'react', 'demo', id)
    assert.equal(on.status, 0, on.stderr); assert.match(on.stdout, new RegExp(`seen ${id}`))
    assert.equal((await thread(id)).reaction?.emoji, '👀')
    const off = await cli('scope', 'react', 'demo', id, '--clear')
    assert.equal(off.status, 0, off.stderr); assert.match(off.stdout, new RegExp(`cleared ${id}`))
    assert.equal((await thread(id)).reaction, undefined)
  } finally { delete process.env.UNBLOCK_LANE_POST_BIN; await h.close() }
})
