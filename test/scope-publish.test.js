// PM scenario for p0M DG3s (scope rails-rooms T22, Block G), written by the Opus spec author; the implementer may
// not edit it. Story: a doc is Draft until someone publishes it. Publishing freezes a copy stamped with where it went
// and when, and that copy is the record; open comments close with the publish. A later rewrite opens a new draft on
// the same doc, publishing again adds the next version, and the first copy stays exactly as it was published.
// Kinds are Scope, Explainer, Review, Writing and Report. Boundaries: the real daemon over a temp scoping root
// (scope-harness.js); requests go through HTTP as Alex (tailnet identity) or as the lane (bearer).
import assert from 'node:assert/strict'
import test from 'node:test'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-03T18:00:00.000Z'
const sections = [
  { id: 'title', heading: 'Redbud application answers', body_md: 'Answers for the Redbud form.' },
  { id: 'why-now', heading: 'Why now', body_md: 'Agents now finish real work for small teams.' },
]
const writing = {
  version: 2, slug: 'redbud-answers', title: 'Redbud application answers', pane: 'w5H:pT1', kind: 'writing',
  destination: { where: 'submitted', target: 'Redbud portal' },
  revision: 3, updated_at: at,
  doc: { sections },
  threads: [
    { id: 'T1', anchor: { section: 'why-now', quote: 'real work', prefix: 'Agents now finish', suffix: 'for small teams.' },
      author: 'alex', kind: 'comment', status: 'open', messages: [{ from: 'alex', text: 'Say which work.', at }], created_at: at },
  ],
}

test('Alex publishes a Writing draft: a frozen copy stamped with where it went, and open comments close', async () => {
  const h = await startScopeHarness(writing)
  try {
    const read = async () => (await h.request('/api/scope/redbud-answers', { headers: human }))
    const before = await read()
    assert.equal(before.status, 200, `a Writing doc loads: ${before.text}`)
    assert.equal(before.json.scope.kind, 'writing')
    assert.equal(before.json.scope.state ?? 'draft', 'draft', 'a doc is Draft until it is published')

    const publish = (body, headers = human) => h.request('/api/scope/redbud-answers/publish', { method: 'POST', headers, body })
    const stale = await publish({ revision: 2 })
    assert.equal(stale.status, 409, `publishing an older revision is refused: ${stale.text}`)
    assert.equal((await read()).json.scope.state ?? 'draft', 'draft', 'a refused publish changes nothing')

    const done = await publish({ revision: 3, client_id: 'pub-redbud-1' })
    assert.equal(done.status, 200, done.text)
    assert.equal(done.json.version, 1)
    const again = await publish({ revision: 3, client_id: 'pub-redbud-1' })
    assert.equal(again.status, 200, 'the same click delivered twice is one publish')
    assert.equal(again.json.version, 1)

    const scope = (await read()).json.scope
    assert.equal(scope.state, 'published')
    assert.equal(scope.versions.length, 1)
    const [stamp] = scope.versions
    assert.deepEqual({ version: stamp.version, revision: stamp.revision, by: stamp.by, where: stamp.where, target: stamp.target },
      { version: 1, revision: 3, by: 'alex', where: 'submitted', target: 'Redbud portal' })
    assert.ok(!Number.isNaN(Date.parse(stamp.at)), 'the stamp says when')
    const t1 = scope.threads.find(t => t.id === 'T1')
    assert.equal(t1.status, 'resolved', 'open comments close with the publish')
    assert.equal(t1.resolution.decision, 'Closed when published')

    const copy = await h.request('/api/scope/redbud-answers/published/1', { headers: human })
    assert.equal(copy.status, 200, copy.text)
    assert.equal(copy.json.version, 1)
    assert.equal(copy.json.kind, 'writing')
    assert.equal(copy.json.title, 'Redbud application answers')
    assert.equal(copy.json.revision, 3)
    assert.equal(copy.json.where, 'submitted')
    assert.equal(copy.json.target, 'Redbud portal')
    assert.deepEqual(copy.json.sections.map(s => [s.id, s.heading, s.body_md]), sections.map(s => [s.id, s.heading, s.body_md]))
  } finally { await h.close() }
})

test('a rewrite after publishing opens a new draft; publishing again adds v2 and v1 stays as it was', async () => {
  const h = await startScopeHarness(writing)
  try {
    assert.equal((await h.request('/api/scope/redbud-answers/publish', { method: 'POST', headers: human, body: { revision: 3 } })).status, 200)
    const rewritten = [sections[0], { id: 'why-now', heading: 'Why now', body_md: 'Agents now finish paid work for small teams.' }]
    const put = await h.request('/api/scope/redbud-answers/doc', { method: 'PUT', headers: h.bearer, body: { sections: rewritten } })
    assert.equal(put.status, 200, put.text)

    let scope = (await h.request('/api/scope/redbud-answers', { headers: human })).json.scope
    assert.equal(scope.state, 'draft', 'editing after a publish opens a new draft on the same doc')
    assert.equal(scope.versions.length, 1, 'the published copy is still on record')
    assert.equal(scope.revision, 4)

    const second = await h.request('/api/scope/redbud-answers/publish', { method: 'POST', headers: human, body: { revision: 4 } })
    assert.equal(second.status, 200, second.text)
    assert.equal(second.json.version, 2)
    scope = (await h.request('/api/scope/redbud-answers', { headers: human })).json.scope
    assert.deepEqual(scope.versions.map(v => [v.version, v.revision]), [[1, 3], [2, 4]])

    const v1 = await h.request('/api/scope/redbud-answers/published/1', { headers: human })
    assert.equal(v1.json.sections[1].body_md, 'Agents now finish real work for small teams.', 'v1 is frozen as it was published')
    const v2 = await h.request('/api/scope/redbud-answers/published/2', { headers: human })
    assert.equal(v2.json.sections[1].body_md, 'Agents now finish paid work for small teams.')
  } finally { await h.close() }
})

test('a routine publishes its Report; Review and Explainer docs load as their kinds', async () => {
  const report = { ...writing, slug: 'glossary-report', title: 'Glossary after ship', kind: 'report', threads: [] }
  delete report.destination
  const h = await startScopeHarness(report)
  try {
    const published = await h.request('/api/scope/glossary-report/publish', { method: 'POST', headers: h.bearer, body: { revision: 3, where: 'posted', target: 'Release notes' } })
    assert.equal(published.status, 200, published.text)
    const scope = (await h.request('/api/scope/glossary-report', { headers: human })).json.scope
    assert.equal(scope.kind, 'report')
    assert.deepEqual([scope.versions[0].by, scope.versions[0].where, scope.versions[0].target], ['agent', 'posted', 'Release notes'])

    for (const kind of ['review', 'explainer', 'scope']) {
      h.writeScope({ ...report, kind, state: undefined, versions: undefined })
      const read = await h.request('/api/scope/glossary-report', { headers: human })
      assert.equal(read.status, 200, `${kind}: ${read.text}`)
      assert.equal(read.json.scope.kind, kind)
    }
  } finally { await h.close() }
})
