// Scenario (owner: Opus; implementers make it pass, never edit it):
// A lane rewrites its doc as the final design doc: each open question's
// recommended answer is stated in the text, and the question moves to the
// sentence that carries it (scope edit), with its options listed. Alex's
// threads and history survive; edit never pings the pane; only agents edit.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { human, startScopeHarness } from './scope-harness.js'

const run = promisify(execFile)
const cli = (...args) => run(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { env: process.env })

const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: '2026-09-29T19:00:00Z',
  doc: { sections: [
    { id: 'title', heading: 'Demo scope', body_md: 'A small page to agree the scope.' },
    { id: 'ask', heading: 'What you asked for', body_md: '> "make it wrok on my phone"\n> — Alex, in this tab, 2026-09-29' },
    { id: 'plan', heading: 'The plan', body_md: 'Ship the page. Open question: which screen first? Voice comes last.' },
  ] },
  threads: [
    { id: 'T1', anchor: { section: 'plan', quote: 'Open question: which screen first?', prefix: 'Ship the page. ', suffix: ' Voice comes last.' },
      author: 'agent', kind: 'question', status: 'open', recommendation: 'Phones first', why: 'Most use is on phones.',
      messages: [{ from: 'agent', text: 'Which screen first?', at: '2026-09-29T19:00:00Z' }], created_at: '2026-09-29T19:00:00Z' },
    { id: 'T2', anchor: { section: 'plan', quote: 'Voice comes last', prefix: 'which screen first? ', suffix: '.' },
      author: 'alex', kind: 'comment', status: 'open',
      messages: [{ from: 'alex', text: 'Fine by me.', at: '2026-09-29T19:01:00Z' }], created_at: '2026-09-29T19:01:00Z' },
  ],
}

test('the lane rewrites the doc as final, moves each question to its sentence and lists options', async () => {
  const h = await startScopeHarness(v2)
  const { request, bearer, paneLines } = h
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  try {
    // 1. The doc is rewritten as final: the recommendation is stated, the ask is a clean paraphrase.
    const md = join(process.env.UNBLOCK_SCOPING_DIR, 'final.md')
    writeFileSync(md, '# Demo scope\n\nA small page to agree the scope.\n\n## What you asked for {#ask}\n\nMake it work on your phone.\n\n## The plan {#plan}\n\nShip the page. We build for phones first, then desktop. Voice comes last.\n')
    const doc = await cli('scope', 'doc', 'demo', '--from', md)
    assert.match(doc.stdout, /revision 2/)
    assert.match(doc.stdout, /detached: T1/, 'T1 lost its sentence until it is moved')

    const before = paneLines()
    // 2. Move T1 to the sentence that carries the recommendation, and list its options (recommended first).
    const moved = await cli('scope', 'edit', 'demo', 'T1', '--section', 'plan', '--quote', 'We build for phones first',
      '--option', 'Phones first', '--option', 'Desktop first', '--option', 'Both at once', '--json')
    const t1 = JSON.parse(moved.stdout).thread
    assert.equal(t1.anchor.quote, 'We build for phones first')
    assert.equal(t1.anchor.section, 'plan')
    assert.deepEqual(t1.options, ['Phones first', 'Desktop first', 'Both at once'])
    assert.equal(t1.recommendation, 'Phones first')
    assert.equal(t1.messages.length, 1, 'edit adds no message')
    assert.equal(t1.status, 'open')

    // 3. Alex's comment survives untouched; nothing is detached now.
    const scope = await get()
    assert.equal(scope.revision, 2)
    const t2 = scope.threads.find((t) => t.id === 'T2')
    assert.equal(t2.anchor.quote, 'Voice comes last')
    assert.equal(t2.messages[0].text, 'Fine by me.')
    const threads = await cli('scope', 'threads', 'demo', '--open')
    assert.match(threads.stdout, /T1 open question §The plan "We build for phones first": Which screen first\? \[rec: Phones first\] \[options: Phones first \| Desktop first \| Both at once\]/)

    assert.equal(paneLines(), before, 'edit never reaches the pane (the lane does its own housekeeping)')

    // 4. Options rules: the first option must be the recommendation; 2–5 items; questions only; quote must exist.
    const bad = async (body) => (await request('/api/scope/demo/threads/T1/edit', { method: 'POST', headers: bearer, body })).status
    assert.equal(await bad({ options: ['Desktop first', 'Phones first'] }), 400, 'options[0] must equal the recommendation')
    assert.equal(await bad({ options: ['Phones first'] }), 400, 'at least two options')
    assert.equal(await bad({ options: ['Phones first', 'a', 'b', 'c', 'd', 'e'] }), 400, 'at most five options')
    assert.equal(await bad({ section: 'plan', quote: 'not in the doc' }), 400)
    assert.equal((await request('/api/scope/demo/threads/T2/edit', { method: 'POST', headers: bearer, body: { options: ['x', 'y'] } })).status, 400, 'comments have no options')

    // 5. Only agents edit: Alex's page cannot move or rewrite threads.
    assert.equal((await request('/api/scope/demo/threads/T1/edit', { method: 'POST', headers: human, body: { section: 'plan', quote: 'Ship the page' } })).status, 403)

    // 6. A new option after a No replaces the options (or removes them when none are given).
    assert.equal((await request('/api/scope/demo/threads/T1/reject', { method: 'POST', headers: human, body: { text: 'Too slow.' } })).status, 200)
    await cli('scope', 'reply', 'demo', 'T1', '--rec', 'Desktop first', '--option', 'Desktop first', '--option', 'Phones first', 'Then desktop first.')
    let t = (await get()).threads.find((x) => x.id === 'T1')
    assert.deepEqual(t.options, ['Desktop first', 'Phones first'])
    assert.equal(t.rejected_at, undefined)
    await cli('scope', 'reply', 'demo', 'T1', '--rec', 'Both at once', 'Or both.')
    t = (await get()).threads.find((x) => x.id === 'T1')
    assert.equal(t.options, undefined, 'a new recommendation without options drops the old list')

    // 7. An ask can carry options at once.
    const asked = await cli('scope', 'ask', 'demo', '--section', 'plan', '--quote', 'Voice comes last', '--rec', 'Round two',
      '--option', 'Round two', '--option', 'Cut it', 'When does voice ship?', '--json')
    assert.deepEqual(JSON.parse(asked.stdout).thread.options, ['Round two', 'Cut it'])
  } finally { await h.close() }
})
