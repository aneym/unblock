// Prod e2e (comment-latency, 2026-10-07): when the scope responder's section edit failed, the reply kept the model's
// "done" and appended the raw stderr. Alex saw a false "done" plus an error dump. Contract: a failed edit replaces the
// reply with one plain line, the comment goes to the lane as a task, and stderr stays in the daemon log.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-07T16:00:00Z'
const sections = [
  { id: 'title', heading: 'Comment latency', body_md: 'Comments come back slowly today.' },
  { id: 'stream', heading: 'The stream', body_md: 'Events arrive over a websocket.' },
]
const STDERR = 'lint: STDERR-MARKER-9f2c curly quotes refused'
const scope = { version: 2, slug: 'failed-edit', title: 'Comment latency', pane: 'w5H:pQA', revision: 1, updated_at: at, doc: { sections }, threads: [] }

test('a failed section edit replies with one plain line, no stderr, no edit claim, and hands the comment to the lane', async () => {
  const logged = []
  const original = console.error
  console.error = (...args) => { logged.push(args.join(' ')) }
  const h = await startScopeHarness(scope)
  try {
    const dir = dirname(process.env.HERDR_BIN_PATH)
    const responder = join(dir, 'responder-stub')
    writeFileSync(responder, `#!/usr/bin/env node
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { prompt += c })
process.stdin.on('end', () => {
  const text = 'Done, I tightened the line.\\nEDIT stream\\n## The stream {#stream}\\n\\nEvents arrive over a websocket. Read /Users/synthetic/paper.txt.\\nEND_EDIT'
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }) + '\\n')
  process.exit(0)
})
`)
    chmodSync(responder, 0o700)
    const detail = 'path: "/Users/synthetic/paper.txt." ->'
    const cli = join(import.meta.dirname, '..', 'bin', 'unblock.js')
    const lanePostLog = join(dir, 'lane-post.log')
    const lanePost = join(dir, 'lane-post-stub')
    writeFileSync(lanePost, `#!/bin/sh\nline=''\nfor a in "$@"; do line="$line$a$(printf '\\037')"; done\nprintf '%s\\n' "$line" >> '${lanePostLog}'\necho "b-20261007160000-$$"\n`)
    chmodSync(lanePost, 0o700)
    Object.assign(process.env, { UNBLOCK_ANSWERER_BIN: responder, UNBLOCK_LANE_POST_BIN: lanePost, UNBLOCK_CLI_BIN: cli, UNBLOCK_PORT: String(h.port), UNBLOCK_SUPERVISED: '1',
      UNBLOCK_EXPLAINER_CONCURRENCY: '8', UNBLOCK_EXPLAINER_TIMEOUT_MS: '60000' })

    const get = async () => (await h.request('/api/scope/failed-edit', { headers: human })).json.scope
    const reply = await h.request('/api/scope/failed-edit/threads', { method: 'POST', headers: human,
      body: { text: 'Q-1 tighten this line', client_id: 'f-1', anchor: anchorInSection(sections[1], 'websocket') } })
    assert.ok(reply.status < 300, reply.text)
    const settled = async () => {
      const thread = (await get()).threads.find((t) => t.messages.some((m) => m.from === 'alex'))
      return thread?.messages.filter((m) => m.from === 'agent').at(-1)
    }
    for (const end = Date.now() + 20000; Date.now() < end;) {
      const a = await settled()
      if (a && !a.pending) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const agent = await settled()
    assert.ok(agent && !agent.pending, 'the answer settled')
    assert.equal(agent.text, 'The edit used a file path the page rules refuse.')
    assert.ok(!agent.text.includes('/Users/'), 'no path in the reply')
    assert.ok(!/tightened|Done|Edited/.test(agent.text), 'the reply does not claim the edit')
    assert.ok(agent.needs_owner, 'the comment is marked for the owner')
    assert.ok(!(await get()).doc.sections.find((s) => s.id === 'stream').body_md.includes('tightened'), 'the doc is unchanged')

    for (const end = Date.now() + 20000; Date.now() < end && (!existsSync(lanePostLog) || !readFileSync(lanePostLog, 'utf8').includes(detail));) await new Promise((r) => setTimeout(r, 50))
    const posts = readFileSync(lanePostLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f'))
    assert.ok(posts.some((args) => args[args.indexOf('--kind') + 1] === 'task' && args.join(' ').includes('Q-1')), 'a task post to the lane')
    assert.ok(readFileSync(lanePostLog, 'utf8').includes(detail) && readFileSync(lanePostLog, 'utf8').includes('Run /unslop'), 'full CLI stderr in the lane hand-off')
    assert.ok(logged.some((line) => line.includes(detail)), 'stderr went to the daemon log')
  } finally { console.error = original; await h.close() }
})
