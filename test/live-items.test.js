// Owner: Opus (explainers lane for w5H:p0M, 2026-10-03). Implementers make it pass and never edit it.
// Alex (2026-10-03): "would be cool if i could see your responses streaming in the comments and a thinking indicator
// ... built on the same infra we'll use to model after the t3 code nice text streaming", and "it'd be good to know how
// this comment is being handled, like if we're waiting for a workflow or teammate or researching".
// Contract: each reply turn on a comment is one live item, upserted by id over the page's existing SSE channel
// (event "item") with a status that only moves forward: seen -> thinking -> streaming -> done | failed.
//   item = { id: "<comment>@<to>", type: "reply", comment, to (the `at` of Alex's message it answers), by, status,
//            doing: { text, link? } | null, text, seq (rises on every upsert), updated_at }
// Explainer answerers drive it from Claude Code stream-json (tool calls become `doing`, text deltas stream in);
// lanes drive it with `unblock scope typing <slug> T# --doing <text> [--link <url>]` and
// `unblock scope reply <slug> T# --stream` (stdin chunks). The final reply still lands in scope.json as a message;
// partial text never does. GET /api/scope/<slug> carries the live items so a reload shows the same state.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-03T23:10:00Z'
const sections = [
  { id: 'title', heading: 'Rooms', body_md: 'How rooms render agents.' },
  { id: 'body', heading: 'Body', body_md: 'The reducer folds deltas into turns. Voice comes last.' },
]
const source = realpathSync(mkdtempSync(join(tmpdir(), 'live-items-src-')))
const RANK = { seen: 0, thinking: 1, streaming: 2, done: 3, failed: 3 }
const CHUNKS = ['The reducer ', 'lives in ', 'reducer.ts ', 'and folds ', 'deltas (reducer.ts:1).']
const FINAL = CHUNKS.join('')

// A stand-in for `claude -p` stream-json: one Read tool call, then the answer as five text deltas 250 ms apart.
function installAnswerer(dir) {
  const bin = join(dir, 'answerer-stub')
  writeFileSync(bin, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.resume(); process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init' })
  out({ type: 'stream_event', event: { type: 'message_start', message: { content: [] } } })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/repo/research/FINDINGS.md' } }] } })
  setTimeout(() => {
    out({ type: 'stream_event', event: { type: 'message_start', message: { content: [] } } })
    const chunks = ${JSON.stringify(CHUNKS)}
    let i = 0
    const tick = () => {
      if (i < chunks.length) { out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i++] } } }); setTimeout(tick, 250); return }
      out({ type: 'result', subtype: 'success', is_error: false, result: chunks.join('') })
      process.exit(0)
    }
    tick()
  }, 400)
})
`)
  chmodSync(bin, 0o700)
  return bin
}

async function boot(scope) {
  const h = await startScopeHarness(scope)
  const dir = dirname(process.env.HERDR_BIN_PATH)
  const lanePost = join(dir, 'lane-post-stub')
  writeFileSync(lanePost, `#!/bin/sh\necho "b-20261003231000-$$"\n`)
  chmodSync(lanePost, 0o700)
  Object.assign(process.env, { UNBLOCK_ANSWERER_BIN: installAnswerer(dir), UNBLOCK_LANE_POST_BIN: lanePost, UNBLOCK_SUPERVISED: '1' })
  const get = async () => (await h.request(`/api/scope/${scope.slug}`, { headers: human })).json
  const ask = (text, client_id) => h.request(`/api/scope/${scope.slug}/threads`, { method: 'POST', headers: human,
    body: { text, client_id, anchor: anchorInSection(sections[1], 'The reducer folds deltas into turns') } })
  const until = async (check, what, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 40)) } assert.fail(`${what} not reached within ${ms}ms`) }
  return { h, get, ask, until }
}

function checkForward(items) {
  for (let i = 1; i < items.length; i++) {
    assert.ok(RANK[items[i].status] >= RANK[items[i - 1].status], `status went back: ${items[i - 1].status} -> ${items[i].status}`)
    assert.ok(items[i].seq > items[i - 1].seq, 'seq rises on every upsert')
  }
}

function record(port, path) {
  const events = []
  const req = http.request({ host: '127.0.0.1', port, path, headers: human }, (res) => {
    res.setEncoding('utf8')
    let buffer = ''
    res.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = frame.match(/^event: (.+)$/m)?.[1]
        const data = frame.match(/^data: (.+)$/m)?.[1]
        if (event && data) events.push({ event, data: JSON.parse(data), t: Date.now() })
      }
    })
  })
  req.end()
  return { events, items: (thread) => events.filter((e) => e.event === 'item' && e.data.thread === thread).map((e) => ({ ...e.data, t: e.t })), close: () => req.destroy() }
}

test('an explainer answer streams as one live item: thinking with what it reads, then growing text, then done', async () => {
  const slug = 'live-explainer'
  const t = await boot({ version: 2, slug, title: 'Rooms', pane: 'w5H:pQA', kind: 'explainer', sources: [source], revision: 1, updated_at: at, doc: { sections }, threads: [] })
  const live = record(t.h.port, `/api/scope/${slug}/events`)
  try {
    await new Promise((r) => setTimeout(r, 200))
    const posted = Date.now()
    assert.ok([200, 201].includes((await t.ask('Where does the reducer live?', 'c-1')).status))
    await t.until(() => live.items('T1').some((i) => i.status === 'done'), 'done item')
    const items = live.items('T1')
    checkForward(items)
    assert.ok(items[0].t - posted < 2000, 'the first item arrives within 2 s')
    assert.equal(items[0].status, 'thinking')
    assert.equal(items[0].type, 'reply')
    assert.ok(items[0].by, 'names who is answering')
    const thread = (await t.get()).scope.threads[0]
    const alexAt = thread.messages[0].at
    for (const i of items) { assert.equal(i.id, `T1@${alexAt}`); assert.equal(i.to, alexAt) }
    assert.ok(items.some((i) => i.doing?.text === 'Reading FINDINGS.md'), 'the Read tool call shows as the activity line')
    const texts = [...new Set(items.filter((i) => i.status === 'streaming').map((i) => i.text))]
    assert.ok(texts.length >= 3, `the text grows in at least three steps, saw ${texts.length}`)
    for (let i = 1; i < texts.length; i++) assert.ok(texts[i].startsWith(texts[i - 1]) && texts[i].length > texts[i - 1].length, 'each step extends the last')
    assert.equal(items.at(-1).status, 'done')
    assert.equal(items.at(-1).text, FINAL)
    const answer = thread.messages.find((m) => m.from === 'agent')
    assert.equal(answer.text, FINAL, 'the final reply lands in the comment')
    assert.ok(!answer.pending)
    const scopeFrames = live.events.filter((e) => e.event === 'scope' || e.event === 'state')
    for (const frame of scopeFrames) {
      const scope = frame.data.scope ?? frame.data
      for (const m of scope.threads?.flatMap((th) => th.messages) ?? []) {
        if (m.from === 'agent' && m.pending) assert.match(m.text, /^Answering/, 'partial text never goes into scope.json')
      }
    }
    const payload = await t.get()
    assert.ok(Array.isArray(payload.items), 'GET carries live items')
    assert.equal(payload.items.find((i) => i.thread === 'T1')?.status, 'done')
  } finally { live.close(); await t.h.close() }
})

test('a lane shows what it is doing, streams its reply from stdin, and a finished item never moves back', async () => {
  const slug = 'live-lane'
  const t = await boot({ version: 2, slug, title: 'Rooms', pane: 'w5H:pQA', revision: 1, updated_at: at, doc: { sections }, threads: [] })
  const live = record(t.h.port, `/api/scope/${slug}/events`)
  const env = { ...process.env, UNBLOCK_PORT: String(t.h.port) }
  const cli = (args, input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('close', (status) => resolve({ status, out, err }))
    if (typeof input === 'function') input(child.stdin); else child.stdin.end(input ?? '')
  })
  try {
    await new Promise((r) => setTimeout(r, 200))
    assert.ok([200, 201].includes((await t.ask('Why last?', 'c-1')).status))

    const typing = await cli(['scope', 'typing', slug, 'T1', '--doing', 'Asked rooms-mocks-dev · waiting', '--link', 'https://studio.example.ts.net/r/1'])
    assert.equal(typing.status, 0, typing.err)
    await t.until(() => live.items('T1').some((i) => i.status === 'thinking'), 'thinking item')
    const thinking = live.items('T1').at(-1)
    assert.deepEqual(thinking.doing, { text: 'Asked rooms-mocks-dev · waiting', link: 'https://studio.example.ts.net/r/1' })

    const bad = await cli(['scope', 'typing', slug, 'T1', '--doing', 'x', '--link', 'javascript:alert(1)'])
    assert.notEqual(bad.status, 0, 'a non-http link is refused')
    const human403 = await t.h.request(`/api/scope/${slug}/threads/T1/typing`, { method: 'POST', headers: human, body: { doing: 'spoof' } })
    assert.equal(human403.status, 403, 'only lanes post typing')

    const streamed = await cli(['scope', 'reply', slug, 'T1', '--stream'], (stdin) => {
      let i = 0
      const tick = () => { if (i < CHUNKS.length) { stdin.write(CHUNKS[i++]); setTimeout(tick, 300) } else stdin.end() }
      tick()
    })
    assert.equal(streamed.status, 0, streamed.err)
    await t.until(() => live.items('T1').some((i) => i.status === 'done'), 'done item')
    const items = live.items('T1')
    checkForward(items)
    const texts = [...new Set(items.filter((i) => i.status === 'streaming').map((i) => i.text))]
    assert.ok(texts.length >= 3, `the reply grows in at least three steps, saw ${texts.length}`)
    for (let i = 1; i < texts.length; i++) assert.ok(texts[i].startsWith(texts[i - 1]), 'each step extends the last')
    assert.equal(items.at(-1).text, FINAL)
    const thread = (await t.get()).scope.threads[0]
    assert.equal(thread.messages.filter((m) => m.from === 'agent').at(-1)?.text, FINAL, 'the full reply lands in the comment')

    const count = live.items('T1').length
    const late = await cli(['scope', 'typing', slug, 'T1', '--doing', 'too late'])
    assert.equal(late.status, 0, 'a late typing call is accepted and ignored')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(live.items('T1').length, count, 'no item event after done')
    assert.equal((await t.get()).items.find((i) => i.id === items.at(-1).id).status, 'done')
  } finally { live.close(); await t.h.close() }
})
