import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceSession, voiceDeck, xaiTools, VOICE_TOOLS, VOICE_SYSTEM_PROMPT } from '../src/voice.js'

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
  assert.deepEqual((await voice.handle('ask_preview', args)).ui, { do: 'fill', ticket, values: { choice: 'b', optional: null }, field_context: { choice: 'only on Friday' } })
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
  assert.deepEqual(skipped.ui, { do: 'show_ask', ticket: 'ub_second' })
  const args = { n: 1, answers: [{ field: 'answer', value: 'yes' }] }
  assert.equal((await voice.handle('ask_preview', args)).ok, true)
  const answered = await voice.handle('ask_answer', args)
  assert.match(answered.speech, /Next is number 1, First ask/)
  assert.deepEqual(answered.ui, { do: 'show_ask', ticket: 'ub_first' })
  const sentBack = await voice.handle('ask_send_back', { n: 1, note: 'Wrong question' })
  assert.match(sentBack.speech, /That was the last one/)
  assert.deepEqual(sentBack.ui, { do: 'show_list' })
})

test('navigation focuses the deck, opens screen asks and links, and uses current ask', async () => {
  const first = ask('ub_recruiter', [field('answer', { url: 'https://forms.example.test/answer' })], {
    project: 'Recruiter', title: 'Recruiting choice', links: [
      { url: 'https://forms.example.test/answer', label: 'the form' },
      { url: 'https://docs.example.test/context', label: 'Background notes' },
    ],
  })
  const screen = ask('ub_screen', [field('credential', { type: 'secret' })], { project: 'Recruiter', title: 'Add credential' })
  const other = ask('ub_other', [field('answer')], { project: 'Studio', title: 'Studio choice' })
  const { voice } = session([first, screen, other, ask('ub_done', [field('answer')], { status: 'answered', title: 'Finished ask' })])
  assert.deepEqual((await voice.handle('show_queue', { project: 'recruit' })).ui, { do: 'show_list', project: 'Recruiter' })
  assert.match((await voice.handle('queue_summary', {})).speech, /2 open:.*1 needs the screen/)
  assert.deepEqual((await voice.handle('ask_read', {})).ui, { do: 'show_ask', ticket: first.ticket })
  assert.match((await voice.handle('queue_list', {})).speech, /On screen only: 1, Add credential/)
  const read = await voice.handle('ask_read', { n: 1 })
  assert.deepEqual(read.ui, { do: 'show_ask', ticket: first.ticket })
  assert.match(read.speech, /It has 2 links; say open a link to see them/)
  assert.deepEqual((await voice.handle('open_link', {})).ui, { do: 'open_link', url: first.links[0].url, label: 'the form' })
  for (const which of ['1', 'one', 'first', 'link', 'the link', 'it', 'that', 'this', 'doc', 'page']) {
    const result = await voice.handle('open_link', { which })
    assert.equal(result.ok, true, which)
    assert.deepEqual(result.ui, { do: 'open_link', url: first.links[0].url, label: 'the form' }, which)
  }
  for (const which of ['2', 'two', 'second', 'Background', 'docs.example']) {
    const result = await voice.handle('open_link', { which })
    assert.deepEqual(result.ui, { do: 'open_link', url: first.links[1].url, label: 'Background notes' }, which)
  }
  const ambiguous = await voice.handle('open_link', { which: 'unknown' })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.speech, 'Which one: the form or Background notes?')
  assert.deepEqual((await voice.handle('show_details', { open: false })).ui, { do: 'details', ticket: first.ticket, open: false })
  assert.deepEqual((await voice.handle('show_screen_ask', { n: 1 })).ui, { do: 'show_ask', ticket: screen.ticket })
  assert.match((await voice.handle('show_screen_ask', { n: 1 })).speech, /a credential/)
  for (const name of ['ask_read', 'ask_preview', 'ask_answer']) {
    const result = await voice.handle(name, {})
    assert.equal(result.ok, false, name)
    assert.equal(result.speech, 'That one needs the screen.', name)
    assert.equal(result.ui, undefined, name)
  }
  assert.deepEqual((await voice.handle('show_answered', {})).ui, { do: 'show_answered' })
  assert.match((await voice.handle('show_answered', {})).speech, /Finished ask/)
  assert.deepEqual((await voice.handle('show_queue', { all: true })).ui, { do: 'show_list', all: true })
  assert.match((await voice.handle('queue_list', {})).speech, /Studio choice/)
  assert.match((await voice.handle('show_queue', { project: 'unknown' })).speech, /Projects are/)
  assert.deepEqual((await voice.handle('end_call', {})).ui, { do: 'end_call' })
})

test('shown screen-only asks can be skipped or sent back, but never read or answered', async () => {
  const item = ask('ub_screen', [field('key', { type: 'secret' })])
  const next = ask('ub_next', [field('answer')], { title: 'Next choice' })
  const { posted, voice } = session([item, next])
  await voice.handle('show_screen_ask', { n: 1 })
  const skipped = await voice.handle('ask_skip', {})
  assert.equal(skipped.ok, true)
  assert.deepEqual(skipped.ui, { do: 'show_ask', ticket: next.ticket })
  await voice.handle('show_screen_ask', { n: 1 })
  assert.equal((await voice.handle('ask_read', {})).speech, 'That one needs the screen.')
  const bounced = await voice.handle('ask_send_back', { note: 'Make your own API keys' })
  assert.equal(bounced.ok, true)
  assert.deepEqual(posted, [{ ticket: item.ticket, revision: item.revision, reply: 'Make your own API keys', bounce: true }])
  assert.deepEqual(bounced.ui, { do: 'show_ask', ticket: next.ticket })
})

test('file_issue includes the shown ask and reports no provider or a filing failure', async () => {
  const item = ask('ub_shown', [field('answer')])
  const issues = []
  const voice = createVoiceSession({ getAsks: async () => [item], postAnswer: async () => ({}), fileIssue: async (issue) => { issues.push(issue); return { number: 42, url: 'https://github.com/org/repo/issues/42' } } })
  await voice.handle('ask_read', { n: 1 })
  const result = await voice.handle('file_issue', { title: 'Show dates', details: 'Answered list should show dates', about: 'dashboard' })
  assert.deepEqual(issues, [{ title: 'Show dates', details: 'Answered list should show dates', about: 'dashboard', ticket: item.ticket }])
  assert.equal(result.speech, 'Filed as issue 42.')
  assert.deepEqual(result.ui, { do: 'filed', number: 42, url: 'https://github.com/org/repo/issues/42' })
  assert.equal((await session([item]).voice.handle('file_issue', { title: 'Show dates', details: '', about: 'other' })).speech, "I can't file issues from here.")
  const broken = createVoiceSession({ getAsks: async () => [item], postAnswer: async () => ({}), fileIssue: async () => { throw new Error('private error') } })
  assert.equal((await broken.handle('file_issue', { title: 'Show dates', details: '', about: 'other' })).speech, "That didn't file. Try again.")
})

test('set_speed returns steps and rounded, clamped multipliers only on GPT or Grok', async () => {
  for (const provider of [undefined, 'xai']) {
    const voice = createVoiceSession({ provider, getAsks: async () => [], postAnswer: async () => ({}) })
    for (const [args, ui, speech] of [
      [{ change: 'faster' }, { do: 'speed', change: 'faster' }, 'Okay, faster.'],
      [{ change: 'slower' }, { do: 'speed', change: 'slower' }, 'Okay, slower.'],
      [{ change: 'normal' }, { do: 'speed', change: 'normal' }, 'Back to normal speed.'],
      [{ speed: 1.3 }, { do: 'speed', value: 1.3 }, 'Okay, 1.3 times.'],
      [{ speed: 3 }, { do: 'speed', value: 1.5 }, 'Okay, 1.5 times.'],
      [{ speed: 0.1 }, { do: 'speed', value: 0.7 }, 'Okay, 0.7 times.'],
      [{ speed: 1.234 }, { do: 'speed', value: 1.2 }, 'Okay, 1.2 times.'],
    ]) assert.deepEqual(await voice.handle('set_speed', args), { ok: true, speech, ui })
  }
  const gemini = createVoiceSession({ provider: 'gemini', getAsks: async () => [], postAnswer: async () => ({}) })
  assert.deepEqual(await gemini.handle('set_speed', { change: 'faster' }), {
    ok: false, speech: 'I can only change my speed on GPT or Grok.',
  })
})

test('speech does not double punctuate titles or labels ending in punctuation', async () => {
  const item = ask('ub_punctuation', [field('decision', { label: 'Which fix?', type: 'choice', choices: [{ value: 'yes', label: 'Fix (#2253)?' }] })], { title: 'Fix (#2253)?' })
  const { voice } = session([item])
  assert.doesNotMatch((await voice.handle('ask_read', { n: 1 })).speech, /[?!]\./)
  assert.doesNotMatch((await voice.handle('queue_list', {})).speech, /[?!]\./)
  assert.doesNotMatch((await voice.handle('queue_summary', {})).speech, /[?!]\./)
})

test('one-link asks accept any spoken reference and use singular speech', async () => {
  const item = ask('ub_onlylink', [field('answer')], { links: [{ url: 'https://example.test/read', label: 'Read this' }] })
  const { voice } = session([item])
  assert.match((await voice.handle('ask_read', { n: 1 })).speech, /It has a link; say open the link to see it/)
  for (const which of ['1', 'the link', 'link', 'first', 'unrecognized description']) {
    const result = await voice.handle('open_link', { which })
    assert.equal(result.ok, true, which)
    assert.deepEqual(result.ui, { do: 'open_link', url: item.links[0].url, label: item.links[0].label }, which)
  }
})

test('voice prompt prevents tool announcements and repeated failed calls', () => {
  assert.match(VOICE_SYSTEM_PROMPT, /Never announce that you are about to call a tool; just do it/)
  assert.match(VOICE_SYSTEM_PROMPT, /If a tool fails, say its speech once and wait; never retry the same tool with the same arguments/)
})

test('xAI declarations lowercase nested JSON schema types', () => {
  const converted = xaiTools(VOICE_TOOLS)
  assert.equal(converted[0].type, 'function')
  assert.equal(converted[0].parameters.type, 'object')
  assert.equal(converted.find((tool) => tool.name === 'ask_preview').parameters.properties.answers.items.properties.value.type, 'string')
  assert.equal(VOICE_TOOLS[0].parameters.type, 'OBJECT')
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
