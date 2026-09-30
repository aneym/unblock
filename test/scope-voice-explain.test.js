// Owner: Opus (r16, voice asks vs comments). Implementers make it pass and never edit it.
// Alex (2026-09-29 ~20:15 ET): "I WAS ASKING the grok scoping agent to explain a concept to me and it just left a
// comment instead lol". Questions to the voice get a spoken answer grounded in the doc, the scope's BRIEF and what
// Alex said before; only feedback, decisions and answers become comments. When the doc is unclear on a point, the
// voice may leave a quiet note for the lane, which is not Alex's comment. Spec: SPEC-R-voice-explain.md.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { SCOPE_VOICE_PROMPT, SCOPE_VOICE_TOOLS, createScopeVoiceSession } from '../src/scope-voice.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T21:00:00Z'
const sections = [
  { id: 'title', heading: 'Tools scope', body_md: 'How new tools reach a workspace.' },
  { id: 'gate', heading: 'The capability gate', body_md: 'A capability gate holds a new tool until the owner approves it, then releases it to every agent in the workspace.\n\n```demo\nsrc: https://studio.example.ts.net:8797/demo/gate.html\nheight: 480\n```\nFigure: Approving a held tool' },
  { id: 'import', heading: 'The import', body_md: 'Option A keeps the old import. Option B drops it.' },
]
const scope = {
  version: 2, slug: 'demo', title: 'Tools scope', pane: 'w5H:pT1', revision: 1, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: anchorInSection(sections[1], 'holds a new tool'), author: 'agent', kind: 'question', status: 'open', recommendation: 'Owner only', options: ['Owner only', 'Any admin'], why: 'Owners carry the risk.',
      messages: [{ from: 'agent', text: 'Who approves a held tool?', at }], created_at: at },
    { id: 'T3', anchor: anchorInSection(sections[2], 'Option B drops it'), author: 'agent', kind: 'comment', status: 'open',
      messages: [{ from: 'agent', text: 'Keep the import or drop it?', at }], created_at: at },
  ],
}

function session(extra = {}) {
  const calls = []
  const record = (name) => async (...args) => { calls.push([name, ...args]); return { thread: { id: 'T9' } } }
  const deps = {
    getScope: async () => ({ scope }), getContext: () => ({ thread: 'T3', section: 'import', selection: null }),
    postThread: record('postThread'), postReply: record('postReply'), postResolve: record('postResolve'),
    postReject: record('postReject'), postPark: record('postPark'), postLaneNote: record('postLaneNote'),
    fetchContext: async (question) => { calls.push(['fetchContext', question]); return { brief: 'BRIEF: the gate exists so a release never grants tools silently.', said: [{ at_et: '2026-09-28 10:00 ET', text: 'owners approve new tools, not admins', source: 'scope' }] } },
    getProvider: () => 'xai', onFeed: (entry) => calls.push(['feed', entry]),
    ...extra,
  }
  return { voice: createScopeVoiceSession(deps), calls }
}
const writes = (calls) => calls.filter(([name]) => /^post/.test(name))

test('explain answers from the doc, the BRIEF and what Alex said, and never writes', async () => {
  const { voice, calls } = session()
  const out = await voice.handle('explain', { question: 'what is a capability gate' })
  assert.equal(out.ok, true)
  assert.deepEqual(writes(calls), [], 'a question files nothing, even with a comment focused')
  assert.equal(typeof out.context, 'string')
  for (const piece of ['holds a new tool until the owner approves it', 'Approving a held tool', 'Who approves a held tool?', 'Owner only', 'Keep the import or drop it?',
    'BRIEF: the gate exists', 'owners approve new tools, not admins']) assert.ok(out.context.includes(piece), `context carries: ${piece}`)
  assert.ok(!out.context.includes('src: https://'), 'fence bodies stay out; captions stay in')
  assert.ok(out.context.length <= 12000)
  assert.ok(out.speech.split(/\s+/).filter(Boolean).length <= 12, 'the model speaks the answer; the tool adds at most a short lead-in')
  assert.deepEqual(calls.find(([name]) => name === 'fetchContext'), ['fetchContext', 'what is a capability gate'])
  const feed = calls.find(([name]) => name === 'feed')[1]
  assert.equal(feed.tool, 'explain'); assert.equal(feed.write, false); assert.match(feed.label, /capability gate/)
})

test('explain still answers from the doc when the BRIEF and history are slow or fail', async () => {
  for (const fetchContext of [async () => { throw new Error('down') }, () => new Promise((resolve) => setTimeout(() => resolve({ brief: 'late', said: [] }), 10_000))]) {
    const { voice, calls } = session({ fetchContext })
    const started = Date.now()
    const out = await voice.handle('explain', { question: 'why does the gate exist' })
    assert.ok(Date.now() - started < 3000, 'waits at most about 2 s for the extra context')
    assert.equal(out.ok, true)
    assert.ok(out.context.includes('holds a new tool until the owner approves it'))
    assert.deepEqual(writes(calls), [])
  }
})

test('note_lane leaves a quiet note for the lane, not a comment', async () => {
  const { voice, calls } = session()
  const out = await voice.handle('note_lane', { text: 'Alex asked what a capability gate is; the gate section should say who approves.' })
  assert.equal(out.ok, true)
  assert.deepEqual(writes(calls).map(([name]) => name), ['postLaneNote'])
  assert.equal(writes(calls)[0][1].text, 'Alex asked what a capability gate is; the gate section should say who approves.')
  assert.equal((await session().voice.handle('note_lane', { text: '' })).ok, false)
})

test('the prompt and tools put intent first', () => {
  const names = SCOPE_VOICE_TOOLS.map((tool) => tool.name)
  for (const name of ['explain', 'note_lane', 'comment', 'reply', 'answer', 'set_speed']) assert.ok(names.includes(name), name)
  const explain = SCOPE_VOICE_TOOLS.find((tool) => tool.name === 'explain')
  assert.deepEqual(explain.parameters.required, ['question'])
  for (const line of ['Want that as a comment, or just an answer?', "I don't know from the doc"]) assert.ok(SCOPE_VOICE_PROMPT.includes(line), line)
  assert.match(SCOPE_VOICE_PROMPT, /explain/)
  assert.doesNotMatch(SCOPE_VOICE_PROMPT, /Whatever he says while a question is focused is his answer/, 'a focused thread no longer makes every sentence an answer')
  assert.match(SCOPE_VOICE_PROMPT, /set_speed/, 'the speed rule stays')
})

test('the daemon serves the scope BRIEF and Alex\'s earlier words, and takes a lane note', async () => {
  const work = mkdtempSync(join(tmpdir(), 'scope-explain-'))
  const said = join(work, 'alex-said'), saidLog = join(work, 'alex-said.log')
  writeFileSync(said, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${saidLog}'\nprintf '%s' '[{"at_utc":"2026-09-28T14:00:00Z","at_et":"2026-09-28 10:00 ET","source":"scope","text":"owners approve new tools, not admins","link":"/x","ref":"/x"}]'\n`)
  chmodSync(said, 0o755)
  process.env.UNBLOCK_ALEX_SAID = said
  const h = await startScopeHarness(scope)
  const { request, bearer } = h
  try {
    const dir = join(process.env.UNBLOCK_SCOPING_DIR, 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'BRIEF.md'), '# Brief\n\nThe gate exists so a release never grants tools silently.\n')
    const q = encodeURIComponent('capability gate $(touch pwned)')
    const got = await request(`/api/scope/demo/context?q=${q}`, { headers: human })
    assert.equal(got.status, 200, got.text)
    assert.match(got.json.brief, /never grants tools silently/)
    assert.deepEqual(got.json.said.map((s) => s.text), ['owners approve new tools, not admins'])
    const args = readFileSync(saidLog, 'utf8')
    assert.match(args, /capability/); assert.match(args, /--json/)
    assert.ok(!existsSync(join(process.cwd(), 'pwned')) && !existsSync(join(work, 'pwned')), 'the question is never run by a shell')
    assert.equal((await request('/api/scope/demo/context?q=gate', { headers: {} })).status >= 400, true, 'strangers get nothing')
    const none = await request('/api/scope/nope/context?q=gate', { headers: human })
    assert.equal(none.status, 404)

    const before = (await request('/api/scope/demo', { headers: human })).json.scope.threads.length
    const note = await request('/api/scope/demo/lane-note', { method: 'POST', headers: human, body: { text: 'Alex asked what a capability gate is; the gate section should say who approves.', via: 'voice' } })
    assert.equal(note.status, 200, note.text)
    assert.equal((await request('/api/scope/demo', { headers: human })).json.scope.threads.length, before, 'no thread is created')
    const deadline = Date.now() + 5000
    while (!h.paneLines().includes('the gate section should say who approves') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(h.paneLines().includes('the gate section should say who approves'), 'the lane pane hears the note')
    assert.equal((await request('/api/scope/demo/lane-note', { method: 'POST', headers: human, body: { text: '' } })).status, 400)
    assert.equal((await request('/api/scope/demo/lane-note', { method: 'POST', headers: bearer, body: { text: 'x' } })).status, 403, 'only Alex\'s page leaves lane notes')
  } finally { await h.close(); delete process.env.UNBLOCK_ALEX_SAID }
})
