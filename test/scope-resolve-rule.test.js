// Owner: Opus (2026-10-03 resolve-rule). Implementers make it pass; they never edit it.
// Alex (2026-10-03 ~23:15 ET): "you're resolving comments before i read the response to my question, another falw in the
// commenting system. i should just have an easy button to resolve it myself, unless its obvious that i want ou to close it?"
// and (~22:40 ET) "need the prpoer long term fix for this". The tool enforces it, not only the protocol:
//   - each thread records who opened it and what kind it is: intent 'question' or 'change' on his, 'ask' on a lane's;
//   - a lane closes a thread he opened only with (b) his own words from that thread that say close/approve/take it/ok
//     (--quote, his latest message there), or (c) for a change he asked for, the doc revision that made it (--revision N,
//     a revision after his message that changed the anchored section). (a) He resolves it himself with his button.
//   - every refusal prints the rule; the CLI passes --quote and --revision;
//   - Rails Admin's relay may reopen and delete for him (the 403 RELAY_SCOPE_ONLY that dropped his two "reopen T1").
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-e2e-0123456789abcdefghijklmnopqrstuv'
const at = '2026-10-03T20:00:00Z'
const title = { id: 'title', heading: 'Demo scope', body_md: 'A small page.' }
const plan = { id: 'plan', heading: 'The plan', body_md: 'We run Sol medium for the build. Then the review.' }
const later = { id: 'later', heading: 'Later', body_md: 'Voice comes last.' }
const sections = [title, plan, later]
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: anchorInSection(later, 'Voice comes last'), author: 'agent', kind: 'question', status: 'open', recommendation: 'Last',
      messages: [{ from: 'agent', text: 'Voice first or last?', at }], created_at: at },
  ],
}

test('a lane closes his comment only with his close words or the revision that made his change', async () => {
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = RELAY
  const h = await startScopeHarness(scope)
  const { request, bearer } = h
  const relay = { 'X-Unblock-Relay': RELAY }
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  const thread = async (id) => (await get()).threads.find((t) => t.id === id)
  const post = (id, verb, body, headers = bearer) => request(`/api/scope/demo/threads/${id}/${verb}`, { method: 'POST', headers, body })
  const comment = async (section, quote, words, client_id) => {
    const posted = await request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor: anchorInSection(section, quote), text: words, client_id } })
    assert.equal(posted.status, 201, posted.text)
    return posted.json.thread.id
  }
  const doc = async (next) => {
    const put = await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections: next } })
    assert.equal(put.status, 200, put.text)
    return put.json.revision
  }
  const cli = (...a) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...a], { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => done({ status, stdout, stderr }))
  })
  const refused = (res, pattern, why) => {
    assert.equal(res.status, 403, `${why}: ${res.text}`)
    assert.equal(res.json.code, 'ALEX_RESOLVES', why)
    assert.match(res.json.error, pattern, why)
  }
  const RULE = /Alex resolves his own comments[\s\S]*--quote[\s\S]*--revision/
  try {
    // 1. Each thread says who opened it and what kind it is.
    const question = await comment(plan, 'We run Sol medium for the build', 'sol 6.1 right?', 'c-1')
    const change = await comment(plan, 'Then the review', 'make the review two seats', 'c-2')
    assert.deepEqual([(await thread(question)).author, (await thread(question)).intent], ['alex', 'question'])
    assert.deepEqual([(await thread(change)).author, (await thread(change)).intent], ['alex', 'change'])
    const ask = await request('/api/scope/demo/threads', { method: 'POST', headers: bearer, body: { section: 'plan', quote: 'Then the review', text: 'Who reviews?' } })
    assert.equal(ask.status, 201, ask.text)
    assert.deepEqual([ask.json.thread.author, ask.json.thread.intent], ['agent', 'ask'])

    // 2. The lane answers his question and tries to close it on its own word: refused, with the rule, and it stays open.
    assert.equal((await post(question, 'reply', { text: 'Yes: Sol is GPT-6.1 Sol.' })).status, 200)
    refused(await post(question, 'resolve', { decision: 'Answered: Sol is 6.1.' }), RULE, 'a reason alone')
    assert.equal((await thread(question)).status, 'open')
    assert.equal((await thread(question)).messages.at(-1).text, 'Yes: Sol is GPT-6.1 Sol.', 'a refused close adds nothing')

    // 3. Words that are not his, words that do not say close, and a revision on a question: each refused.
    refused(await post(question, 'resolve', { decision: 'He agreed.', quote: 'ok close it' }), /not his words/, 'a quote he never wrote')
    assert.equal((await post(question, 'reply', { text: 'hm, and the reviewer?', client_id: 'c-3' }, human)).status, 200)
    refused(await post(question, 'resolve', { decision: 'He agreed.', quote: 'and the reviewer' }), /close|approve|take it|ok/i, 'his words that ask, not close')
    refused(await post(question, 'resolve', { decision: 'Done.', revision: 2 }), /question/, 'a revision does not answer a question')

    // 4. His close words, from his latest message there: allowed, and the record keeps them.
    assert.equal((await post(question, 'reply', { text: 'Sonnet reviews.' })).status, 200)
    assert.equal((await post(question, 'reply', { text: 'ok, close it', client_id: 'c-4' }, human)).status, 200)
    const closed = await post(question, 'resolve', { decision: 'Alex agreed: Sol builds, Sonnet reviews.', quote: 'OK, close it' })
    assert.equal(closed.status, 200, closed.text)
    let t = await thread(question)
    assert.equal(t.status, 'resolved')
    assert.deepEqual([t.resolution.by, t.resolution.quote], ['agent', 'ok, close it'])

    // 5. Close words he has since taken back: only his latest message counts.
    const later1 = await comment(later, 'Voice comes last', 'why last?', 'c-5')
    assert.equal((await post(later1, 'reply', { text: 'Because the page ships first.' })).status, 200)
    assert.equal((await post(later1, 'reply', { text: 'ok', client_id: 'c-6' }, human)).status, 200)
    assert.equal((await post(later1, 'reply', { text: 'wait, what about the phone?', client_id: 'c-7' }, human)).status, 200)
    refused(await post(later1, 'resolve', { decision: 'He said ok.', quote: 'ok' }), /latest/, 'an ok he moved past')
    // And "not ok" never closes.
    assert.equal((await post(later1, 'reply', { text: 'The phone gets it in round two.' })).status, 200)
    assert.equal((await post(later1, 'reply', { text: 'not ok', client_id: 'c-8' }, human)).status, 200)
    refused(await post(later1, 'resolve', { decision: 'He replied.', quote: 'not ok' }), /close|approve|take it|ok/i, 'not ok')
    assert.equal((await thread(later1)).status, 'open')

    // 6. A change request closes with the revision that made the change: a later revision that touched its section.
    const r3 = await doc(sections)                                                    // a snapshot, no change
    const r4 = await doc([{ ...title, body_md: 'A small page, renamed.' }, plan, later]) // touches §Demo scope only
    const r5 = await doc([{ ...title, body_md: 'A small page, renamed.' }, { ...plan, body_md: 'We run Sol medium for the build. Then the review, by two seats.' }, later])
    assert.deepEqual([r3, r4, r5], [3, 4, 5])
    refused(await post(change, 'resolve', { decision: 'Two seats now.' }), RULE, 'a change with no revision')
    refused(await post(change, 'resolve', { decision: 'Two seats now.', revision: r4 }), /did not change/, 'a revision that left his section alone')
    refused(await post(change, 'resolve', { decision: 'Two seats now.', revision: 9 }), /revision 9/, 'a revision that does not exist')
    const made = await post(change, 'resolve', { decision: 'Two seats now: Sonnet and Sol.', revision: r5 })
    assert.equal(made.status, 200, made.text)
    t = await thread(change)
    assert.deepEqual([t.status, t.resolution.by, t.resolution.revision], ['resolved', 'agent', r5])

    // 7. A revision made before he asked does not count.
    const after = await comment(plan, 'Then the review', 'and name the seats', 'c-9')
    refused(await post(after, 'resolve', { decision: 'Named.', revision: r5 }), /before/, 'a revision older than his comment')

    // 8. The CLI passes both, and a refusal prints the rule and exits non-zero.
    const bare = await cli('scope', 'resolve', 'demo', after, '--decision', 'Named them.')
    assert.notEqual(bare.status, 0)
    assert.match(bare.stderr, RULE)
    const r6 = await doc([{ ...title, body_md: 'A small page, renamed.' }, { ...plan, body_md: 'We run Sol medium for the build. Then the review, by Sonnet and Sol.' }, later])
    const byCli = await cli('scope', 'resolve', 'demo', after, '--decision', 'Named: Sonnet and Sol.', '--revision', String(r6))
    assert.equal(byCli.status, 0, byCli.stderr)
    assert.equal((await thread(after)).status, 'resolved')
    assert.equal((await post(later1, 'reply', { text: 'Round two, then.' })).status, 200)
    assert.equal((await post(later1, 'reply', { text: 'take it', client_id: 'c-10' }, human)).status, 200)
    const quoted = await cli('scope', 'resolve', 'demo', later1, '--decision', 'Phone in round two.', '--quote', 'take it')
    assert.equal(quoted.status, 0, quoted.stderr)
    assert.equal((await thread(later1)).resolution.quote, 'take it')

    // 9. Unchanged: his own Resolve, a lane's own ask, and the lane confirming his resolve.
    const mine = await comment(later, 'Voice comes last', 'fine as is', 'c-11')
    assert.equal((await post(mine, 'resolve', { decision: 'Resolved', alex_words: 'Resolved', how: 'resolve', client_id: 'c-12' }, human)).status, 200)
    assert.equal((await thread(mine)).resolution.by, 'alex')
    assert.equal((await post(mine, 'resolve', {})).status, 200, 'the lane confirms his resolve')
    assert.equal((await post(ask.json.thread.id, 'resolve', { decision: 'Sonnet reviews.' })).status, 200, 'a lane closes its own ask')

    // 10. Rails Admin's relay reopens and deletes for him, once each (the dropped "reopen T1").
    const reopen = await post(question, 'reopen', { client_id: 'adm-r1' }, relay)
    assert.equal(reopen.status, 200, reopen.text)
    assert.equal((await thread(question)).status, 'open')
    const again = await post(question, 'reopen', { client_id: 'adm-r1' }, relay)
    assert.equal(again.status, 200, again.text)
    assert.equal(again.json.duplicate, true)
    const gone = await post(mine, 'delete', { client_id: 'adm-d1' }, relay)
    assert.equal(gone.status, 200, gone.text)
    assert.equal(await thread(mine), undefined)
    assert.equal((await post(mine, 'delete', { client_id: 'adm-d1' }, relay)).json.duplicate, true)
  } finally {
    delete process.env.UNBLOCK_ADMIN_RELAY_TOKEN
    await h.close()
  }
})
