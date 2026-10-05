// Scenario (owner: Opus; implementers make it pass, never edit it):
// Voice on a scoping doc is a quiet router. It opens with "Ready." and no
// overview. "Next question" focuses the next open comment; his answer comes
// back as a one-line confirm; his yes resolves it through the daemon and the
// lane's pane hears it as his own answer. "No" rejects a recommendation without
// resolving it; "not now" parks one. Section navigation, a comment on the
// focused section, taking a recommendation. Every non-read turn is 12 words or fewer.
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { createScopeVoiceSession, SCOPE_VOICE_KICKOFF, SCOPE_VOICE_PROMPT, SCOPE_VOICE_TOOLS } from '../src/scope-voice.js'
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
      recommendation: 'Use Executor', why: 'It is already warm.', messages: [message('agent', 'Which runner?')], created_at: at },
    { id: 'T3', anchor: on('plan', 'Then the voice'), author: 'agent', kind: 'question', status: 'resolved',
      messages: [message('agent', 'Voice this round?')], created_at: at,
      resolution: { decision: 'Yes, this round', alex_words: 'Yes', by: 'alex', at, confirmed_at: at, revision: 1 } },
    { id: 'T4', anchor: on('title', 'Demo scope'), author: 'alex', kind: 'comment', status: 'open', messages: [message('alex', 'Looks good.')], created_at: at },
    { id: 'T5', anchor: on('risks', 'Voice may slip'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Voice in round two', messages: [message('agent', 'When does voice ship?')], created_at: at },
  ],
}

test('the scoping voice waits, steps to the next question, confirms his answer, and resolves on his yes', async () => {
  const h = await startScopeHarness(v2)
  const { request, until } = h
  const call = async (path, body) => {
    const res = await request(path, { method: 'POST', headers: human, body })
    if (res.status >= 300) throw new Error(res.json?.error || `HTTP ${res.status}`)
    return res.json
  }
  const context = { thread: 'T1', section: 'plan', selection: null }
  const session = createScopeVoiceSession({
    getScope: async () => ({ slug: 'demo', scope: (await request('/api/scope/demo', { headers: human })).json.scope }),
    getContext: () => ({ ...context }),
    postThread: (body) => call('/api/scope/demo/threads', body),
    postReply: (id, body) => call(`/api/scope/demo/threads/${id}/reply`, body),
    postResolve: (id, body) => call(`/api/scope/demo/threads/${id}/resolve`, body),
    postReject: (id, body) => call(`/api/scope/demo/threads/${id}/reject`, body),
    postPark: (id, body) => call(`/api/scope/demo/threads/${id}/park`, body),
  })
  const short = []
  // The page applies ui the way the real page does: focus follows it.
  const say = async (name, args = {}, { read = false } = {}) => {
    const result = await session.handle(name, args)
    if (result.ui?.do === 'focus_thread') context.thread = result.ui.thread
    if (result.ui?.do === 'focus_section') context.section = result.ui.section
    assert.doesNotMatch(result.speech, /\bT\d+\b|https?:|_/, `${name} speech leaks an id, link or tool name`)
    if (!read) short.push([name, result.speech])
    return result
  }
  const thread = async (id) => (await request('/api/scope/demo', { headers: human })).json.scope.threads.find((t) => t.id === id)
  try {
    // 1. He leads: the kickoff asks for "Ready." only, and nothing reads a list of questions.
    assert.match(SCOPE_VOICE_KICKOFF, /Ready\./)
    assert.doesNotMatch(SCOPE_VOICE_PROMPT, /overview|open questions:|list (the|all) questions/i)
    const names = SCOPE_VOICE_TOOLS.map((tool) => tool.name)
    for (const name of ['next_question', 'previous_question', 'read_thread', 'next_section', 'previous_section', 'go_to_section',
      'show_resolved', 'scroll', 'answer', 'take_recommendation', 'reject', 'park', 'confirm', 'cancel', 'resolve', 'comment', 'reply', 'end_call']) {
      assert.ok(names.includes(name), `tool ${name}`)
    }
    assert.ok(!names.includes('scope_overview'))

    // 2. "Next question" from T1 focuses T2 and reads only it.
    const next = await say('next_question', {}, { read: true })
    assert.deepEqual(next.ui, { do: 'focus_thread', thread: 'T2' })
    assert.equal(next.speech, 'Which runner?')

    // 3. His answer is a proposal: one line to confirm, nothing sent yet.
    const before = h.paneLines()
    const proposed = await say('answer', { text: 'use Executor' })
    assert.equal(proposed.speech, 'Resolve this as: use Executor. Yes?')
    assert.equal((await thread('T2')).status, 'open')
    assert.equal(h.paneLines(), before)

    // 4. His yes resolves T2 by voice as his own answer, and the lane's pane hears it.
    assert.equal((await say('confirm')).speech, 'Resolved.')
    const t2 = await thread('T2')
    assert.equal(t2.status, 'resolved')
    assert.deepEqual([t2.resolution.decision, t2.resolution.alex_words, t2.resolution.by, t2.resolution.how], ['use Executor', 'use Executor', 'alex', 'own'])
    await until(() => h.paneLines().includes('Alex (by voice) answered T2 his own way (§Risks "The runner may be slow"): use Executor. Edit §Risks to say so, then run: unblock scope resolve demo T2'), 'voice resolve in the pane')
    assert.equal((await say('confirm')).ok, false)

    // 5. Section navigation, then a comment lands on the focused section.
    const went = await say('go_to_section', { name: 'plan' }, { read: true })
    assert.deepEqual(went.ui, { do: 'focus_section', section: 'plan' })
    assert.equal(went.speech, 'The plan')
    assert.equal((await say('comment', { text: 'Keep the page light.' })).speech, 'Comment: "Keep the page light." File it?')
    assert.equal((await say('confirm')).speech, 'Posted.')
    await until(() => h.paneLines().includes('Alex (by voice) on §The plan "The plan": Keep the page light. (new T6)'), 'voice comment in the pane')
    assert.deepEqual((await say('show_resolved', { on: true })).ui, { do: 'show_resolved', on: true })
    assert.deepEqual((await say('scroll', { direction: 'down' })).ui, { do: 'scroll', direction: 'down' })

    // 6. Back on T1, "take the recommendation" resolves at once.
    context.thread = 'T1'
    assert.equal((await say('take_recommendation')).ok, true)
    const t1 = await thread('T1')
    assert.deepEqual([t1.status, t1.resolution.decision, t1.resolution.alex_words, t1.resolution.how], ['resolved', 'Page first', 'Take the recommendation', 'take'])

    // 6b. "No, I hate it" on T5: sent at once, the comment stays open and rejected; the pane hears a rejection.
    context.thread = 'T5'
    assert.equal((await say('reject', { reason: 'too late' })).speech, 'Sent. Waiting for a new option.')
    const t5 = await thread('T5')
    assert.equal(t5.status, 'open')
    assert.ok(t5.rejected_at)
    await until(() => h.paneLines().includes('Alex (by voice) rejected the recommendation on T5 (§Risks "Voice may slip"): too late. Offer a new option:'), 'voice rejection in the pane')
    // "Not now" parks it.
    assert.equal((await say('park')).speech, 'Parked for later.')
    assert.equal((await thread('T5')).status, 'parked')
    assert.equal((await say('reject')).ok, false)

    // 7. A comment comment takes a spoken reply as a reply, read back and sent on his yes (r18).
    context.thread = 'T4'
    assert.equal((await say('answer', { text: 'Ship it this week.' })).speech, 'Reply: "Ship it this week." Send it?')
    assert.equal((await say('confirm')).speech, 'Sent.')
    assert.deepEqual((await thread('T4')).messages.map((m) => [m.from, m.via ?? null]), [['alex', null], ['alex', 'voice']])

    assert.deepEqual((await say('end_call')).ui, { do: 'end_call' })
    // Quiet router: every turn that is not a read stays at 12 words or fewer.
    for (const [name, speech] of short) assert.ok(speech.split(/\s+/).filter(Boolean).length <= 12, `${name}: "${speech}"`)
  } finally {
    await h.close()
  }
})
