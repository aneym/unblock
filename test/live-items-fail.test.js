// Owner: Opus (explainers lane for w5H:p0M, 2026-10-03). Implementers make it pass and never edit it.
// Follow-up to test/live-items.test.js (team-lead, 2026-10-03): "A streaming item must never stick. When the final
// reply is refused (the 600-character cap or any other error), the item ends `failed` with a short reason. Suppress the
// "NEEDS_OW" fragment. Add a total cap on streamed text."
// Contract: a refused lane reply (any 4xx on POST threads/T#/reply from a lane) ends that turn's thinking or streaming
// item failed, error = the refusal message (at most 200 characters). A lane stream that goes quiet for
// UNBLOCK_LIVE_STALE_MS (default 90 s) ends failed. A lane stream past 12000 characters is refused with 413 and the item
// ends failed. An explainer's streamed text never shows any part of a NEEDS_OWNER line. A typing --link is trimmed
// before it is checked and stored (team-lead, 2026-10-03: "a link with leading spaces gets rejected or normalized").
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'
import { authToken } from '../plugin/paths.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-03T23:10:00Z'
const sections = [
  { id: 'title', heading: 'Rooms', body_md: 'How rooms render agents.' },
  { id: 'body', heading: 'Body', body_md: 'The reducer folds deltas into turns. Voice comes last.' },
]
const source = realpathSync(mkdtempSync(join(tmpdir(), 'live-fail-src-')))
const ANSWER = 'Voice waits for the phone page.'
// The answer, then a NEEDS_OWNER line that arrives in two deltas with a pause between them (the page flushes at 100 ms).
const DELTAS = [ANSWER, '\nNEEDS_OW', 'NER: who owns the voice budget?']

function installAnswerer(dir) {
  const bin = join(dir, 'answerer-needs-owner')
  writeFileSync(bin, `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.resume(); process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init' })
  out({ type: 'stream_event', event: { type: 'message_start', message: { content: [] } } })
  const chunks = ${JSON.stringify(DELTAS)}
  let i = 0
  const tick = () => {
    if (i < chunks.length) { out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i++] } } }); setTimeout(tick, 400); return }
    out({ type: 'result', subtype: 'success', is_error: false, result: chunks.join('') })
    process.exit(0)
  }
  tick()
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
  const env = { ...process.env, UNBLOCK_PORT: String(h.port) }
  const cli = (args, input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('close', (status) => resolve({ status, out, err, t: Date.now() }))
    if (typeof input === 'function') input(child.stdin, child); else child.stdin.end(input ?? '')
  })
  return { h, get, ask, until, cli }
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

const laneScope = (slug) => ({ version: 2, slug, title: 'Rooms', pane: 'w5H:pQA', revision: 1, updated_at: at, doc: { sections }, threads: [] })

test('a lane reply refused at the 600-character cap ends the live item failed with the reason', async () => {
  const slug = 'live-refused'
  const t = await boot(laneScope(slug))
  const live = record(t.h.port, `/api/scope/${slug}/events`)
  try {
    await new Promise((r) => setTimeout(r, 200))
    assert.ok([200, 201].includes((await t.ask('Why last?', 'c-1')).status))
    const long = 'Voice waits for the phone page. '.repeat(22) // 704 characters
    const run = await t.cli(['scope', 'reply', slug, 'T1', '--stream'], (stdin) => { stdin.write(long.slice(0, 350)); setTimeout(() => stdin.end(long.slice(350)), 300) })
    assert.notEqual(run.status, 0, 'the final reply is refused')
    await t.until(() => live.items('T1').some((i) => i.status === 'streaming'), 'streaming item', 2000).catch(() => assert.fail('the reply streamed first'))
    await t.until(() => live.items('T1').at(-1)?.status === 'failed', 'failed item', 2000)
    const last = live.items('T1').at(-1)
    assert.match(last.error, /too long/, 'the reason says why')
    assert.ok(last.error.length <= 200, 'the reason is short')
    assert.equal((await t.get()).items.find((i) => i.thread === 'T1')?.status, 'failed', 'GET agrees after a reload')
    assert.equal((await t.get()).scope.threads[0].messages.filter((m) => m.from === 'agent').length, 0, 'no reply landed')
  } finally { live.close(); await t.h.close() }
})

test('a lane stream that goes quiet ends failed instead of streaming forever', async () => {
  const slug = 'live-quiet'
  process.env.UNBLOCK_LIVE_STALE_MS = '1500'
  const t = await boot(laneScope(slug))
  const live = record(t.h.port, `/api/scope/${slug}/events`)
  try {
    await new Promise((r) => setTimeout(r, 200))
    assert.ok([200, 201].includes((await t.ask('Why last?', 'c-1')).status))
    let killedAt = 0
    await t.cli(['scope', 'reply', slug, 'T1', '--stream'], (stdin, child) => {
      stdin.write('Voice waits ')
      setTimeout(() => { killedAt = Date.now(); child.kill('SIGKILL') }, 800) // the lane dies mid-reply
    })
    await t.until(() => live.items('T1').some((i) => i.status === 'streaming'), 'streaming item', 2000)
    await t.until(() => live.items('T1').at(-1)?.status === 'failed', 'failed item', 5000)
    const last = live.items('T1').at(-1)
    const lastChunk = live.items('T1').filter((i) => i.status === 'streaming').at(-1)
    assert.ok(killedAt > 0 && last.t - lastChunk.t >= 1200, `it waits for the quiet window after the last chunk, not the first gap (${last.t - lastChunk.t} ms)`)
    assert.ok(typeof last.error === 'string' && last.error.length > 0 && last.error.length <= 200, 'a short reason')
  } finally { delete process.env.UNBLOCK_LIVE_STALE_MS; live.close(); await t.h.close() }
})

test('a lane stream past 12000 characters is refused and ends failed; the text never grows past the cap', async () => {
  const slug = 'live-capped'
  const t = await boot(laneScope(slug))
  const live = record(t.h.port, `/api/scope/${slug}/events`)
  try {
    await new Promise((r) => setTimeout(r, 200))
    assert.ok([200, 201].includes((await t.ask('Why last?', 'c-1')).status))
    const run = await t.cli(['scope', 'reply', slug, 'T1', '--stream'], 'x'.repeat(16000))
    assert.notEqual(run.status, 0, 'the stream is refused')
    await t.until(() => live.items('T1').at(-1)?.status === 'failed', 'failed item', 3000)
    const items = live.items('T1')
    assert.ok(items.every((i) => (i.text ?? '').length <= 12000), `text stays within the cap (max ${Math.max(...items.map((i) => (i.text ?? '').length))})`)
    assert.match(items.at(-1).error, /long/)
  } finally { live.close(); await t.h.close() }
})

test('an explainer answer never shows any part of a NEEDS_OWNER line while it streams', async () => {
  const slug = 'live-needs-owner'
  const t = await boot({ ...laneScope(slug), kind: 'explainer', sources: [source] })
  const live = record(t.h.port, `/api/scope/${slug}/events`)
  try {
    await new Promise((r) => setTimeout(r, 200))
    assert.ok([200, 201].includes((await t.ask('Where does voice go?', 'c-1')).status))
    await t.until(() => live.items('T1').some((i) => ['done', 'failed'].includes(i.status)), 'finished item')
    const items = live.items('T1')
    assert.ok(items.some((i) => i.status === 'streaming' && i.text.includes('Voice waits')), 'the answer streamed')
    for (const i of items) assert.ok(!/NEED|\nN\s*$/.test(i.text ?? ''), `no NEEDS_OWNER fragment, saw ${JSON.stringify(i.text)}`)
    assert.equal(items.at(-1).text, ANSWER)
  } finally { live.close(); await t.h.close() }
})

test('a typing link is trimmed before it is checked and stored; blank or non-http links are refused', async () => {
  const slug = 'live-link-trim'
  const t = await boot(laneScope(slug))
  const live = record(t.h.port, `/api/scope/${slug}/events`)
  try {
    await new Promise((r) => setTimeout(r, 200))
    assert.ok([200, 201].includes((await t.ask('Why last?', 'c-1')).status))
    const ok = await t.cli(['scope', 'typing', slug, 'T1', '--doing', 'Reading the plan', '--link', '   https://studio.example.ts.net/r/1  '])
    assert.equal(ok.status, 0, ok.err)
    await t.until(() => live.items('T1').some((i) => i.doing?.link), 'item with a link', 3000)
    assert.equal(live.items('T1').at(-1).doing.link, 'https://studio.example.ts.net/r/1', 'stored without the spaces')
    const lane = () => ({ authorization: `Bearer ${authToken()}` }) // the lane's own token, as the CLI sends it
    for (const link of ['   ', '  javascript:alert(1)', '\thttps://x.example/\n'.replace('https', 'ftp')]) {
      const res = await t.h.request(`/api/scope/${slug}/threads/T1/typing`, { method: 'POST', headers: lane(), body: { doing: 'x', link } })
      assert.equal(res.status, 400, `refused: ${JSON.stringify(link)}`)
    }
    // Control characters inside or at the edges of a link are refused, not silently dropped by URL parsing.
    for (const link of ['\x01https://x.example/', 'https://x.example/\x00', 'https://x.example/a\nb', 'https://x.example/\x7f']) {
      const res = await t.h.request(`/api/scope/${slug}/threads/T1/typing`, { method: 'POST', headers: lane(), body: { doing: 'x', link } })
      assert.equal(res.status, 400, `refused: ${JSON.stringify(link)}`)
    }
    const ctrl = await t.cli(['scope', 'typing', slug, 'T1', '--doing', 'x', '--link', 'https://x.example/a\x01b'])
    assert.notEqual(ctrl.status, 0, 'the CLI refuses a control character locally')
    const raw = await t.h.request(`/api/scope/${slug}/threads/T1/typing`, { method: 'POST', headers: lane(), body: { doing: 'Reading', link: '\n https://studio.example.ts.net/r/2 ' } })
    assert.equal(raw.status, 200, 'the route trims too, not only the CLI')
    assert.equal(raw.json.item.doing.link, 'https://studio.example.ts.net/r/2')
  } finally { live.close(); await t.h.close() }
})
