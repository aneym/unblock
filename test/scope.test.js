import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'
import { docFromMarkdown, docToMarkdown } from '../src/scope-doc.js'

const initial = {
  slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', updated_at: new Date().toISOString(), plan_md: 'Initial plan',
  questions: [{ id: 'Q1', text: 'First?', status: 'open' }, { id: 'Q2', text: 'Second?', status: 'open' }],
}

test('exported markdown retains the lede, figures, tables and stable section ids', () => {
  const doc = { sections: [
    { id: 'title', heading: 'Demo scope', body_md: 'A small page to agree the scope.' },
    { id: 'the-plan', heading: 'The plan', body_md: '```svg\n<svg><text>## Not a heading</text></svg>\n```\n\n| Screen | Order |\n| --- | --- |\n| Phone | First |' },
  ] }
  assert.deepEqual(docFromMarkdown(docToMarkdown(doc)).sections, doc.sections)
})

test('scoping thread changes reach SSE, SQLite and the pane', async () => {
  const h = await startScopeHarness(initial)
  const { request, stream, until, bearer } = h
  try {
    const events = await stream('/api/scope/demo/events')
    const state = await events.next('state')
    assert.equal(state.scope.version, 2)
    assert.equal(state.notes.length, 0)

    const comment = await request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: { section: 'title', quote: 'Demo scope' }, text: 'also think about phones' } })
    assert.equal(comment.status, 201)
    const thought = await events.next('note', (note) => note.event === 'new')
    assert.equal(thought.from, 'alex')
    assert.equal(thought.thread, comment.json.thread.id)
    assert.equal(thought.text, 'also think about phones')
    const answer = await request('/api/scope/demo/threads/T2/resolve', { method: 'POST', headers: human, body: { decision: 'Take the recommendation' } })
    assert.equal(answer.status, 200)
    assert.equal((await events.next('note', (note) => note.event === 'resolve')).text, 'Take the recommendation')
    await until(() => h.paneLines().includes('Alex (general): also think about phones') && h.paneLines().includes('Alex resolved T2'), 'both notes in the pane')
    await events.next('note', (note) => note.id === thought.id && note.delivery === 'delivered')
    await until(async () => {
      const { json } = await request('/api/scope/demo/notes', { headers: bearer })
      return json.notes.length === 2 && json.notes.every((note) => note.delivery === 'delivered')
    }, 'both notes delivered')
    assert.equal((await events.next('scope', (data) => data.scope?.threads.some((t) => t.id === comment.json.thread.id))).scope.version, 2)

    const reply = await request(`/api/scope/demo/threads/${comment.json.thread.id}/reply`, { method: 'POST', headers: bearer, body: { text: 'Noted, moving ahead.' } })
    assert.equal(reply.status, 200)
    const replied = await events.next('scope', (data) => data.scope?.threads.find((t) => t.id === comment.json.thread.id)?.messages.length === 2)
    assert.equal(replied.scope.threads.at(-1).messages.at(-1).from, 'agent')
    assert.equal(replied.notes.length, 2)
    assert.equal((await request('/api/scope/demo/threads', { method: 'POST', headers: bearer, body: { anchor: { section: 'title', quote: 'Demo scope' }, text: 'forged' } })).status, 400)
    const page = await request('/s/demo')
    assert.equal(page.status, 200)
    assert.match(page.text, /__SCOPE_BOOT__/)
    assert.equal((await request('/s', { method: 'POST' })).status, 404)
  } finally { await h.close() }
})

test('a migrated scope without a pane retains its note as no_pane', async () => {
  const h = await startScopeHarness({ ...initial, pane: '' })
  try {
    assert.equal((await h.request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: { section: 'title', quote: 'Demo scope' }, text: 'Keep this thought.' } })).status, 201)
    await h.until(async () => (await h.request('/api/scope/demo/notes', { headers: h.bearer })).json.notes[0]?.delivery === 'no_pane', 'note marked no_pane')
    assert.equal(h.paneLines(), '')
  } finally { await h.close() }
})

test('a failing tag retries independently without redelivering the own-pane note', async () => {
  const h = await startScopeHarness(initial)
  try {
    const stub = process.env.HERDR_BIN_PATH
    const original = readFileSync(stub, 'utf8')
    writeFileSync(stub, original + '\n[ "$3" = "w5H:pBAD" ] && exit 1\nexit 0\n')
    const posted = await h.request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: { section: 'title', quote: 'Demo scope' }, text: 'hey @pBAD look' } })
    assert.equal(posted.status, 201)
    await h.until(() => h.paneLines().split('agent prompt w5H:pBAD ').length >= 4, 'tag retried three times')
    assert.equal(h.paneLines().split('agent prompt w5H:pT1 ').length - 1, 1)
    const note = (await h.request('/api/scope/demo/notes', { headers: h.bearer })).json.notes[0]
    assert.equal(note.delivery, 'delivered')
    assert.ok(note.delivered_at)
  } finally { await h.close() }
})

test('a blank No is accepted and a scope slug takes priority over a pane-shaped tag', async () => {
  const h = await startScopeHarness({ ...initial, questions: [{ id: 'Q1', text: 'First?', recommendation: 'Phones first', status: 'open' }] })
  try {
    const other = join(process.env.UNBLOCK_SCOPING_DIR, 'plan2')
    mkdirSync(other)
    writeFileSync(join(other, 'scope.json'), JSON.stringify({ ...initial, slug: 'plan2', pane: 'w5H:pOTHER' }))
    const rejected = await h.request('/api/scope/demo/threads/T1/reject', { method: 'POST', headers: human, body: { text: ' \n\t ' } })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.json.thread.messages.at(-1).text, '')
    await h.until(() => h.paneLines().includes('no reason given'), 'bare No delivered')
    assert.equal((await h.request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: { section: 'title', quote: 'Demo scope' }, text: '@plan2 look here' } })).status, 201)
    await h.until(() => h.paneLines().includes('agent prompt w5H:pOTHER '), 'scope-tag delivered')
    assert.equal(h.paneLines().includes('agent prompt w5H:plan2 '), false)
  } finally { await h.close() }
})
