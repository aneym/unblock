// Scenario (owner: Opus; implementers make it pass, never edit it):
// Alex selects text in the plan and comments; the lane's pane gets the comment
// with its quote; the lane rewrites the plan and the anchor is found again; the
// lane replies under it; then, by voice, "on this" anchors to what's on screen
// and "take the recommendation" answers a question, both through the same path.
import assert from 'node:assert/strict'
import test from 'node:test'
import { locateAnchor, makeAnchor } from '../src/scope-anchor.js'
import { createScopeVoiceSession } from '../src/scope-voice.js'
import { human, startScopeHarness } from './scope-harness.js'

const plan = 'Ship the page. We build phones first, then desktop. Voice comes last.'
const initial = {
  slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', updated_at: new Date().toISOString(), plan_md: plan,
  questions: [
    { id: 'Q1', text: 'Which screen first?', recommendation: 'Phones first', status: 'open' },
    { id: 'Q2', text: 'Who signs off?', status: 'open' },
  ],
}

test('an anchored comment keeps its quote from the page to the pane, across a rewrite, and by voice', async () => {
  const h = await startScopeHarness(initial)
  const { request, until, bearer } = h
  try {
    // 1. Alex selects "phones first, then desktop" in the rendered plan and comments.
    const start = plan.indexOf('phones first')
    const anchor = makeAnchor('plan', plan, start, start + 'phones first, then desktop'.length)
    assert.deepEqual(anchor, { section: 'plan', quote: 'phones first, then desktop', prefix: 'Ship the page. We build', suffix: '. Voice comes last.' })
    const posted = await request('/api/scope/demo/note', { method: 'POST', headers: human, body: { text: 'Desktop first, actually.', anchor } })
    assert.equal(posted.status, 201)
    const id = posted.json.note.id
    assert.deepEqual(posted.json.note.anchor, anchor)
    await until(() => h.paneLines().includes(`agent prompt w5H:pT1 [scoping demo] Alex on the plan "phones first, then desktop": Desktop first, actually. (#${id})`), 'quoted comment in the pane')

    // 2. The lane rewrites the plan: the sentence moves, wraps and gains a double space.
    const rewritten = 'Voice comes last.\n\nWe build phones  first,\nthen desktop. Ship the page.'
    h.writeScope({ ...initial, plan_md: rewritten })
    await until(async () => (await request('/api/scope/demo', { headers: human })).json.scope.plan_md === rewritten, 'rewrite visible')
    const stored = (await request('/api/scope/demo', { headers: human })).json.notes.find((note) => note.id === id)
    assert.deepEqual(stored.anchor, anchor)
    const found = locateAnchor(rewritten, stored.anchor)
    assert.equal(found.exact, true)
    assert.equal(rewritten.slice(found.start, found.end), 'phones  first,\nthen desktop')
    assert.equal(locateAnchor('Voice comes last. Tablets only.', stored.anchor), null)

    // 3. The lane replies under the comment; a reply to a note that isn't Alex's in this scope is refused.
    const reply = await request('/api/scope/demo/reply', { method: 'POST', headers: bearer, body: { text: 'Switched to desktop first.', to: id } })
    assert.equal(reply.status, 201)
    assert.equal(reply.json.note.reply_to, id)
    assert.equal((await request('/api/scope/demo/reply', { method: 'POST', headers: bearer, body: { text: 'x', to: reply.json.note.id } })).status, 400)
    assert.equal((await request('/api/scope/demo/note', { method: 'POST', headers: human, body: { text: 'x', anchor: { section: 'sidebar', quote: 'x' } } })).status, 400)

    // 4. By voice (the model's tool calls stubbed): "on this" while Q2 is in view, then "take the recommendation" on Q1.
    const voice = createScopeVoiceSession({
      getScope: async () => (await request('/api/scope/demo', { headers: human })).json,
      postNote: async (body) => {
        const result = await request('/api/scope/demo/note', { method: 'POST', headers: human, body })
        if (result.status !== 201) throw new Error(result.json?.error || `HTTP ${result.status}`)
        return result.json
      },
      getContext: () => ({ selection: null, inView: makeAnchor('q:Q2', 'Who signs off?', 0, 14) }),
    })
    const said = await voice.handle('comment', { text: 'Ask Noah about this one.', on: 'this' })
    assert.equal(said.ok, true)
    await until(() => /\[scoping demo\] Alex \(by voice\) on Q2 "Who signs off\?": Ask Noah about this one\. \(#\d+\)/.test(h.paneLines()), 'voice comment in the pane')
    const answered = await voice.handle('answer_question', { q: 'Q1', take_recommendation: true })
    assert.equal(answered.ok, true)
    await until(() => /Alex \(by voice\) on Q1: Take the recommendation: Phones first \(#\d+\)/.test(h.paneLines()), 'voice answer in the pane')
    const notes = (await request('/api/scope/demo/notes', { headers: bearer })).json.notes
    const spoken = notes.filter((note) => note.via === 'voice')
    assert.deepEqual(spoken.map((note) => [note.kind, note.qid, note.anchor?.section ?? null]), [['thought', null, 'q:Q2'], ['answer', 'Q1', null]])
  } finally {
    await h.close()
  }
})
