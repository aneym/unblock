// Owner: Opus (comment-latency responder throughput, 2026-10-06). Implementers make it pass and never edit it.
// From the real-comment replay (comment-latency replay/RESULTS.md): 18 comments at once missed the 20 s / 45 s target
// because comments 9-18 waited 12-28 s for one of 8 slots, and each slot stayed held until the lane-post finished
// (up to its 20 s timeout). Contract: a slot frees once the answer is written; the owner post follows without holding
// the queue; a burst of 20 comments starts at once by default. A responder edit on a section with curly quotes lands
// with straight quotes, since the doc lint refuses curly ones.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-06T18:00:00Z'
const sections = [
  { id: 'title', heading: 'Comment latency', body_md: 'Comments come back slowly today.' },
  { id: 'stream', heading: 'The stream', body_md: 'Events arrive over a websocket.' },
  { id: 'quotes', heading: 'What he said', body_md: 'He said “ship it” and it’s done.' },
]
const scopeDoc = (slug) => ({ version: 2, slug, title: 'Comment latency', pane: 'w5H:pQA', revision: 1, updated_at: at, doc: { sections }, threads: [] })

// A stand-in for `claude -p` as a scope responder: logs when it started, answers the last Q-<n> tag after
// STUB_ANSWER_MS and, unless the comment says NOEDIT, proposes its section's body as the prompt showed it plus
// "Edited by Q-<n>.".
function installResponder(dir) {
  const runs = join(dir, 'runs')
  mkdirSync(runs, { recursive: true })
  const bin = join(dir, 'responder-stub')
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const started = Date.now()
const headings = ${JSON.stringify(Object.fromEntries(sections.map((s) => [s.id, s.heading])))}
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { prompt += c })
process.stdin.on('end', () => {
  const tags = prompt.match(/Q-\\d+/g) || ['none']
  const tag = tags[tags.length - 1]
  const asked = prompt.slice(prompt.lastIndexOf(tag))
  const id = (prompt.match(/section id: ([A-Za-z0-9_-]+)\\)/) || [])[1]
  const start = prompt.indexOf('## ' + headings[id] + '\\n') + ('## ' + headings[id] + '\\n').length
  const ends = [prompt.indexOf('\\n\\n## ', start), prompt.indexOf('\\n\\n# Other comments', start)].filter((i) => i >= 0)
  const body = prompt.slice(start, Math.min(...ends))
  fs.writeFileSync(path.join(${JSON.stringify(runs)}, tag + '-' + process.pid + '.json'), JSON.stringify({ tag, section: id, body, started }))
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  out({ type: 'system', subtype: 'init' })
  setTimeout(() => {
    const edit = asked.includes('NOEDIT') ? '' : '\\nEDIT ' + id + '\\n## ' + headings[id] + ' {#' + id + '}\\n\\n' + body + '\\nEdited by ' + tag + '.\\nEND_EDIT'
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Answer for ' + tag + ': done.' + edit })
    process.exit(0)
  }, Number(process.env.STUB_ANSWER_MS || 300))
})
`)
  chmodSync(bin, 0o700)
  const list = () => readdirSync(runs).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(runs, f), 'utf8')))
  return { bin, list }
}

async function boot(scope, env = {}) {
  const h = await startScopeHarness(scope)
  const dir = dirname(process.env.HERDR_BIN_PATH)
  const responder = installResponder(dir)
  // A slow lane: every owner post takes STUB_LANE_POST_S seconds.
  const lanePostLog = join(dir, 'lane-post.log')
  const lanePost = join(dir, 'lane-post-stub')
  writeFileSync(lanePost, `#!/bin/sh\nsleep "\${STUB_LANE_POST_S:-0}"\nline=''\nfor a in "$@"; do line="$line$a$(printf '\\037')"; done\nprintf '%s\\n' "$line" >> '${lanePostLog}'\necho "b-20261006180000-$$"\n`)
  chmodSync(lanePost, 0o700)
  const cli = join(dir, 'unblock-cli')
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`)
  chmodSync(cli, 0o700)
  // The default cap is what this file tests, so no inherited override.
  delete process.env.UNBLOCK_EXPLAINER_CONCURRENCY
  Object.assign(process.env, { UNBLOCK_ANSWERER_BIN: responder.bin, UNBLOCK_LANE_POST_BIN: lanePost, UNBLOCK_CLI_BIN: cli, UNBLOCK_SUPERVISED: '1',
    UNBLOCK_EXPLAINER_TIMEOUT_MS: '180000', STUB_ANSWER_MS: '300', STUB_LANE_POST_S: '0', ...env })
  const posts = () => existsSync(lanePostLog) ? readFileSync(lanePostLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f')) : []
  const get = async () => (await h.request(`/api/scope/${scope.slug}`, { headers: human })).json.scope
  const ask = (section, quote, text, client_id) => h.request(`/api/scope/${scope.slug}/threads`, { method: 'POST', headers: human,
    body: { text, client_id, anchor: anchorInSection(sections.find((s) => s.id === section), quote) } })
  const until = async (check, what, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)) } assert.fail(`${what} not reached within ${ms}ms`) }
  return { h, responder, posts, get, ask, until }
}

const answer = (scope, tag) => scope.threads.find((t) => t.messages.some((m) => m.from === 'alex' && m.text.split(' ')[0] === tag))
  ?.messages.filter((m) => m.from === 'agent').at(-1)
const tags = (n) => Array.from({ length: n }, (_, i) => `Q-${i + 1}`)

test('20 comments at once all start within 2 s and get their answers while every lane-post takes 10 s', async () => {
  const t = await boot(scopeDoc('burst'), { STUB_LANE_POST_S: '10' })
  try {
    const posted = Date.now()
    const replies = await Promise.all(tags(20).map((tag, i) => t.ask('stream', 'websocket', `${tag} NOEDIT a question`, `b-${i}`)))
    for (const reply of replies) assert.ok(reply.status < 300, reply.text)
    await t.until(() => t.responder.list().length === 20, '20 responder runs', 8000)
    const late = t.responder.list().filter((run) => run.started - posted > 2000).map((run) => `${run.tag} +${run.started - posted}ms`)
    assert.deepEqual(late, [], 'every comment starts within 2 s of the burst')
    await t.until(async () => { const scope = await t.get(); return tags(20).every((tag) => answer(scope, tag) && !answer(scope, tag).pending) },
      'all 20 answers written before any lane-post returns', 9000)
    await t.until(() => t.posts().length === 20, 'every answer still reaches the owner pane', 20000)
  } finally { await t.h.close() }
})

test('a slot frees once the answer is written: with a cap of 4, 8 comments all start before the first lane-post returns', async () => {
  const t = await boot(scopeDoc('slots'), { STUB_LANE_POST_S: '10', UNBLOCK_EXPLAINER_CONCURRENCY: '4' })
  try {
    const posted = Date.now()
    await Promise.all(tags(8).map((tag, i) => t.ask('stream', 'websocket', `${tag} NOEDIT a question`, `s-${i}`)))
    await t.until(() => t.responder.list().length === 8, '8 responder runs', 8000)
    assert.ok(t.responder.list().every((run) => run.started - posted < 5000), 'comments 5-8 never wait for a lane-post to finish')
    await t.until(() => t.posts().length === 8, 'every answer reaches the owner pane', 25000)
  } finally { await t.h.close() }
})

test('a responder edit on a section with curly quotes lands, with the quotes made straight', async () => {
  const t = await boot(scopeDoc('quotes'))
  try {
    await t.ask('quotes', 'ship it', 'Q-1 add a line', 'q-1')
    await t.until(async () => { const a = answer(await t.get(), 'Q-1'); return a && !a.pending }, 'a settled answer')
    const scope = await t.get()
    assert.equal(scope.doc.sections.find((s) => s.id === 'quotes').body_md, 'He said "ship it" and it\'s done.\nEdited by Q-1.')
    assert.ok(!answer(scope, 'Q-1').needs_owner, answer(scope, 'Q-1').text)
  } finally { await t.h.close() }
})
