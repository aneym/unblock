import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { createScopeVoiceSession } from '../src/scope-voice.js'

const section = { id: 'plan', heading: 'The plan', body_md: 'First choice. Second choice.' }
const makeThread = (id, quote, status, kind = 'question') => ({
  id, anchor: anchorInSection(section, quote), status, kind,
  messages: [{ from: 'agent', text: quote }],
})
const scopeWith = (threads) => ({ doc: { sections: [section] }, threads })

test('speech preserves ordinary words and file names while hiding links', async () => {
  const thread = makeThread('T1', 'First choice', 'open')
  thread.messages[0].text = 'Should the lane reply or answer using Next.js and file.md? See https://x.com/a'
  const session = createScopeVoiceSession({
    getScope: async () => ({ slug: 'demo', scope: scopeWith([thread]) }),
    getContext: () => ({ thread: 'T1', section: 'plan', selection: null }),
  })
  assert.equal((await session.handle('confirm')).speech, 'Nothing to confirm.')
  assert.equal((await session.handle('answer', { text: 'We should reply to every candidate and park the rest' })).speech,
    'Resolve this as: We should reply to every candidate and park… Yes?')
  assert.equal((await session.handle('read_thread')).speech,
    'Should the lane reply or answer using Next.js and file.md? See a link.')
})

test('parked questions explain why they cannot take an answer or park again', async () => {
  const scope = scopeWith([makeThread('T1', 'First choice', 'parked')])
  const session = createScopeVoiceSession({
    getScope: async () => ({ slug: 'demo', scope }),
    getContext: () => ({ thread: 'T1', section: 'plan', selection: null }),
  })
  for (const [name, args] of [['answer', { text: 'Do this' }], ['resolve', { decision: 'Do this' }]]) {
    assert.deepEqual(await session.handle(name, args), { ok: false, speech: 'That one is parked for later.' })
  }
  assert.deepEqual(await session.handle('park'), { ok: false, speech: 'No open question here.' })
})

test('stepping from a resolved or parked thread follows its doc position', async () => {
  for (const status of ['resolved', 'parked']) {
    const scope = scopeWith([makeThread('T1', 'First choice', status), makeThread('T2', 'Second choice', 'open')])
    const session = createScopeVoiceSession({
      getScope: async () => ({ slug: 'demo', scope }),
      getContext: () => ({ thread: 'T1', section: 'plan', selection: null }),
    })
    assert.deepEqual((await session.handle('next_question')).ui, { do: 'focus_thread', thread: 'T2' })
    assert.deepEqual(await session.handle('previous_question'), { ok: false, speech: "That's the first open one." })
  }
})

test('an explicit decision on a comment waits for confirmation and then resolves it', async () => {
  const thread = makeThread('T1', 'First choice', 'open', 'comment')
  const scope = scopeWith([thread])
  const posts = []
  const session = createScopeVoiceSession({
    getScope: async () => ({ slug: 'demo', scope }),
    getContext: () => ({ thread: 'T1', section: 'plan', selection: null }),
    postReply: async () => { assert.fail('a decision must not be sent as a reply') },
    postResolve: async (id, body) => { posts.push({ id, body }); thread.status = 'resolved'; return { thread } },
  })
  assert.equal((await session.handle('resolve', { decision: 'Done, shipped' })).speech, 'Resolve this as: Done, shipped. Yes?')
  assert.equal(thread.status, 'open')
  assert.deepEqual(posts, [])
  assert.equal((await session.handle('confirm')).speech, 'Resolved.')
  assert.equal(thread.status, 'resolved')
  assert.deepEqual(posts, [{ id: 'T1', body: { decision: 'Done, shipped', alex_words: 'Done, shipped', how: 'resolve', via: 'voice' } }])
})
