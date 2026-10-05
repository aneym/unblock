// Owner: Opus (r12, scope patch). Implementers make it pass and never edit it.
// Lanes edit one section right after answering a note (PROTOCOL "Live doc, live comments"), so the page updates
// section by section. `unblock scope patch <slug> <id> --from file.md` replaces one section through
// PUT /api/scope/<slug>/sections/<id>, with the same checks as a doc write: assets, the unslop gate, change
// stamps, comment re-anchoring and one live event. Two lanes patching different sections never lose each other's edit.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T21:00:00Z'
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [
    { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
    { id: 'plan', heading: 'The plan', body_md: 'We ship the page first. Voice comes last.' },
    { id: 'later', heading: 'Later', body_md: 'Settings wait for the second pass.' },
  ] },
  threads: [
    { id: 'T1', anchor: { section: 'plan', quote: 'Voice comes last', prefix: 'page first. ', suffix: '.' }, author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Voice last', messages: [{ from: 'agent', text: 'Voice in the first cut?', at }], created_at: at },
  ],
}

test('a lane patches one section; checks match a doc write; parallel patches both land', async () => {
  const h = await startScopeHarness(v2)
  const { request, bearer } = h
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  const patch = (id, body, headers = bearer) => request(`/api/scope/demo/sections/${id}`, { method: 'PUT', headers, body })
  try {
    const events = await h.stream('/api/scope/demo/events')

    // 1. One section changes; the others keep their text and stamps; the revision moves once; the page hears it.
    const before = await get()
    const ok = await patch('later', { body_md: 'Settings wait for the second pass. Themes ship with them.' })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.revision, 2)
    assert.deepEqual(ok.json.detached, [])
    assert.ok(Array.isArray(ok.json.warnings))
    const after = await get()
    assert.equal(after.revision, 2)
    assert.equal(after.doc.sections.find((s) => s.id === 'later').body_md, 'Settings wait for the second pass. Themes ship with them.')
    assert.equal(after.doc.sections.find((s) => s.id === 'later').heading, 'Later', 'no heading given keeps the heading')
    assert.ok(Date.parse(after.doc.sections.find((s) => s.id === 'later').updated_at) > Date.parse(at))
    for (const id of ['title', 'plan']) assert.deepEqual(after.doc.sections.find((s) => s.id === id), before.doc.sections.find((s) => s.id === id))
    await events.next('scope', (d) => d.scope?.revision === 2)

    // 2. A heading can change too; a comment whose quote is gone is reported detached, as with a doc write.
    const moved = await patch('plan', { heading: 'The plan, phones first', body_md: 'We ship the page first, for phones.' })
    assert.equal(moved.status, 200, moved.text)
    assert.deepEqual(moved.json.detached, ['T1'])
    assert.equal((await get()).doc.sections.find((s) => s.id === 'plan').heading, 'The plan, phones first')

    // 3. The same gates as a doc write: unslop, unknown section, Alex, bad body. Nothing changes on a refusal.
    const slop = await patch('later', { body_md: 'We leverage a pivotal flow.' })
    assert.equal(slop.status, 422)
    assert.equal(slop.json.error, 'unslop')
    assert.ok(slop.json.findings.every((f) => f.section === 'later'))
    assert.equal((await patch('later', { body_md: 'Vector leads.', keep: ['Vector'] })).status, 200)
    assert.equal((await patch('nowhere', { body_md: 'Words.' })).status, 404)
    assert.equal((await patch('later', { body_md: 'Words.' }, human)).status, 403)
    assert.equal((await patch('later', { body_md: 42 })).status, 400)
    assert.equal((await patch('later', { body_md: '![x](https://evil.example/x.png)' })).status, 400, 'image lines must be assets, as in a doc write')
    const rev = (await get()).revision

    // 4. Two lanes patch different sections at once: both edits land, two revisions.
    const [a, b] = await Promise.all([patch('title', { body_md: 'A page for phones.' }), patch('later', { body_md: 'Settings come second.' })])
    assert.equal(a.status, 200, a.text); assert.equal(b.status, 200, b.text)
    const both = await get()
    assert.equal(both.revision, rev + 2)
    assert.equal(both.doc.sections.find((s) => s.id === 'title').body_md, 'A page for phones.')
    assert.equal(both.doc.sections.find((s) => s.id === 'later').body_md, 'Settings come second.')

    // 5. The CLI: a file holding one section (an optional heading line, then the body). Findings exit 2 and publish nothing.
    const work = mkdtempSync(join(tmpdir(), 'scope-patch-'))
    const cli = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { cwd: work, env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    writeFileSync(join(work, 'later.md'), '## Later, after phones {#later}\n\nSettings come second. Themes come with them.\n')
    const done = await cli('scope', 'patch', 'demo', 'later', '--from', join(work, 'later.md'))
    assert.equal(done.status, 0, done.stderr)
    assert.match(done.stdout, /revision \d+/)
    const cliScope = await get()
    assert.equal(cliScope.doc.sections.find((s) => s.id === 'later').heading, 'Later, after phones')
    assert.equal(cliScope.doc.sections.find((s) => s.id === 'later').body_md.trim(), 'Settings come second. Themes come with them.')
    writeFileSync(join(work, 'body.md'), 'Just a body, no heading line.\n')
    assert.equal((await cli('scope', 'patch', 'demo', 'later', '--from', join(work, 'body.md'))).status, 0)
    assert.equal((await get()).doc.sections.find((s) => s.id === 'later').heading, 'Later, after phones', 'no heading line keeps the heading')
    writeFileSync(join(work, 'slop.md'), 'We leverage it.\n')
    const refused = await cli('scope', 'patch', 'demo', 'later', '--from', join(work, 'slop.md'))
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /§later/)
    assert.match(refused.stderr, /\/unslop/)
    events.close()
  } finally { await h.close() }
})
