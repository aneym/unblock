// Owner: Opus (explainers lane for w5H:p0M, 2026-10-03). Implementers make it pass and never edit it.
// Alex (2026-10-03 ~17:00 ET): "we need a new primative: explainer docs similar to scoping ... i wanna s questions as i
// go through them and get basically instant answers ... if i ask multiple questions and you take time responding,
// curious if that's somethign we could work around."
// Contract: a scope with kind "explainer" answers Alex's margin questions itself. Each question or follow-up gets an
// "Answering…" agent message at once and its own answerer process (headless Claude Code), in parallel up to a
// concurrency cap. The owner pane gets every Q&A as a lane-post info post; needs-owner answers and timeouts go as tasks.
// Plain scopes (answerer off by default) keep the old lane delivery and spawn nothing.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-03T21:00:00Z'
const sections = [
  { id: 'title', heading: 'How T3 renders Claude', body_md: 'T3 Code draws Claude turns as cards.' },
  { id: 'stream', heading: 'The stream', body_md: 'Events arrive over a websocket. The reducer folds deltas into turns.' },
  { id: 'tools', heading: 'Tool calls', body_md: 'Each tool call gets a collapsible row with its input and result.' },
]
// Real paths: on macOS tmpdir() sits behind the /var -> /private/var symlink, and a process's cwd is always the real path.
const sourceA = realpathSync(mkdtempSync(join(tmpdir(), 'explainer-src-a-')))
const sourceB = realpathSync(mkdtempSync(join(tmpdir(), 'explainer-src-b-')))
writeFileSync(join(sourceA, 'reducer.ts'), 'export function fold() {}\n')
const explainer = (slug, extra = {}) => ({ version: 2, slug, title: 'How T3 renders Claude', pane: 'w5H:pQA', kind: 'explainer',
  sources: [sourceA, sourceB], revision: 1, updated_at: at, doc: { sections }, threads: [], ...extra })

// A stand-in for `claude -p`: logs its argv, cwd, stdin and timing, then prints Claude Code stream-json.
// The answer names the last Q-<n> tag it was asked about. "SLOW" sleeps past any timeout, "DECIDE" flags the owner.
function installAnswerer(dir) {
  const runs = join(dir, 'runs')
  mkdirSync(runs, { recursive: true })
  const bin = join(dir, 'answerer-stub')
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path')
const started = Date.now()
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { prompt += c })
process.stdin.on('end', () => {
  const tags = prompt.match(/Q-\\d+/g) || ['none']
  const tag = tags[tags.length - 1]
  const file = path.join(${JSON.stringify(runs)}, tag + '-' + process.pid + '.json')
  const log = (extra) => fs.writeFileSync(file, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt, pid: process.pid, started, ...extra }))
  log({})
  const ms = prompt.slice(prompt.lastIndexOf(tag)).includes('SLOW') ? 20000 : Number(process.env.STUB_ANSWER_MS || 1200)
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  out({ type: 'system', subtype: 'init' })
  out({ type: 'stream_event', event: { type: 'message_start', message: { content: [] } } })
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial for ' + tag } } })
  setTimeout(() => {
    const decide = prompt.slice(prompt.lastIndexOf(tag)).includes('DECIDE')
    const text = 'Answer for ' + tag + ': the reducer folds deltas (reducer.ts:1).' + (decide ? '\\nNEEDS_OWNER: this needs a product call on retention.' : '')
    out({ type: 'result', subtype: 'success', is_error: false, result: text })
    log({ ended: Date.now() })
    process.exit(0)
  }, ms)
})
`)
  chmodSync(bin, 0o700)
  const list = () => readdirSync(runs).map((f) => JSON.parse(readFileSync(join(runs, f), 'utf8')))
  return { bin, list }
}

function installLanePost(dir) {
  const log = join(dir, 'lane-post.log')
  const bin = join(dir, 'lane-post-stub')
  // One write per post: parallel posts must not interleave their argv in the log.
  writeFileSync(bin, `#!/bin/sh\nline=''\nfor a in "$@"; do line="$line$a$(printf '\\037')"; done\nprintf '%s\\n' "$line" >> '${log}'\necho "b-20261003210000-$$"\n`)
  chmodSync(bin, 0o700)
  const posts = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => line.split('\x1f').filter((x, i, a) => i < a.length - 1 || x)) : []
  const flag = (args, name) => args[args.indexOf(name) + 1]
  return { bin, posts, flag }
}

async function boot(scope, env = {}) {
  const h = await startScopeHarness(scope)
  const dir = dirname(process.env.HERDR_BIN_PATH)
  const answerer = installAnswerer(dir)
  const lane = installLanePost(dir)
  Object.assign(process.env, { UNBLOCK_ANSWERER_BIN: answerer.bin, UNBLOCK_LANE_POST_BIN: lane.bin, UNBLOCK_SUPERVISED: '1',
    UNBLOCK_EXPLAINER_CONCURRENCY: '8', UNBLOCK_EXPLAINER_TIMEOUT_MS: '180000', STUB_ANSWER_MS: '1200', ...env })
  const get = async () => (await h.request(`/api/scope/${scope.slug}`, { headers: human })).json.scope
  const ask = (section, quote, text, client_id) => h.request(`/api/scope/${scope.slug}/threads`, { method: 'POST', headers: human,
    body: { text, client_id, anchor: anchorInSection(sections.find((s) => s.id === section), quote) } })
  const until = async (check, what, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 40)) } assert.fail(`${what} not reached within ${ms}ms`) }
  return { h, answerer, lane, get, ask, until }
}

const agentMessages = (thread) => thread.messages.filter((m) => m.from === 'agent')

test('three questions at once get three answers in parallel, each started at once, and the owner hears each Q&A as info', async () => {
  const t = await boot(explainer('t3-qa'))
  try {
    const posted = Date.now()
    const replies = await Promise.all([
      t.ask('stream', 'The reducer folds deltas into turns', 'Q-1 where does the reducer live?', 'c-1'),
      t.ask('tools', 'collapsible row', 'Q-2 is the row collapsed by default?', 'c-2'),
      t.ask('stream', 'Events arrive over a websocket', 'Q-3 what websocket library?', 'c-3'),
    ])
    for (const r of replies) assert.ok([200, 201].includes(r.status), r.text)

    // "Answering…" shows at once on every thread, before any answer exists.
    const early = await t.get()
    assert.equal(early.threads.length, 3)
    for (const thread of early.threads) {
      const pending = agentMessages(thread)
      assert.equal(pending.length, 1, `${thread.id} shows one agent message at once`)
      assert.equal(pending[0].pending, true)
      assert.match(pending[0].text, /^Answering/)
    }

    await t.until(async () => (await t.get()).threads.every((th) => agentMessages(th).some((m) => !m.pending && /^Answer for Q-\d/.test(m.text))), 'all three answers posted')
    const runs = t.answerer.list()
    assert.equal(runs.length, 3, 'one answerer process per thread')
    for (const run of runs) assert.ok(run.started - posted < 2000, `answerer for ${run.prompt.match(/Q-\d+/g).at(-1)} started within 2 s`)
    assert.ok(Math.max(...runs.map((r) => r.started)) < Math.min(...runs.map((r) => r.ended)), 'the three answerers overlapped (parallel, not queued)')

    const done = await t.get()
    for (const thread of done.threads) {
      const tag = thread.messages[0].text.match(/Q-\d+/)[0]
      const answers = agentMessages(thread)
      assert.equal(answers.length, 1, 'the pending message becomes the answer; no second agent message')
      assert.equal(answers[0].text, `Answer for ${tag}: the reducer folds deltas (reducer.ts:1).`, 'the answer for this thread, not another')
      assert.ok(!answers[0].needs_owner)
    }

    // Each process ran read-only on Sonnet 5.5 medium, in the first source dir, with the doc, quote, question and sources.
    for (const run of runs) {
      const tag = run.prompt.match(/Q-\d+/g).at(-1)
      const thread = done.threads.find((th) => th.messages[0].text.startsWith(tag))
      assert.equal(run.cwd, sourceA)
      assert.ok(run.args.includes('-p'))
      assert.equal(run.args[run.args.indexOf('--model') + 1], 'claude-sonnet-5-5')
      assert.equal(run.args[run.args.indexOf('--effort') + 1], 'medium')
      const toolsArg = run.args.slice(run.args.indexOf('--tools') + 1).join(' ')
      for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch']) assert.match(toolsArg, new RegExp(tool))
      assert.ok(!/\b(Bash|Edit|Write)\b/.test(run.args.join(' ')), 'no write or shell tools')
      assert.match(run.prompt, /The reducer folds deltas into turns/, 'the doc markdown is in the prompt')
      assert.ok(run.prompt.includes(thread.anchor.quote), 'the quoted text is in the prompt')
      assert.ok(run.prompt.includes(thread.messages[0].text), 'the question is in the prompt')
      assert.ok(run.prompt.includes(sourceA) && run.prompt.includes(sourceB), 'the source dirs are in the prompt')
    }

    // The owner sees every Q&A without being woken, and nothing goes out as the old comment task.
    await t.until(() => t.lane.posts().filter((a) => t.lane.flag(a, '--kind') === 'info').length === 3, 'three info posts')
    const posts = t.lane.posts()
    assert.equal(posts.length, 3, 'only the three Q&A info posts; the old comment delivery stays off')
    for (const args of posts) {
      assert.equal(t.lane.flag(args, '--to'), 'w5H:pQA')
      assert.notEqual(t.lane.flag(args, '--wake'), 'now')
      assert.ok(/Q-\d/.test(args.join(' ')) && /Answer for Q-\d/.test(args.join(' ')), 'the post carries the question and the answer')
    }
    assert.ok(!t.h.paneLines().split('\n').some((l) => l.startsWith('agent prompt')), 'nothing typed into the owner tab')
  } finally { await t.h.close() }
})

test('a follow-up in the same thread gets its own answer, with the earlier exchange in the prompt', async () => {
  const t = await boot(explainer('t3-follow'), { STUB_ANSWER_MS: '200' })
  try {
    const first = await t.ask('stream', 'websocket', 'Q-1 which websocket?', 'f-1')
    const id = first.json.thread.id
    await t.until(async () => agentMessages((await t.get()).threads[0]).some((m) => !m.pending), 'first answer')
    const reply = await t.h.request(`/api/scope/t3-follow/threads/${id}/reply`, { method: 'POST', headers: human, body: { text: 'Q-2 and who reconnects it?', client_id: 'f-2' } })
    assert.ok([200, 201].includes(reply.status), reply.text)
    const now = (await t.get()).threads[0]
    assert.equal(agentMessages(now).at(-1).pending, true, 'the follow-up shows Answering… at once')
    await t.until(async () => agentMessages((await t.get()).threads[0]).filter((m) => !m.pending).length === 2, 'second answer')
    const thread = (await t.get()).threads[0]
    assert.deepEqual(thread.messages.map((m) => m.from), ['alex', 'agent', 'alex', 'agent'])
    assert.match(thread.messages[3].text, /^Answer for Q-2/)
    const second = t.answerer.list().find((r) => r.prompt.match(/Q-\d+/g).at(-1) === 'Q-2')
    assert.match(second.prompt, /Answer for Q-1/, 'the thread so far, including the first answer, is in the prompt')
  } finally { await t.h.close() }
})

test('an answer that needs the owner says so in the thread and goes to the owner as a task', async () => {
  const t = await boot(explainer('t3-owner'), { STUB_ANSWER_MS: '100' })
  try {
    await t.ask('tools', 'collapsible row', 'Q-1 should we keep rows forever? DECIDE', 'o-1')
    await t.until(async () => agentMessages((await t.get()).threads[0]).some((m) => !m.pending), 'answer')
    const answer = agentMessages((await t.get()).threads[0])[0]
    assert.equal(answer.needs_owner, true)
    assert.ok(!answer.text.includes('NEEDS_OWNER'), 'the marker line is not shown to Alex')
    await t.until(() => t.lane.posts().length >= 1, 'owner post')
    const post = t.lane.posts()[0]
    assert.equal(t.lane.flag(post, '--kind'), 'task')
    assert.equal(t.lane.flag(post, '--to'), 'w5H:pQA')
  } finally { await t.h.close() }
})

test('a slow answer times out: the thread says it went to the owner, the owner gets a task, and the process is killed', async () => {
  const t = await boot(explainer('t3-slow'), { UNBLOCK_EXPLAINER_TIMEOUT_MS: '700' })
  try {
    await t.ask('stream', 'websocket', 'Q-1 explain everything SLOW', 's-1')
    await t.until(async () => agentMessages((await t.get()).threads[0]).some((m) => !m.pending), 'timeout message')
    const message = agentMessages((await t.get()).threads[0])[0]
    assert.equal(message.text, 'Taking longer: sent to w5H:pQA')
    await t.until(() => t.lane.posts().some((a) => t.lane.flag(a, '--kind') === 'task'), 'handoff task')
    const run = t.answerer.list()[0]
    await t.until(() => { try { process.kill(run.pid, 0); return false } catch { return true } }, 'answerer process gone', 3000)
  } finally { await t.h.close() }
})

test('the concurrency cap queues extra questions but every one shows Answering… at once', async () => {
  const t = await boot(explainer('t3-cap'), { UNBLOCK_EXPLAINER_CONCURRENCY: '2', STUB_ANSWER_MS: '800' })
  try {
    await Promise.all([1, 2, 3].map((n) => t.ask('stream', 'websocket', `Q-${n} question ${n}`, `k-${n}`)))
    for (const thread of (await t.get()).threads) assert.equal(agentMessages(thread)[0]?.pending, true)
    await t.until(async () => (await t.get()).threads.every((th) => agentMessages(th).some((m) => !m.pending)), 'all answered')
    const runs = t.answerer.list().sort((a, b) => a.started - b.started)
    assert.equal(runs.length, 3)
    assert.ok(runs[2].started >= Math.min(runs[0].ended, runs[1].ended), 'the third waited for a free slot')
  } finally { await t.h.close() }
})

test('a plain scope keeps lane delivery and spawns no answerer; the answerer flag turns it on per scope', async () => {
  const plain = { ...explainer('plain-scope'), kind: undefined, sources: undefined }
  const t = await boot(plain)
  try {
    await t.ask('stream', 'websocket', 'Q-1 a normal scoping comment', 'p-1')
    await t.until(() => t.lane.posts().some((a) => t.lane.flag(a, '--kind') === 'task' && a.join(' ').includes('Q-1 a normal scoping comment')), 'old comment delivery')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(t.answerer.list().length, 0, 'no answerer for a scope')
    assert.ok(!agentMessages((await t.get()).threads[0]).length, 'no Answering… on a scope')
    const listed = (await t.h.request('/api/scope', { headers: human })).json
    const rows = Array.isArray(listed) ? listed : listed.scopes
    assert.equal(rows.find((r) => r.slug === 'plain-scope').kind, 'scope')
  } finally { await t.h.close() }

  const off = await boot(explainer('explainer-off', { answerer: 'off' }))
  try {
    await off.ask('stream', 'websocket', 'Q-1 with the answerer off', 'x-1')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(off.answerer.list().length, 0, 'answerer: off wins over the explainer default')
    const listed = (await off.h.request('/api/scope', { headers: human })).json
    const rows = Array.isArray(listed) ? listed : listed.scopes
    assert.equal(rows.find((r) => r.slug === 'explainer-off').kind, 'explainer')
  } finally { await off.h.close() }
})

test('unblock explain new writes an explainer with absolute sources; scope new stays a scope', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'unblock-explain-cli-'))
  const scopes = join(temp, 'scopes')
  mkdirSync(scopes)
  const env = { ...process.env, UNBLOCK_STATE_DIR: join(temp, 'state'), UNBLOCK_CONFIG_DIR: join(temp, 'config'), UNBLOCK_PORT: '9', UNBLOCK_SCOPING_DIR: scopes, UNBLOCK_SECRET_BACKEND: 'env' }
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: dirname(sourceA) })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('close', (status) => resolve({ status, out, err }))
  })
  const relA = sourceA.split('/').at(-1)
  const made = await run(['explain', 'new', 'cc-mods', '--pane', 'w5H:pQA', '--title', 'Claude Code mods', '--sources', relA, sourceB])
  assert.equal(made.status, 0, made.err)
  const scope = JSON.parse(readFileSync(join(scopes, 'cc-mods', 'scope.json'), 'utf8'))
  assert.equal(scope.kind, 'explainer')
  assert.deepEqual(scope.sources, [sourceA, sourceB], 'relative sources resolve to absolute paths')
  assert.equal(scope.title, 'Claude Code mods')
  assert.equal(scope.pane, 'w5H:pQA')
  const missing = await run(['explain', 'new', 'cc-bad', '--pane', 'w5H:pQA', '--sources', join(temp, 'nope')])
  assert.notEqual(missing.status, 0, 'a source dir that does not exist is refused')
  const plain = await run(['scope', 'new', 'just-a-scope', '--pane', 'w5H:pQA'])
  assert.equal(plain.status, 0, plain.err)
  assert.equal(JSON.parse(readFileSync(join(scopes, 'just-a-scope', 'scope.json'), 'utf8')).kind ?? 'scope', 'scope')
})

// Verifier repro (2026-10-03): MCP respawns a daemon on any connection error. A second start that loses the port must
// not touch the live daemon's in-flight answers; only a daemon that actually serves recovers stale "Answering…".
test('a second daemon start that loses the port leaves an in-flight answer alone', async () => {
  // The answer must outlast the second process's daemon import, even on a loaded machine.
  const t = await boot(explainer('t3-squat'), { STUB_ANSWER_MS: '8000' })
  try {
    await t.ask('stream', 'websocket', 'Q-1 which websocket?', 'q-1')
    await t.until(() => t.answerer.list().length === 1, 'answerer started')
    const second = spawn(process.execPath, ['--input-type=module', '-e',
      `const { startDaemon } = await import(${JSON.stringify(join(import.meta.dirname, '..', 'src', 'daemon.js'))}); try { await startDaemon({ port: ${t.h.port} }); console.log('listening') } catch (error) { console.log('lost', error.code) } process.exit(0)`],
      { env: process.env })
    let said = ''
    second.stdout.on('data', (d) => { said += d })
    await new Promise((resolve) => second.on('close', resolve))
    assert.match(said, /lost/, 'the second daemon did not get the port')
    assert.equal(agentMessages((await t.get()).threads[0])[0].pending, true, 'still Answering… after the losing start')
    await t.until(async () => agentMessages((await t.get()).threads[0]).some((m) => !m.pending), 'answer', 15000)
    assert.match(agentMessages((await t.get()).threads[0])[0].text, /^Answer for Q-1/, 'the real answer landed in the thread')
  } finally { await t.h.close() }
})

test('a restart retries in-flight and legacy interrupted answers once, then leaves a twice-interrupted answer alone', async () => {
  const t = await boot(explainer('t3-restart'), { STUB_ANSWER_MS: '1500', UNBLOCK_EXPLAINER_CONCURRENCY: '2', UNBLOCK_EXPLAINER_TIMEOUT_MS: '60000' })
  try {
    await t.ask('stream', 'websocket', 'Q-1 which websocket?', 'q-1')
    await t.until(() => t.answerer.list().length === 1, 'first answer started')
    await t.h.restart()
    await t.until(async () => agentMessages((await t.get()).threads[0]).some((m) => !m.pending), 'retried answer')
    assert.match(agentMessages((await t.get()).threads[0])[0].text, /^Answer for Q-1/)
    assert.equal(t.answerer.list().filter((r) => r.prompt.includes('Q-1')).length, 2, 'the original question was re-asked once')

    await t.ask('tools', 'Tool call', 'Q-2 SLOW', 'q-2')
    await t.until(() => t.answerer.list().some((r) => r.prompt.includes('Q-2')), 'slow answer started')
    const scope = await t.get()
    scope.threads.push({ id: 'T3', anchor: anchorInSection(sections[1], 'websocket'), author: 'alex', kind: 'comment', status: 'open',
      created_at: at, messages: [{ from: 'alex', text: 'Q-3 left over', at }, { from: 'agent', answerer: true, text: 'Interrupted: ask again', at }] })
    t.h.writeScope(scope)
    await t.h.restart()
    await t.until(() => t.answerer.list().filter((r) => r.prompt.includes('Q-2')).length === 2, 'slow answer retried')
    await t.until(async () => agentMessages((await t.get()).threads[2]).some((m) => !m.pending), 'legacy interrupted answer retried')
    assert.match(agentMessages((await t.get()).threads[2])[0].text, /^Answer for Q-3/)
    await t.h.restart()
    const message = agentMessages((await t.get()).threads[1])[0]
    assert.equal(message.text, 'Interrupted: ask again')
    assert.ok(!message.pending && !message.handoff && !message.needs_owner)
    await t.h.restart()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(t.answerer.list().filter((r) => r.prompt.includes('Q-2')).length, 2, 'later restarts do not retry a second interruption')
  } finally { await t.h.close() }
})

test('restart: an old interrupted answer in a thread Alex already got answered is not re-asked', async () => {
  const t = await boot(explainer('t3-probe'))
  try {
    const scope = await t.get()
    scope.threads.push({ id: 'T9', anchor: anchorInSection(sections[1], 'websocket'), author: 'alex', kind: 'comment', status: 'resolved',
      resolution: { decision: 'answered', alex_words: null, by: 'agent', at, confirmed_at: at, revision: 1 },
      created_at: at, messages: [
        { from: 'alex', text: 'Q-7 which websocket?', at },
        { from: 'agent', answerer: true, text: 'Interrupted: ask again', at },
        { from: 'alex', text: 'Q-8 asking again: which websocket?', at: '2026-10-03T21:05:00Z' },
        { from: 'agent', answerer: true, text: 'Answer for Q-8: ws.', at: '2026-10-03T21:05:00Z' }] })
    t.h.writeScope(scope)
    await t.h.restart()
    await new Promise((r) => setTimeout(r, 2500))
    const after = (await t.get()).threads.find((th) => th.id === 'T9')
    assert.equal(t.answerer.list().length, 0, 'no answerer re-run for an already answered thread')
    assert.equal(after.messages[1].text, 'Interrupted: ask again')
    assert.equal(after.messages.length, 4)
  } finally { await t.h.close() }
})
