// Scenario (owner: Opus; implementers make it pass, never edit it):
// Alex selects a line in Rails Admin and types a comment. While he types, the lane
// rewrites that section, so the line he selected is gone when the relay posts his
// comment (factory-lookback, 5 Oct: two comments refused as "invalid anchor" and
// shown "Not sent", and Try again resent the same quote). His words land anyway, on
// the quote he chose, detached like any thread a doc write leaves behind, and the
// lane hears them with that quote.
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-e2e-0123456789abcdefghijklmnopqrstuv'
const at = '2026-10-05T13:59:31Z'
const before = [
  { id: 'title', heading: 'Look back', body_md: 'Which past conclusions still hold.' },
  { id: 'build', heading: 'How it gets built', body_md: '| Piece | Runs on |\n|---|---|\n| Edit the rules files and memory | Studio (rules live there) |\n| Weekly lookback check | ax42 |' },
  { id: 'old', heading: 'Old plan', body_md: 'Four waves, one after another.' },
]
const after = [
  before[0],
  { id: 'build', heading: 'How it gets built', body_md: '| Piece | Runs on |\n|---|---|\n| Shared rules text | any box |\n| Machines file | any box |' },
]
const scope = { version: 2, slug: 'lookback', title: 'Look back', pane: 'w5H:pT1', revision: 5, updated_at: at, doc: { sections: before }, threads: [] }

test('a comment on text the lane rewrote while Alex typed lands detached with his quote', async () => {
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = RELAY
  const h = await startScopeHarness(scope)
  const { request, bearer, paneLines, until } = h
  const relay = { 'X-Unblock-Relay': RELAY }
  try {
    // Admin still shows revision 5 when Alex selects his text.
    const stale = anchorInSection(before[1], 'Studio (rules live there)')
    const gone = anchorInSection(before[2], 'Four waves')
    assert.ok(stale && gone)
    // The lane publishes revision 6 first: the row and the whole old section are gone.
    const rewrite = await request('/api/scope/lookback/doc', { method: 'PUT', headers: bearer, body: { sections: after } })
    assert.equal(rewrite.status, 200, rewrite.text)

    // The relay posts what Admin queued, exactly as the page sent it.
    const comment = { anchor: stale, text: 'rules should live on the factory home, wherever that is', client_id: '9bc988fe-3c52-4cd2-8eb0-72a60422ca0b' }
    const made = await request('/api/scope/lookback/threads', { method: 'POST', headers: relay, body: comment })
    assert.equal(made.status, 201, made.text)
    assert.deepEqual(made.json.thread.anchor, stale)
    assert.equal(made.json.thread.author, 'alex')
    assert.equal(made.json.thread.messages[0].text, comment.text)
    await until(() => paneLines().includes('Alex (in Admin) on §How it gets built "Studio (rules live there)": rules should live on the factory home, wherever that is (new T1)'), 'the lane hears the comment with its quote')

    // The outbox retry and the page's Try again both land once.
    const again = await request('/api/scope/lookback/threads', { method: 'POST', headers: relay, body: comment })
    assert.equal(again.status, 200, again.text)
    assert.equal(again.json.duplicate, true)

    // A section the lane dropped holds his words the same way.
    const dropped = await request('/api/scope/lookback/threads', { method: 'POST', headers: relay, body: { anchor: gone, text: 'machine registry should be deterministic', client_id: '27e8b354-57f4-4cd9-9edc-be017563b5ae' } })
    assert.equal(dropped.status, 201, dropped.text)

    const listed = (await request('/api/scope/lookback', { headers: human })).json.scope
    assert.deepEqual(listed.threads.map((t) => [t.id, t.status, t.anchor.section, t.anchor.quote]), [
      ['T1', 'open', 'build', 'Studio (rules live there)'], ['T2', 'open', 'old', 'Four waves'],
    ])
    // The next doc write names both as detached, as it names any thread whose text moved.
    const next = await request('/api/scope/lookback/doc', { method: 'PUT', headers: bearer, body: { sections: after } })
    assert.deepEqual(next.json.detached, ['T1', 'T2'])

    // A malformed anchor is still a bad request: no quote, or a section id no doc can have.
    for (const anchor of [{ section: 'build', quote: '' }, { section: 'Build!', quote: 'Machines file' }]) {
      assert.equal((await request('/api/scope/lookback/threads', { method: 'POST', headers: relay, body: { anchor, text: 'x', client_id: 'adm-bad' } })).status, 400)
    }
  } finally { await h.close() }
})
