// Scenario (owner: Opus; implementers make it pass, never edit it):
// Alex watches what the page voice does (2026-09-29: "want to see live tool
// call feed and more visibility into what's going on"). Every tool call yields
// one feed line for the page's activity strip: what it did, on which thread,
// whether it posted, and whether it failed. He can also change how fast it
// talks ("talk faster", "go 1.3"); speed works only on Grok, and asking for
// it never drops a pending confirm.
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { createScopeVoiceSession, SCOPE_VOICE_PROMPT, SCOPE_VOICE_TOOLS } from '../src/scope-voice.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T15:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first. Then the voice.' },
  { id: 'risks', heading: 'Risks', body_md: 'The runner may be slow. Voice may slip.' },
]
const on = (id, quote) => anchorInSection(sections.find((s) => s.id === id), quote)
const message = (from, text) => ({ from, text, at })
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: on('plan', 'We build the page first'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Page first', why: 'Voice needs the page.', messages: [message('agent', 'Page or voice first?')], created_at: at },
    { id: 'T2', anchor: on('risks', 'The runner may be slow'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Use Executor', messages: [message('agent', 'Which runner?')], created_at: at },
    { id: 'T4', anchor: on('title', 'Demo scope'), author: 'alex', kind: 'comment', status: 'open', messages: [message('alex', 'Looks good.')], created_at: at },
    { id: 'T5', anchor: on('risks', 'Voice may slip'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Voice in round two', messages: [message('agent', 'When does voice ship?')], created_at: at },
  ],
}

test('every voice tool call becomes one feed line; speed is Grok-only and keeps a pending confirm', async () => {
  const h = await startScopeHarness(v2)
  const { request } = h
  const call = async (path, body) => {
    const res = await request(path, { method: 'POST', headers: human, body })
    if (res.status >= 300) throw new Error(res.json?.error || `HTTP ${res.status}`)
    return res.json
  }
  const context = { thread: 'T1', section: 'plan', selection: null }
  let provider = 'xai'
  const feed = []
  const deps = {
    getScope: async () => ({ slug: 'demo', scope: (await request('/api/scope/demo', { headers: human })).json.scope }),
    getContext: () => ({ ...context }),
    postThread: (body) => call('/api/scope/demo/threads', body),
    postReply: (id, body) => call(`/api/scope/demo/threads/${id}/reply`, body),
    postResolve: (id, body) => call(`/api/scope/demo/threads/${id}/resolve`, body),
    postReject: (id, body) => call(`/api/scope/demo/threads/${id}/reject`, body),
    postPark: (id, body) => call(`/api/scope/demo/threads/${id}/park`, body),
    onFeed: (line) => feed.push(line),
    getProvider: () => provider,
  }
  const session = createScopeVoiceSession(deps)
  // The page applies ui the way the real page does: focus follows it.
  const say = async (name, args = {}) => {
    const before = feed.length
    const result = await session.handle(name, args)
    if (result.ui?.do === 'focus_thread') context.thread = result.ui.thread
    if (result.ui?.do === 'focus_section') context.section = result.ui.section
    assert.equal(feed.length, before + 1, `${name} emits exactly one feed line`)
    const line = feed.at(-1)
    assert.equal(line.tool, name)
    assert.equal(line.ok, result.ok, `${name} feed ok matches the result`)
    return { result, line }
  }
  const expect = async (name, args, label, { write = false, thread, ok = true } = {}) => {
    const { result, line } = await say(name, args)
    assert.equal(line.label, label, `${name} label`)
    assert.equal(line.write, write, `${name} write`)
    assert.equal(line.thread, thread, `${name} thread`)
    assert.equal(line.ok, ok, `${name} ok`)
    return result
  }
  try {
    // 1. Navigation lines name the thread or the section; nothing is written.
    await expect('next_question', {}, 'Next question: T2', { thread: 'T2' })
    await expect('previous_question', {}, 'Previous question: T1', { thread: 'T1' })
    await expect('read_thread', {}, 'Read T1 aloud', { thread: 'T1' })
    await expect('go_to_section', { name: 'risks' }, 'Went to §Risks')
    await expect('previous_section', {}, 'Went to §The plan')
    await expect('show_resolved', { on: true }, 'Showing resolved')
    await expect('show_resolved', { on: false }, 'Hiding resolved')
    await expect('scroll', { direction: 'down' }, 'Scrolled down')

    // 2. A proposal is not a write; a cancel drops it; the confirm posts and is a write.
    await expect('answer', { text: 'Use the warm runner we already have' }, 'Proposed for T1: "Use the warm runner we already have"', { thread: 'T1' })
    await expect('cancel', {}, 'Dropped the proposal', { thread: 'T1' })
    await expect('answer', { text: 'I would rather ship the page and the voice together this round' }, 'Proposed for T1: "I would rather ship the page and the voice together…"', { thread: 'T1' })

    // 3. Speed between the proposal and his yes: Grok gets it, and the proposal survives.
    const faster = await expect('set_speed', { change: 'faster' }, 'Faster')
    assert.deepEqual(faster.ui, { do: 'speed', change: 'faster' })
    const exact = await expect('set_speed', { speed: 1.34 }, 'Speed 1.3×')
    assert.deepEqual(exact.ui, { do: 'speed', value: 1.3 })
    assert.deepEqual((await expect('set_speed', { speed: 3 }, 'Speed 1.5×')).ui, { do: 'speed', value: 1.5 })
    assert.deepEqual((await expect('set_speed', { speed: 0.2 }, 'Speed 0.7×')).ui, { do: 'speed', value: 0.7 })
    await expect('set_speed', { change: 'slower' }, 'Slower')
    await expect('set_speed', { change: 'normal' }, 'Normal speed')
    const nonsense = await expect('set_speed', {}, 'Not done: Say faster, slower, or a number.', { ok: false })
    assert.equal(nonsense.ui, undefined)
    // (a failed set_speed also keeps the proposal)
    await expect('confirm', {}, 'Resolved T1: "I would rather ship the page and the voice together…"', { write: true, thread: 'T1' })
    const t1 = (await deps.getScope()).scope.threads.find((t) => t.id === 'T1')
    assert.equal(t1.status, 'resolved')
    assert.equal(t1.resolution.decision, 'I would rather ship the page and the voice together this round')

    // 4. Gemini has no speed: the tool says so, no ui, and the line reads as not done.
    provider = 'gemini'
    const gem = await expect('set_speed', { change: 'faster' }, 'Not done: I can only change speed on Grok.', { ok: false })
    assert.equal(gem.ui, undefined)
    provider = 'xai'

    // 5. Writes on questions: take, No (with a long reason cut to 10 words), Not now.
    context.thread = 'T2'
    await expect('take_recommendation', {}, 'Took the recommendation on T2', { write: true, thread: 'T2' })
    context.thread = 'T5'
    await expect('reject', { reason: 'I really do not like this plan because voice must ship with the page' },
      'Said No on T5: "I really do not like this plan because voice must…"', { write: true, thread: 'T5' })
    await expect('park', {}, 'Parked T5', { write: true, thread: 'T5' })

    // 6. A comment: his words are a reply; a bare resolve closes it at once.
    context.thread = 'T4'
    await expect('answer', { text: 'Thanks' }, 'Replied on T4', { write: true, thread: 'T4' })
    await expect('resolve', {}, 'Resolved T4', { write: true, thread: 'T4' })

    // 7. A new comment names its section and its new thread; a reply names the thread.
    context.thread = null
    context.section = 'risks'
    const commented = await say('comment', { text: 'Add a phone check' })
    const created = (await deps.getScope()).scope.threads.at(-1)
    assert.equal(commented.line.label, `Commented on §Risks (${created.id})`)
    assert.equal(commented.line.write, true)
    assert.equal(commented.line.thread, created.id)
    context.thread = created.id
    await expect('reply', { text: 'Both phones' }, `Replied on ${created.id}`, { write: true, thread: created.id })

    // 8. A failure is a line too, with the spoken reason, never a write.
    await expect('confirm', {}, 'Not done: Nothing to confirm.', { ok: false })
    await expect('end_call', {}, 'Ended the call')

    // 9. A throwing onFeed never breaks the call.
    const quiet = createScopeVoiceSession({ ...deps, onFeed: () => { throw new Error('page gone') } })
    context.thread = 'T1'
    const fine = await quiet.handle('scroll', { direction: 'up' })
    assert.equal(fine.ok, true)

    // 10. The model knows the speed tool, and the prompt maps "faster"/"slower" to it.
    assert.ok(SCOPE_VOICE_TOOLS.some((tool) => tool.name === 'set_speed'))
    assert.match(SCOPE_VOICE_PROMPT, /set_speed/)
    // Feed text never reaches the model: only { ok, speech } is sent back (voice-live contract), so no speech carries ids.
    for (const line of feed) assert.equal(typeof line.label, 'string')
  } finally { await h.close() }
})
