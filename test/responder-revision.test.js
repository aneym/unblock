// Owner: Opus (comment-latency responder revision check, 2026-10-06). Implementers make it pass and never edit it.
// Plan (comment-latency #options, "The responder's risk"): the responder edits only its comment's section, and only if
// that section is still the one it read. If the section changed, it reads the doc again and answers once more. If it
// changed again, the answer posts without the edit and the comment goes to the lane. Another section changing never
// blocks an edit, so the check is per section, not per doc revision.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-06T16:00:00Z'
const sections = [
  { id: 'title', heading: 'Comment latency', body_md: 'Comments come back slowly today.' },
  { id: 'stream', heading: 'The stream', body_md: 'Events arrive over a websocket.' },
  { id: 'tools', heading: 'Tool calls', body_md: 'Each tool call gets a row.' },
]
const scopeDoc = (slug) => ({ version: 2, slug, title: 'Comment latency', pane: 'w5H:pQA', revision: 1, updated_at: at, doc: { sections }, threads: [] })

// A stand-in for `claude -p` as a scope responder. It answers the last Q-<n> tag and proposes an edit to the comment's
// section: the section body exactly as the prompt showed it, plus one line "Edited by Q-<n>.". "FAST" answers at
// once. "CHURN" plays a lane that rewrites the same section while the responder thinks, on every run.
function installResponder(dir) {
  const runs = join(dir, 'runs')
  mkdirSync(runs, { recursive: true })
  const bin = join(dir, 'responder-stub')
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process')
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
  fs.writeFileSync(path.join(${JSON.stringify(runs)}, tag + '-' + process.pid + '.json'), JSON.stringify({ tag, section: id, body, prompt }))
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  out({ type: 'system', subtype: 'init' })
  setTimeout(() => {
    if (asked.includes('CHURN')) {
      const file = path.join(${JSON.stringify(runs)}, 'lane-' + process.pid + '.md')
      fs.writeFileSync(file, '## ' + headings[id] + ' {#' + id + '}\\n\\n' + body + '\\nLane change ' + process.pid + '.\\n')
      execFileSync(process.env.UNBLOCK_CLI_BIN, ['scope', 'patch', process.env.STUB_SLUG, id, '--from', file], { stdio: 'ignore' })
    }
    const text = 'Answer for ' + tag + ': done.\\nEDIT ' + id + '\\n## ' + headings[id] + ' {#' + id + '}\\n\\n' + body + '\\nEdited by ' + tag + '.\\nEND_EDIT'
    out({ type: 'result', subtype: 'success', is_error: false, result: text })
    process.exit(0)
  }, asked.includes('FAST') ? 50 : Number(process.env.STUB_ANSWER_MS || 1200))
})
`)
  chmodSync(bin, 0o700)
  const list = () => readdirSync(runs).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(runs, f), 'utf8')))
  return { bin, list }
}

async function boot(scope) {
  const h = await startScopeHarness(scope)
  const dir = dirname(process.env.HERDR_BIN_PATH)
  const responder = installResponder(dir)
  const lanePostLog = join(dir, 'lane-post.log')
  const lanePost = join(dir, 'lane-post-stub')
  writeFileSync(lanePost, `#!/bin/sh\nline=''\nfor a in "$@"; do line="$line$a$(printf '\\037')"; done\nprintf '%s\\n' "$line" >> '${lanePostLog}'\necho "b-20261006160000-$$"\n`)
  chmodSync(lanePost, 0o700)
  // The responder edits through the real CLI against this daemon, as the installed daemon does through ~/.local/bin/unblock.
  const cli = join(dir, 'unblock-cli')
  writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${CLI}' "$@"\n`)
  chmodSync(cli, 0o700)
  Object.assign(process.env, { UNBLOCK_ANSWERER_BIN: responder.bin, UNBLOCK_LANE_POST_BIN: lanePost, UNBLOCK_CLI_BIN: cli, UNBLOCK_SUPERVISED: '1',
    UNBLOCK_EXPLAINER_CONCURRENCY: '8', UNBLOCK_EXPLAINER_TIMEOUT_MS: '180000', STUB_ANSWER_MS: '1200', STUB_SLUG: scope.slug })
  const posts = () => existsSync(lanePostLog) ? readFileSync(lanePostLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f')) : []
  const get = async () => (await h.request(`/api/scope/${scope.slug}`, { headers: human })).json.scope
  const ask = (section, quote, text, client_id) => h.request(`/api/scope/${scope.slug}/threads`, { method: 'POST', headers: human,
    body: { text, client_id, anchor: anchorInSection(sections.find((s) => s.id === section), quote) } })
  const until = async (check, what, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)) } assert.fail(`${what} not reached within ${ms}ms`) }
  return { h, responder, posts, get, ask, until }
}

const body = (scope, id) => scope.doc.sections.find((s) => s.id === id).body_md
const answer = (scope, tag) => scope.threads.find((t) => t.messages.some((m) => m.from === 'alex' && m.text.includes(tag)))
  ?.messages.filter((m) => m.from === 'agent').at(-1)

test('two responders edit one section: one edit lands, the other reads the new text and lands once; another section edits freely', async () => {
  const t = await boot(scopeDoc('two-writers'))
  try {
    const replies = await Promise.all([
      t.ask('stream', 'websocket', 'Q-1 say it is a websocket stream', 'r-1'),
      t.ask('stream', 'websocket', 'Q-2 add that deltas fold into turns', 'r-2'),
      t.ask('tools', 'row', 'Q-3 FAST say the row collapses', 'r-3'),
    ])
    for (const reply of replies) assert.ok(reply.status < 300, reply.text)
    await t.until(async () => {
      const scope = await t.get()
      return ['Q-1', 'Q-2', 'Q-3'].every((tag) => answer(scope, tag) && !answer(scope, tag).pending)
    }, 'three settled answers')
    const scope = await t.get()
    const stream = body(scope, 'stream')
    assert.ok(stream.includes('Edited by Q-1.') && stream.includes('Edited by Q-2.'), `both edits are in §stream, neither overwrote the other:\n${stream}`)
    assert.ok(stream.startsWith('Events arrive over a websocket.'), stream)
    assert.ok(body(scope, 'tools').includes('Edited by Q-3.'), 'the comment on another section edited it')

    const runs = t.responder.list()
    const count = (tag) => runs.filter((run) => run.tag === tag).length
    assert.equal(count('Q-3'), 1, 'another section changing never forces a retry')
    assert.deepEqual([count('Q-1'), count('Q-2')].sort(), [1, 2], 'exactly one of the two same-section responders retried, once')
    const loser = count('Q-1') === 2 ? 'Q-1' : 'Q-2'
    const winner = loser === 'Q-1' ? 'Q-2' : 'Q-1'
    const retry = runs.filter((run) => run.tag === loser).find((run) => run.body.includes(`Edited by ${winner}.`))
    assert.ok(retry, `the retry for ${loser} read §stream with ${winner}'s edit in it`)
    assert.ok(stream.indexOf(`Edited by ${winner}.`) < stream.indexOf(`Edited by ${loser}.`), 'the retried edit builds on the landed one')
    for (const tag of ['Q-1', 'Q-2', 'Q-3']) assert.ok(!answer(scope, tag).needs_owner, `${tag} landed its edit and needs no owner`)
  } finally { await t.h.close() }
})

test('a section that changes again during the retry keeps the answer, drops the edit and hands the comment to the lane', async () => {
  const t = await boot(scopeDoc('churn'))
  try {
    const reply = await t.ask('stream', 'websocket', 'Q-4 CHURN tighten this line', 'c-4')
    assert.ok(reply.status < 300, reply.text)
    await t.until(async () => { const a = answer(await t.get(), 'Q-4'); return a && !a.pending }, 'a settled answer')
    const scope = await t.get()
    const settled = answer(scope, 'Q-4')
    assert.ok(settled.text.includes('Answer for Q-4'), 'the answer still posts in the comment')
    assert.ok(settled.needs_owner, 'the comment is marked for the owner')
    assert.ok(!body(scope, 'stream').includes('Edited by Q-4.'), 'the stale edit never lands')
    assert.equal(body(scope, 'stream').match(/Lane change/g)?.length, 2, "the lane's two changes both stand")
    assert.equal(t.responder.list().filter((run) => run.tag === 'Q-4').length, 2, 'one answer and exactly one retry')
    await t.until(() => t.posts().some((args) => args[args.indexOf('--kind') + 1] === 'task' && args.join(' ').includes('Q-4')), 'a task post to the lane')
  } finally { await t.h.close() }
})
