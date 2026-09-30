// Owner: Opus (r27, scopes nested per app). Implementers make it pass and never edit it.
// Alex (2026-09-30 via pJ0, NESTING-CONTRACT.md): each app's scopes nest under that app (Recruiter, Closer,
// Rails Admin), linked both ways. A scope carries `app`, one of recruiter | closer | rails-admin. Until a lane
// sets it, the app is inferred from the slug (recruiter* -> recruiter, closer* -> closer, else rails-admin), the
// same rule Admin uses, so the cutover is only data. `unblock scope app <slug> <app>` sets it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'
import { validateScope } from '../src/scope-doc.js'

const at = '2026-09-30T01:00:00Z'
const scopeOf = (slug, extra = {}) => ({
  version: 2, slug, title: `Scope ${slug}`, pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: `Scope ${slug}`, body_md: 'A small page.' }, { id: 'plan', heading: 'The plan', body_md: 'We ship the page first.' }] },
  threads: [], ...extra,
})

test('a scope names its app: inferred from the slug until set, set by a lane, kept by every later write', async () => {
  const h = await startScopeHarness(scopeOf('demo'))
  const { request, bearer } = h
  const root = process.env.UNBLOCK_SCOPING_DIR
  const put = (slug, dir) => {
    mkdirSync(join(root, slug), { recursive: true })
    writeFileSync(join(root, slug, 'scope.tmp'), JSON.stringify(dir))
    renameSync(join(root, slug, 'scope.tmp'), join(root, slug, 'scope.json'))
  }
  put('recruiter-network', scopeOf('recruiter-network'))
  put('closer', scopeOf('closer'))
  put('voice', scopeOf('voice', { app: 'closer' }))
  const setApp = (slug, app, headers = bearer) => request(`/api/scope/${slug}/app`, { method: 'PUT', headers, body: { app } })
  const list = async () => Object.fromEntries((await request('/api/scope', { headers: human })).json.scopes.map((row) => [row.slug, row.app]))
  try {
    // 1. Listing rows and the scope reply carry the app. A stored app wins over the slug rule.
    assert.deepEqual(await list(), { demo: 'rails-admin', 'recruiter-network': 'recruiter', closer: 'closer', voice: 'closer' })
    const got = await request('/api/scope/recruiter-network', { headers: human })
    assert.equal(got.status, 200)
    assert.equal(got.json.app, 'recruiter', 'GET /api/scope/<slug> carries the app at the top level, inferred when unset')
    assert.equal(got.json.scope.app, undefined, 'an inferred app is never written into the stored scope')

    // 2. A lane sets it. Alex and the relay can't; only the three apps are accepted; an unknown slug is 404.
    const ok = await setApp('demo', 'recruiter')
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.app, 'recruiter')
    assert.equal(JSON.parse(readFileSync(join(root, 'demo', 'scope.json'), 'utf8')).app, 'recruiter')
    assert.equal((await request('/api/scope/demo', { headers: human })).json.app, 'recruiter')
    assert.equal((await list()).demo, 'recruiter')
    assert.equal((await setApp('demo', 'closer', human)).status, 403)
    assert.equal((await setApp('demo', 'poker')).status, 400)
    assert.equal((await setApp('demo', 42)).status, 400)
    assert.equal((await setApp('nowhere', 'closer')).status, 404)
    const stored = JSON.parse(readFileSync(join(root, 'demo', 'scope.json'), 'utf8'))
    assert.equal(stored.app, 'recruiter', 'a refused set changes nothing')
    assert.equal(stored.revision, 1, 'setting the app is not a doc revision')

    // 3. Every later write keeps it: a section patch, a doc write, a thread, an approval.
    assert.equal((await request('/api/scope/demo/sections/plan', { method: 'PUT', headers: bearer, body: { body_md: 'We ship the page first, for phones.' } })).status, 200)
    assert.equal((await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections: [{ id: 'title', heading: 'Scope demo', body_md: 'A small page.' }, { id: 'plan', heading: 'The plan', body_md: 'We ship the page first.' }] } })).status, 200)
    const approved = await request('/api/scope/demo/approve', { method: 'POST', headers: human, body: { mode: 'approve' } })
    assert.ok([200, 202].includes(approved.status), approved.text)
    await h.until(() => JSON.parse(readFileSync(join(root, 'demo', 'scope.json'), 'utf8')).approval, 'approval written')
    assert.equal(JSON.parse(readFileSync(join(root, 'demo', 'scope.json'), 'utf8')).app, 'recruiter')

    // 4. The stored field is checked like every other: a bad value makes the scope invalid.
    assert.deepEqual(validateScope(scopeOf('x', { app: 'rails-admin' })), [])
    assert.deepEqual(validateScope(scopeOf('x')), [])
    assert.ok(validateScope(scopeOf('x', { app: 'poker' })).includes('invalid app'))

    // 5. The CLI: `unblock scope app <slug> <app>` sets it; a bad name is a usage error (exit 2) and sends nothing;
    //    `unblock scope list --json` rows carry the app.
    const cli = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    const set = await cli('scope', 'app', 'closer', 'rails-admin')
    assert.equal(set.status, 0, set.stderr)
    assert.match(set.stdout, /rails-admin/)
    assert.equal((await list()).closer, 'rails-admin')
    const bad = await cli('scope', 'app', 'closer', 'poker')
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /recruiter.*closer.*rails-admin/)
    assert.equal((await list()).closer, 'rails-admin')
    const listed = await cli('scope', 'list', '--json')
    assert.equal(listed.status, 0, listed.stderr)
    const rows = JSON.parse(listed.stdout).scopes
    assert.equal(rows.find((row) => row.slug === 'recruiter-network').app, 'recruiter')
    assert.equal(rows.find((row) => row.slug === 'closer').app, 'rails-admin')
  } finally { await h.close() }
})
