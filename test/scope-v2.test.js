// Scenario (owner: Opus; implementers make it pass, never edit it):
// A v1 scope is read as a v2 doc with comments. The lane asks a question
// anchored to a quote (CLI), Alex comments on a selection (pane gets the
// quote), takes the recommendation on the lane's question, the lane rewrites
// the section as a new revision and confirms the resolve. scope.json is now v2,
// written by the daemon, with the v1 copy and the revision snapshot kept.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const run = promisify(execFile)
const cli = (...args) => run(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { env: process.env })

const v1 = {
  slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', updated_at: '2026-09-29T15:00:00Z',
  lede: 'A small page to agree the scope.',
  ask: [{ quote: 'make it work on my phone', source: 'Alex, in this tab', date: '2026-09-29' }],
  plan_md: 'Ship the page. We build phones first, then desktop. Voice comes last.\n\n## Done means\n1. **Phone works.** It opens on a phone.',
  questions: [{ id: 'Q1', text: 'Which screen first?', recommendation: 'Phones first', why: 'Most use is on phones.', status: 'open' }],
  decisions: [{ id: 'D1', decision: 'No tablets in this scope.' }],
  thread: [{ from: 'alex', text: 'Keep it simple.', at: '2026-09-29T15:01:00Z' }, { from: 'agent', text: 'Will do.', at: '2026-09-29T15:02:00Z' }],
}

test('a v1 scope becomes a doc with anchored comments; ask, comment, take the recommendation, rewrite, resolve', async () => {
  const h = await startScopeHarness(v1)
  const { request, until, bearer } = h
  const dir = join(process.env.UNBLOCK_SCOPING_DIR, 'demo')
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  try {
    // 1. Read as v2: title, ask, plan, done-means sections; Q1, D1 and the chat become comments.
    let scope = await get()
    assert.equal(scope.version, 2)
    assert.equal(scope.revision, 1)
    assert.deepEqual(scope.doc.sections.map((s) => s.id), ['title', 'ask', 'plan', 'done-means'])
    assert.equal(scope.doc.sections[0].heading, 'Demo scope')
    assert.match(scope.doc.sections[1].body_md, /make it work on my phone/)
    assert.deepEqual(scope.threads.map((t) => [t.id, t.kind, t.status, t.legacy_id]), [
      ['T1', 'question', 'open', 'Q1'], ['T2', 'question', 'resolved', 'D1'], ['T3', 'comment', 'resolved', 'thread'],
    ])
    assert.equal(scope.threads[0].recommendation, 'Phones first')
    assert.deepEqual(scope.threads[2].messages.map((m) => m.text), ['Keep it simple.', 'Will do.'])

    // 2. The lane asks a question anchored to a quote in the plan, through the CLI.
    const asked = JSON.parse((await cli('scope', 'ask', 'demo', '--section', 'plan', '--quote', 'phones first, then desktop',
      '--rec', 'Phones first', '--why', 'Most use is on phones.', 'Which screen ships first?', '--json')).stdout)
    const t4 = asked.thread
    assert.equal(t4.id, 'T4')
    assert.deepEqual(t4.anchor, { section: 'plan', quote: 'phones first, then desktop', prefix: 'The plan Ship the page. We build', suffix: '. Voice comes last.' })
    assert.equal(t4.kind, 'question')
    assert.equal((await request('/api/scope/demo/threads', { method: 'POST', headers: bearer, body: { section: 'plan', quote: 'not in the plan', text: 'x' } })).status, 400)

    // 3. Alex selects "Voice comes last" and comments: a new comment, delivered with its quote.
    scope = await get()
    const anchor = anchorInSection(scope.doc.sections.find((s) => s.id === 'plan'), 'Voice comes last')
    const posted = await request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor, text: 'Voice can wait for round two.' } })
    assert.equal(posted.status, 201)
    assert.equal(posted.json.thread.id, 'T5')
    assert.equal(posted.json.thread.author, 'alex')
    await until(() => h.paneLines().includes('[scoping demo] Alex on §The plan "Voice comes last": Voice can wait for round two. (new T5) (reply: unblock scope reply demo <T#> "<one line>")'), 'comment in the pane')
    assert.equal((await request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: { section: 'plan', quote: '' }, text: 'x' } })).status, 400)

    // 4. Alex takes the recommendation on T4 ("Take it"): resolved by him at once, and the lane is told to edit the doc.
    const took = await request('/api/scope/demo/threads/T4/resolve', { method: 'POST', headers: human, body: { decision: 'Phones first', alex_words: 'Take the recommendation', how: 'take' } })
    assert.equal(took.status, 200)
    assert.equal(took.json.thread.status, 'resolved')
    assert.equal(took.json.thread.resolution.by, 'alex')
    assert.equal(took.json.thread.resolution.how, 'take')
    await until(() => h.paneLines().includes('Alex took the recommendation on T4 (§The plan "phones first, then desktop"): Phones first. Edit §The plan to say so, then run: unblock scope resolve demo T4'), 'take in the pane')
    assert.equal((await request('/api/scope/demo/threads/T99/resolve', { method: 'POST', headers: human, body: { decision: 'x' } })).status, 404)

    // 5. The lane rewrites the plan as revision 2, then confirms the resolve.
    const sections = scope.doc.sections.map((s) => s.id === 'plan' ? { ...s, body_md: 'Ship the page. Phones first: the page is built for a phone. Voice comes last.' } : s)
    assert.equal((await request('/api/scope/demo/doc', { method: 'PUT', headers: human, body: { sections } })).status, 403)
    assert.equal((await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections: [...sections, sections[0]] } })).status, 400)
    const rewritten = await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections } })
    assert.equal(rewritten.status, 200)
    assert.equal(rewritten.json.revision, 2)
    const confirmed = JSON.parse((await cli('scope', 'resolve', 'demo', 'T4', '--json')).stdout).thread
    assert.equal(confirmed.status, 'resolved')
    assert.equal(confirmed.resolution.decision, 'Phones first')
    assert.ok(confirmed.resolution.confirmed_at)
    assert.equal(confirmed.resolution.revision, 2)

    // 6. The lane replies on T5; agent messages are not sent back to its own pane.
    const before = h.paneLines()
    const replied = JSON.parse((await cli('scope', 'reply', 'demo', 'T5', 'Moved voice to round two.', '--json')).stdout).thread
    assert.deepEqual(replied.messages.map((m) => m.from), ['alex', 'agent'])
    scope = await get()
    assert.equal(scope.revision, 2)
    assert.match(scope.doc.sections.find((s) => s.id === 'plan').body_md, /built for a phone/)
    assert.equal(h.paneLines(), before)

    // 7. On disk: v2 written by the daemon, the v1 copy kept, the revision snapshot saved.
    const disk = JSON.parse(readFileSync(join(dir, 'scope.json'), 'utf8'))
    assert.equal(disk.version, 2)
    assert.equal(disk.threads.length, 5)
    assert.equal(JSON.parse(readFileSync(join(dir, 'scope.v1.json'), 'utf8')).plan_md, v1.plan_md)
    assert.ok(existsSync(join(dir, 'revisions', '2.json')))
    assert.equal((await request('/api/scope', { headers: human })).json.scopes[0].open, 2)
  } finally {
    await h.close()
  }
})

// Scenario (owner: Opus): pushing back is a first-class answer. Alex says No to a
// recommendation (the comment stays open and the lane hears it as a rejection),
// the lane offers a new option on the same comment, Alex answers his own way on
// another question, parks a third, and tags another lane in a comment.
test('No keeps a question open until the lane offers a new option; his own answer, Not now, and @lane tags', async () => {
  const h = await startScopeHarness({ ...v1, questions: [
    { id: 'Q1', text: 'Which screen first?', recommendation: 'Phones first', why: 'Most use is on phones.', status: 'open' },
    { id: 'Q2', text: 'Which runner?', recommendation: 'Use Executor', status: 'open' },
    { id: 'Q3', text: 'Share with Nate?', recommendation: 'Not now', status: 'open' },
  ], decisions: [], thread: [] })
  const { request, until } = h
  const other = join(process.env.UNBLOCK_SCOPING_DIR, 'closer')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'scope.json'), JSON.stringify({ ...v1, slug: 'closer', title: 'Closer', pane: 'w5H:pFP', questions: [], decisions: [], thread: [] }))
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  const thread = async (id) => (await get()).threads.find((t) => t.id === id)
  const tail = ' (reply: unblock scope reply demo <T#> "<one line>")'
  try {
    // 1. No, with a reason: open, rejected, one message of kind reject; the pane says rejected and how to answer.
    const no = await request('/api/scope/demo/threads/T1/reject', { method: 'POST', headers: human, body: { text: 'Desktop is where I read these.' } })
    assert.equal(no.status, 200)
    const t1 = no.json.thread
    assert.equal(t1.status, 'open')
    assert.ok(t1.rejected_at)
    assert.deepEqual(t1.messages.slice(1).map((m) => [m.from, m.kind, m.text]), [['alex', 'reject', 'Desktop is where I read these.']])
    await until(() => h.paneLines().includes('[scoping demo] Alex rejected the recommendation on T1 (§Demo scope "Demo scope"): Desktop is where I read these. Offer a new option: unblock scope reply demo T1 --rec "<new recommendation>" "<one line>"' + tail), 'rejection in the pane')

    // 2. The lane offers a new option on the same comment: the recommendation changes and the rejection clears.
    const option = JSON.parse((await cli('scope', 'reply', 'demo', 'T1', '--rec', 'Desktop first', '--why', 'He reads scopes at his desk.', 'Then desktop first, phone right after.', '--json')).stdout).thread
    assert.equal(option.recommendation, 'Desktop first')
    assert.equal(option.why, 'He reads scopes at his desk.')
    assert.equal(option.rejected_at ?? null, null)
    assert.deepEqual(option.messages.at(-1), { ...option.messages.at(-1), from: 'agent', kind: 'option', recommendation: 'Desktop first', text: 'Then desktop first, phone right after.' })
    assert.equal(option.status, 'open')
    assert.equal((await request('/api/scope/demo/threads/T1/reject', { method: 'POST', headers: human, body: {} })).status, 200)
    await until(() => h.paneLines().includes('[scoping demo] Alex rejected the recommendation on T1 (§Demo scope "Demo scope"), no reason given. Offer a new option: unblock scope reply demo T1 --rec "<new recommendation>" "<one line>"' + tail), 'bare No in the pane')

    // 3. Something else: his own answer resolves it by him, how 'own', and the lane edits the doc.
    const own = await request('/api/scope/demo/threads/T2/resolve', { method: 'POST', headers: human, body: { decision: 'Run it on the PC', alex_words: 'Run it on the PC', how: 'own' } })
    assert.equal(own.json.thread.resolution.how, 'own')
    await until(() => h.paneLines().includes('[scoping demo] Alex answered T2 his own way (§Demo scope "Demo scope"): Run it on the PC. Edit §Demo scope to say so, then run: unblock scope resolve demo T2' + tail), 'own answer in the pane')

    // 4. Not now: parked, out of the open count; a reply from him reopens it.
    const parked = await request('/api/scope/demo/threads/T3/park', { method: 'POST', headers: human, body: {} })
    assert.equal(parked.json.thread.status, 'parked')
    await until(() => h.paneLines().includes('[scoping demo] Alex parked T3 (§Demo scope "Demo scope") for later. No action needed.' + tail), 'park in the pane')
    assert.equal((await request('/api/scope', { headers: human })).json.scopes.find((s) => s.slug === 'demo').open, 1)
    assert.equal((await request('/api/scope/demo/threads/T3/park', { method: 'POST', headers: { Authorization: h.bearer.Authorization } })).status, 403)
    assert.equal((await request('/api/scope/demo/threads/T3/reply', { method: 'POST', headers: human, body: { text: 'Actually, ask me now.' } })).json.thread.status, 'open')

    // 5. Tags: @pHS (a pane in the same workspace) and @closer (another scope's lane) each get a pointer line; demo's own pane gets the comment.
    const anchor = anchorInSection((await get()).doc.sections.find((s) => s.id === 'plan'), 'Voice comes last')
    await request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor, text: '@pHS and @closer: does this block you?' } })
    const pointer = 'Alex tagged you on T4 (§The plan "Voice comes last"): @pHS and @closer: does this block you? Read it: unblock scope comments demo'
    await until(() => h.paneLines().split('\n').some((l) => l.startsWith('agent prompt w5H:pHS ') && l.endsWith(`[scoping demo] ${pointer}`)), 'tag to pHS')
    await until(() => h.paneLines().split('\n').some((l) => l.startsWith('agent prompt w5H:pFP ') && l.endsWith(`[scoping demo] ${pointer}`)), 'tag to closer')
    await until(() => h.paneLines().includes('Alex on §The plan "Voice comes last": @pHS and @closer: does this block you? (new T4)'), 'comment in its own pane')
  } finally {
    await h.close()
  }
})
