// Owner: Opus (r18, voice filing). Implementers make it pass and never edit it.
// Alex, 2026-09-29, /s/shared-primitives: T5 was filed from half a sentence, and T6-T8 were one point filed three
// times in 3 seconds, once reworded. For every provider, the shared session now files a comment or reply only after
// a read-back and his yes, never from a dangling half sentence, never twice within 10 s, and in his words
// (fillers and stutters out, nothing else changed).
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { createScopeVoiceSession, SCOPE_VOICE_PROMPT, SCOPE_VOICE_TOOLS } from '../src/scope-voice.js'

const section = { id: 'plan', heading: 'The plan', body_md: 'First choice. Second choice.' }
const comment = { id: 'T1', anchor: anchorInSection(section, 'First choice'), status: 'open', kind: 'comment', messages: [{ from: 'alex', text: 'First choice' }] }

function setup(focus = null) {
  let clock = 1_000_000
  const posts = [], feed = []
  const session = createScopeVoiceSession({
    getScope: async () => ({ slug: 'demo', scope: { doc: { sections: [section] }, threads: [comment] } }),
    getContext: () => ({ thread: focus, section: 'plan', selection: null }),
    postThread: async (body) => { posts.push({ kind: 'thread', ...body }); return { thread: { id: `T${9 + posts.length}` } } },
    postReply: async (id, body) => { posts.push({ kind: 'reply', id, ...body }); return { thread: { id } } },
    postLaneNote: async (body) => { posts.push({ kind: 'lane', ...body }); return { ok: true } },
    onFeed: (line) => feed.push(line),
    now: () => clock,
  })
  return { say: (name, args) => session.handle(name, args), posts, feed, tick: (ms) => { clock += ms } }
}

test('a comment is read back in his words and filed only on his yes', async () => {
  const { say, posts, feed } = setup()
  const proposed = await say('comment', { text: 'Um, so we need an agent to to research shared primitives first' })
  assert.equal(proposed.ok, true)
  assert.equal(proposed.speech, 'Comment: "We need an agent to research shared primitives first." File it?')
  assert.equal(posts.length, 0, 'nothing is filed before his yes')
  assert.equal(feed.at(-1).write, false)
  assert.equal(feed.at(-1).label, 'Proposed comment: "We need an agent to research shared primitives first."')
  assert.equal((await say('confirm')).speech, 'Posted.')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].text, 'We need an agent to research shared primitives first.', 'fillers and a stutter out; his words otherwise kept')
  assert.equal(posts[0].via, 'voice')
  assert.equal(feed.at(-1).write, true)
  assert.equal((await say('confirm')).speech, 'Nothing to confirm.', 'one yes files once')
})

test('a no, or a new comment, drops the proposal without filing', async () => {
  const { say, posts } = setup()
  await say('comment', { text: 'Keep the page light.' })
  assert.equal((await say('cancel')).speech, 'Okay, dropped.')
  assert.equal((await say('confirm')).speech, 'Nothing to confirm.')
  await say('comment', { text: 'Keep the page light.' })
  await say('comment', { text: 'Keep the page light and fast.' })
  await say('confirm')
  assert.deepEqual(posts.map((p) => p.text), ['Keep the page light and fast.'], 'the latest proposal replaces the earlier one')
})

test('a half sentence is never proposed or filed', async () => {
  const { say, posts, feed } = setup()
  for (const text of ['Yeah, I think we need to have an agent do research on', 'We should ship the page and', 'The runner is slow because…', 'Pick the one with the']) {
    const out = await say('comment', { text })
    assert.deepEqual(out, { ok: false, speech: 'Go on.' }, text)
    assert.equal(feed.at(-1).label, 'Waiting for the rest')
  }
  assert.equal((await say('confirm')).speech, 'Nothing to confirm.')
  assert.equal(posts.length, 0)
})

test('his words keep hyphenated and plain starts; short complete points are filed (r18 review)', async () => {
  const { say } = setup()
  const kept = {
    'Right-hand column should be sticky': 'Right-hand column should be sticky.',
    'Well-known pattern, keep it': 'Well-known pattern, keep it.',
    'So-called experts are wrong here': 'So-called experts are wrong here.',
    'Uh-oh, the chart is cut off': 'Uh-oh, the chart is cut off.',
    'Right side should be wider': 'Right side should be wider.',
    'Like the old version, keep the header': 'Like the old version, keep the header.',
    'Right, the header stays': 'The header stays.',
    'Like, the header stays': 'The header stays.',
    'Cut this': 'Cut this.',
    'I like that': 'I like that.',
    'What is this?': 'What is this?',
    'Ship it then': 'Ship it then.',
    'I think so': 'I think so.',
    'Keep it as is': 'Keep it as is.',
  }
  for (const [text, want] of Object.entries(kept)) {
    const out = await say('comment', { text })
    assert.equal(out.speech, `Comment: "${want}" File it?`, text)
    await say('cancel')
  }
})

test('the same point within 10 s is not filed again, even reworded; after 10 s it can be', async () => {
  const { say, posts, tick, feed } = setup()
  await say('comment', { text: 'We need an agent to research shared primitives first.' }); await say('confirm')
  tick(3000)
  const again = await say('comment', { text: 'we need an agent to research shared primitives first' })
  assert.deepEqual(again, { ok: true, speech: 'Already on the doc.' })
  assert.equal(feed.at(-1).write, false)
  assert.equal(feed.at(-1).label, 'Already filed: "We need an agent to research shared primitives first."')
  const reworded = await say('comment', { text: 'We need an agent to research the shared primitives first.' })
  assert.deepEqual(reworded, { ok: true, speech: 'Already on the doc.' })
  assert.equal((await say('confirm')).speech, 'Nothing to confirm.')
  assert.equal(posts.length, 1)
  tick(7001)
  assert.match((await say('comment', { text: 'We need an agent to research shared primitives first.' })).speech, /File it\?$/)
  await say('confirm')
  assert.equal(posts.length, 2)
  const different = await say('comment', { text: 'Voice goes last.' })
  assert.match(different.speech, /^Comment: "Voice goes last\." File it\?$/, 'a different point is never caught by the dedupe')
})

test('replies are read back too; lane notes stay quiet but never repeat within 10 s', async () => {
  const { say, posts } = setup('T1')
  assert.equal((await say('reply', { text: 'uh both phones' })).speech, 'Reply: "Both phones." Send it?')
  assert.equal((await say('answer', { text: 'Both phones and tablets' })).speech, 'Reply: "Both phones and tablets." Send it?', 'an answer on a comment comment is a reply')
  assert.equal(posts.length, 0)
  assert.equal((await say('confirm')).speech, 'Sent.')
  assert.deepEqual(posts.map((p) => [p.kind, p.id, p.text]), [['reply', 'T1', 'Both phones and tablets.']])
  assert.equal((await say('note_lane', { text: 'Alex asked what a gate is; the plan should say.' })).speech, 'Noted for the lane.')
  assert.equal((await say('note_lane', { text: 'Alex asked what a gate is; the plan should say.' })).speech, 'Already noted.')
  assert.equal(posts.filter((p) => p.kind === 'lane').length, 1)
  assert.equal((await say('reply', { text: 'Both phones and tablets.' })).speech, 'Already on the doc.')
})

test('the prompt and tool descriptions ask for his words and a read-back', () => {
  assert.match(SCOPE_VOICE_PROMPT, /his own words/i)
  assert.match(SCOPE_VOICE_PROMPT, /never paraphrase/i)
  assert.match(SCOPE_VOICE_PROMPT, /wait until he finishes/i)
  assert.match(SCOPE_VOICE_PROMPT, /Want that as a comment, or just an answer\?/)
  const describe = (name) => SCOPE_VOICE_TOOLS.find((tool) => tool.name === name).description
  for (const name of ['comment', 'reply']) assert.match(describe(name), /his own words/i, name)
  assert.match(describe('confirm'), /yes/i)
})

test('speed changes only on providers that support them (pHG: GPT Live has none)', async () => {
  for (const [provider, ok] of [['xai', true], ['openai', true], ['gemini', false], ['live', false]]) {
    const session = createScopeVoiceSession({
      getScope: async () => ({ slug: 'demo', scope: { doc: { sections: [section] }, threads: [] } }),
      getContext: () => ({ thread: null, section: 'plan', selection: null }),
      getProvider: () => provider,
    })
    const out = await session.handle('set_speed', { change: 'faster' })
    assert.equal(out.ok, ok, provider)
    if (!ok) assert.equal(out.speech, 'I can only change speed on GPT Realtime or Grok.')
  }
})
