import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceSession, voiceDeck } from '../src/voice.js'

const field = (name, extra = {}) => ({ name, label: name, type: 'text', required: true, ...extra })
const ask = (ticket, fields, extra = {}) => ({
  ticket, revision: 2, project: 'studio', title: 'Choose next action', why: 'Continue safely.',
  status: 'open', purpose: 'decision', created_at: '2026-09-29T00:00:00Z', fields, ...extra,
})

function session(asks) {
  const posted = []
  return { posted, voice: createVoiceSession({ getAsks: async () => asks, postAnswer: async (body) => { posted.push(body); return { complete: true } } }) }
}

test('deck sorts and sends approvals, unanswered secrets and pastes to the screen', () => {
  const items = [
    ask('ub_paste', [field('paste', { type: 'paste' })]),
    ask('ub_voice', [field('answer')], { gating: true }),
    ask('ub_approval', [field('verdict')], { purpose: 'message' }),
    ask('ub_secret', [field('secret', { type: 'secret' })]),
    ask('ub_answered', [field('secret', { type: 'secret' })], { answers: { secret: 'stored' } }),
  ]
  const deck = voiceDeck(items)
  assert.deepEqual(deck.voice.map((item) => item.ticket), ['ub_voice', 'ub_answered'])
  assert.deepEqual(deck.screen.map(({ reason }) => reason), ['paste', 'approval', 'secret'])
})

test('preview guards the exact panel payload and a changed or absent preview never posts', async () => {
  const ticket = 'ub_abc123'
  const item = ask(ticket, [field('choice', { type: 'choice', choices: [{ value: 'a', label: 'First' }, { value: 'b', label: 'Second' }] }), field('optional', { required: false })])
  const { posted, voice } = session([item])
  const args = { n: 1, answers: [{ field: '1', value: 'two', context: 'only on Friday' }] }
  assert.equal((await voice.handle('ask_answer', args)).ok, false)
  assert.equal((await voice.handle('ask_preview', args)).ok, true)
  assert.equal((await voice.handle('ask_answer', { n: 1, answers: [{ field: '1', value: 'one' }] })).ok, false)
  assert.equal(posted.length, 0)
  const sent = await voice.handle('ask_answer', args)
  assert.equal(sent.changed, true)
  assert.deepEqual(posted, [{ ticket, revision: 2, values: { choice: 'b', optional: null }, reply: '', field_context: { choice: 'only on Friday' }, field_bounce: {} }])
})

test('a failed re-preview invalidates the earlier successful preview', async () => {
  const { posted, voice } = session([ask('ub_preview', [field('answer')])])
  const first = { n: 1, answers: [{ field: 'answer', value: 'safe choice' }] }
  assert.equal((await voice.handle('ask_preview', first)).ok, true)
  assert.equal((await voice.handle('ask_preview', { n: 1, answers: [{ field: 'answer', value: '' }] })).ok, false)
  assert.equal((await voice.handle('ask_answer', first)).ok, false)
  assert.equal(posted.length, 0)
})

test('successful transitions announce the next fresh position', async () => {
  const items = [ask('ub_first', [field('answer')], { title: 'First ask' }), ask('ub_second', [field('answer')], { title: 'Second ask', created_at: '2026-09-29T01:00:00Z' })]
  const { voice } = session(items)
  const skipped = await voice.handle('ask_skip', { n: 1 })
  assert.match(skipped.speech, /Next is number 1, Second ask/)
  const args = { n: 1, answers: [{ field: 'answer', value: 'yes' }] }
  assert.equal((await voice.handle('ask_preview', args)).ok, true)
  const answered = await voice.handle('ask_answer', args)
  assert.match(answered.speech, /Next is number 1, First ask/)
  const sentBack = await voice.handle('ask_send_back', { n: 1, note: 'Wrong question' })
  assert.match(sentBack.speech, /That was the last one/)
})

test('accept all cannot decide a must_decide field and no answer is posted', async () => {
  const { posted, voice } = session([ask('ub_choice', [field('human', { must_decide: true, recommend: { value: 'guess' } }), field('other', { recommend: { value: 'safe' } })])])
  const result = await voice.handle('ask_preview', { n: 1, accept_all_recommended: true })
  assert.equal(result.ok, false)
  assert.match(result.speech, /human/)
  assert.equal((await voice.handle('ask_answer', { n: 1, accept_all_recommended: true })).ok, false)
  assert.equal(posted.length, 0)
})

test('stale revision is explained without leaking ticket IDs or URLs into speech', async () => {
  const item = ask('ub_do_not_say', [field('answer')], { title: 'Read https://example.com/secret then ub_do_not_say', why: 'See studio.tailf266ac.ts.net:8799/review.html' })
  const voice = createVoiceSession({ getAsks: async () => [item], postAnswer: async () => { const error = new Error('private upstream body'); error.code = 'STALE_REVISION'; throw error } })
  const args = { n: 1, answers: [{ field: 'answer', value: 'done' }] }
  for (const [name, options] of [['queue_summary', {}], ['queue_list', {}], ['ask_read', { n: 1 }], ['ask_preview', args], ['ask_answer', args]]) {
    const result = await voice.handle(name, options)
    assert.doesNotMatch(result.speech, /ub_do_not_say|https?:\/\/|studio\.tailf266ac\.ts\.net/)
    if (name === 'ask_answer') assert.equal(result.speech, 'The agent changed that one. Read it again.')
  }
})
