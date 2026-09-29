import assert from 'node:assert/strict'
import test from 'node:test'
import { human, startScopeHarness } from './scope-harness.js'

const initial = {
  slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', updated_at: new Date().toISOString(), plan_md: 'Initial plan',
  questions: [{ id: 'Q1', text: 'First?', status: 'open' }, { id: 'Q2', text: 'Second?', status: 'open' }],
}

test('scoping notes reach the pane, stream, SQLite and CLI reply path', async () => {
  const h = await startScopeHarness(initial)
  const { request, stream, until, bearer } = h
  try {
    const events = await stream('/api/scope/demo/events')
    const state = await events.next('state')
    assert.equal(state.scope.plan_md, 'Initial plan')
    assert.equal(state.notes.length, 0)

    const answer = await request('/api/scope/demo/note', { method: 'POST', headers: human, body: { qid: 'Q2', text: 'take the recommendation' } })
    assert.equal(answer.status, 201)
    assert.equal(answer.json.note.from, 'alex')
    const thought = await request('/api/scope/demo/note', { method: 'POST', headers: human, body: { text: 'also think about phones' } })
    assert.equal(thought.status, 201)
    assert.equal((await events.next('note', (note) => note.id === answer.json.note.id)).text, 'take the recommendation')
    assert.equal((await events.next('note', (note) => note.id === thought.json.note.id)).text, 'also think about phones')
    await until(() => {
      const log = h.paneLines()
      return log.includes('agent prompt w5H:pT1 [scoping demo] Alex on Q2: take the recommendation') && log.includes('also think about phones')
    }, 'both notes in the pane')
    await events.next('note', (note) => note.id === thought.json.note.id && note.delivery === 'delivered')
    await until(async () => {
      const { json } = await request('/api/scope/demo/notes', { headers: bearer })
      return json.notes.length === 2 && json.notes.every((note) => note.delivery === 'delivered')
    }, 'both notes delivered')

    h.writeScope({ ...initial, plan_md: 'Updated plan', questions: [initial.questions[0], { ...initial.questions[1], status: 'answered' }] })
    assert.equal((await events.next('scope', (data) => data.scope?.plan_md === 'Updated plan')).scope.questions[1].status, 'answered')

    const reply = await request('/api/scope/demo/reply', { method: 'POST', headers: bearer, body: { text: 'Noted, moving ahead.' } })
    assert.equal(reply.status, 201)
    assert.equal((await events.next('note', (note) => note.id === reply.json.note.id)).from, 'agent')
    assert.equal((await request('/api/scope/demo/note', { method: 'POST', headers: bearer, body: { text: 'forged' } })).status, 403)
    assert.equal((await request('/api/scope/demo/note', { method: 'POST', headers: human, body: { qid: 'Q9', text: 'invalid' } })).status, 400)
    const page = await request('/s/demo')
    assert.equal(page.status, 200)
    assert.match(page.text, /__SCOPE_BOOT__/)
    assert.equal((await request('/s', { method: 'POST' })).status, 404)
  } finally {
    await h.close()
  }
})
