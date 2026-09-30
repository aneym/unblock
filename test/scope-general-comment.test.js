// Owner: Opus (r21 item h, a general comment). Implementers copy it to test/ and make it pass; they never edit it.
// Alex, 2026-09-29 (Closer page, T13): "need an easy way in scoping docs to just leave a general comment not a
// highlighted comment only." The page posts a general comment on the title section with the doc title as its quote
// and anchor.general true. The daemon keeps the flag (title only), sends the lane "Alex (general): ...", never lists
// the thread as detached when the lane renames the title, and orders it first among open threads.
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection, orderThreads } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T19:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first. Then the voice.' },
]
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 3, updated_at: at, doc: { sections },
  threads: [
    // A plain highlight on the title text: it detaches when the title is renamed, as it does today.
    { id: 'T1', anchor: anchorInSection(sections[0], 'Demo scope'), author: 'alex', kind: 'comment', status: 'open',
      messages: [{ from: 'alex', text: 'Rename it?', at }], created_at: at },
    { id: 'T2', anchor: anchorInSection(sections[1], 'We build the page first'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Page first', messages: [{ from: 'agent', text: 'Page or voice first?', at }], created_at: at },
  ],
}

test('a general comment keeps its flag, reads "(general)" to the lane, survives a title rename and sorts first', async () => {
  const h = await startScopeHarness(scope)
  const { request, until, bearer } = h
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  const post = (anchor, text) => request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor, text, client_id: `c-${text.length}` } })
  try {
    // 1. The page's general anchor: the title section, the doc title as the quote, general true.
    const posted = await post({ section: 'title', quote: 'Demo scope', prefix: '', suffix: '', general: true }, 'The whole thing reads well.')
    assert.equal(posted.status, 201, posted.text)
    const id = posted.json.thread.id
    assert.equal(id, 'T3')
    assert.equal(posted.json.thread.anchor.general, true, 'the reply keeps anchor.general')
    assert.equal((await get()).threads.find((t) => t.id === id).anchor.general, true, 'the view keeps anchor.general')
    await until(() => h.paneLines().includes('[scoping demo] Alex (general): The whole thing reads well. (new T3)'), 'the general line in the pane')

    // 2. The flag means nothing off the title: it is dropped, and the comment is a plain highlight.
    const plain = await post({ section: 'plan', quote: 'Then the voice', prefix: '', suffix: '', general: true }, 'Voice can wait.')
    assert.equal(plain.status, 201, plain.text)
    assert.equal(plain.json.thread.anchor.general, undefined)
    assert.equal(orderThreads(await get())[0].id, 'T3', 'a general comment sorts first among open threads')

    // 3. The lane renames the title: the highlight on the old title detaches, the general comment does not.
    const renamed = (await get()).doc.sections.map((s) => s.id === 'title' ? { ...s, heading: 'Phone scope' } : s)
    const put = await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections: renamed } })
    assert.equal(put.status, 200, put.text)
    assert.ok(put.json.detached.includes('T1'), 'the plain title highlight is listed as detached')
    assert.ok(!put.json.detached.includes('T3'), 'the general comment is never detached')
    const after = await get()
    assert.equal(after.threads.find((t) => t.id === 'T3').anchor.general, true)
    assert.equal(orderThreads(after)[0].id, 'T3', 'still first after the rename')
  } finally {
    await h.close()
  }
})
