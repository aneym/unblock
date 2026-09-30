import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { createScopeVoiceSession } from '../src/scope-voice.js'

function setup() {
  const section = { id: 'plan', heading: 'The plan', body_md: 'Keep the page light.' }
  const thread = { id: 'T1', anchor: anchorInSection(section, 'Keep the page light.'), status: 'open', kind: 'comment', messages: [{ from: 'human', text: 'Keep the page light.' }] }
  const posts = [], feed = []
  const session = createScopeVoiceSession({
    getScope: async () => ({ slug: 'demo', scope: { doc: { sections: [section] }, threads: [thread] } }),
    getContext: () => ({ thread: 'T1', section: 'plan', selection: null }),
    postThread: async (body) => { posts.push({ kind: 'comment', ...body }); return { thread: { id: 'T2' } } },
    postReply: async (id, body) => { posts.push({ kind: 'reply', id, ...body }); return { thread: { id } } },
    onFeed: (line) => feed.push(line),
  })
  return { session, posts, feed }
}

for (const kind of ['comment', 'reply']) {
  test(`${kind} waits for its spoken read-back before a yes can file it`, async () => {
    const { session, posts, feed } = setup()
    session.assistantSaid?.('Ready.')
    await session.handle(kind, { text: 'Keep the page light and fast.' })
    const blocked = await session.handle('confirm')
    assert.equal(posts.length, 0, 'a yes without the read-back must not file')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.speech, `First, the ${kind}: "Keep the page light and fast." ${kind === 'comment' ? 'File it?' : 'Send it?'}`)
    assert.equal(feed.at(-1).write, false)
    session.assistantSaid('On it.')
    assert.equal((await session.handle('confirm')).ok, false, 'unrelated speech is not a read-back')
    session.assistantSaid(blocked.speech)
    assert.equal((await session.handle('confirm')).ok, true)
    assert.deepEqual(posts.map(({ kind, text }) => ({ kind, text })), [{ kind, text: 'Keep the page light and fast.' }])
    await session.handle('confirm')
    assert.equal(posts.length, 1, 'a second yes cannot file twice')
  })

  for (const [text, readback] of [
    ['use_scope_voice', 'Use scope voice.'],
    ['use-scope-voice', 'Use scope voice.'],
    ['https://example.com/spec', 'a link'],
    ['!!!', '!!!'],
  ]) {
    test(`${kind} requires its read-back after unrelated speech: ${text}`, async () => {
      const { session, posts } = setup()
      const prompt = kind === 'comment' ? 'File it?' : 'Send it?'
      session.assistantSaid('Ready.')
      const proposed = await session.handle(kind, { text })
      assert.equal(proposed.ok, true)
      session.assistantSaid('On it.')
      const blocked = await session.handle('confirm')
      assert.equal(blocked.ok, false)
      assert.equal(posts.length, 0)
      assert.equal(blocked.speech, `First, the ${kind}: "${readback}" ${prompt}`)
      session.assistantSaid('Okay.')
      assert.equal((await session.handle('confirm')).ok, false)
      session.assistantSaid(proposed.speech)
      assert.equal((await session.handle('confirm')).ok, true)
      assert.equal(posts.length, 1)
      await session.handle('confirm')
      assert.equal(posts.length, 1, 'a second yes cannot file twice')
    })
  }

  test(`${kind} keeps the legacy confirmation when there is no transcript source`, async () => {
    const { session, posts } = setup()
    await session.handle(kind, { text: 'Keep the page light.' })
    assert.equal((await session.handle('confirm')).ok, true)
    assert.equal(posts.length, 1)
  })
}

test('read-back matching ignores case and punctuation, accepts four words, and resets on a new proposal', async () => {
  const { session, posts } = setup()
  session.assistantSaid?.('KEEP, THE PAGE LIGHT!')
  await session.handle('comment', { text: 'Keep the page light and fast.' })
  assert.equal((await session.handle('confirm')).ok, false, 'speech before the proposal cannot authorize it')
  session.assistantSaid('KEEP, THE PAGE')
  session.assistantSaid('LIGHT!')
  assert.equal((await session.handle('confirm')).ok, true)
  await session.handle('reply', { text: 'Ship soon.' })
  session.assistantSaid('Ship')
  assert.equal((await session.handle('confirm')).ok, false, 'short proposals need their whole text')
  session.assistantSaid('SOON!')
  assert.equal((await session.handle('confirm')).ok, true)
  assert.equal(posts.length, 2)
})
