// Owner: Opus (r34, resolve 400). Implementers copy it to test/ and make it pass; they never edit it.
// Alex hit POST /api/scope/daily-workflow/threads/T5/resolve -> 400 (2026-09-30 ~09:30 ET). The page's "Something else"
// answer sends {decision, alex_words, how:'own'} with his words in both; the server capped decision at 600 chars, so any
// longer answer failed. His words are never refused under 4000 chars. Over 4000 the error says how long it may be.
// A refused scope write is logged (slug, comment, verb, error) so the next one is found without a repro.
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-30T13:00:00Z'
const sections = [
  { id: 'title', heading: 'Daily workflow', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We run the morning pass first. Then the evening pass.' },
]
const q = (id, quote) => ({ id, anchor: anchorInSection(sections[1], quote), author: 'agent', kind: 'question', status: 'open', recommendation: 'Morning', messages: [{ from: 'agent', text: 'Which pass first?', at }], created_at: at })
const scope = { version: 2, slug: 'demo', title: 'Daily workflow', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections }, threads: [q('T1', 'We run the morning pass first'), q('T2', 'Then the evening pass'), q('T3', 'The plan')] }
const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 10}`).join(' ').slice(0, n)

test('a long "Something else" answer resolves; only past 4000 chars is it refused, with a clear reason, and logged', async () => {
  const errors = []
  const original = console.error
  console.error = (...args) => { errors.push(args.join(' ')); original(...args) }
  const h = await startScopeHarness(scope)
  const { request, bearer } = h
  const resolve = (id, body, headers = human) => request(`/api/scope/demo/threads/${id}/resolve`, { method: 'POST', headers, body })
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  try {
    // 1. 1,500 chars of his own answer: 200, and both fields keep every word.
    const long = words(1500)
    const ok = await resolve('T1', { decision: long, alex_words: long, how: 'own', client_id: 'c-long' })
    assert.equal(ok.status, 200, ok.text)
    const t1 = (await get()).threads.find((t) => t.id === 'T1')
    assert.equal(t1.status, 'resolved')
    assert.equal(t1.resolution.decision, long)
    assert.equal(t1.resolution.alex_words, long)

    // 2. Exactly 4000 is fine; 4001 is refused with a reason that names the limit, and nothing changes.
    assert.equal((await resolve('T2', { decision: words(4000), alex_words: words(4000), how: 'own' })).status, 200)
    const tooLong = await resolve('T3', { decision: words(4001), alex_words: words(4001), how: 'own' })
    assert.equal(tooLong.status, 400)
    assert.match(tooLong.json.error, /4000/, 'the error says how long an answer may be')
    assert.equal((await get()).threads.find((t) => t.id === 'T3').status, 'open')

    // 3. A refused write is logged with slug, comment, verb and the error.
    assert.ok(errors.some((line) => line.includes('demo') && line.includes('T3') && line.includes('resolve') && line.includes('4000')), `no log line: ${JSON.stringify(errors)}`)

    // 4. A lane's own resolve still caps its decision at 600 (lanes write short decisions).
    const lane = await resolve('T3', { decision: words(700) }, bearer)
    assert.equal(lane.status, 400)
  } finally { console.error = original; await h.close() }
})
