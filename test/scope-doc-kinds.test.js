import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOC_KINDS, validateScope } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-03T18:00:00.000Z'
const sections = [{ id: 'title', heading: 'Glossary', body_md: 'Terms.' }]

function base(extra = {}) {
  return { version: 2, slug: 'glossary', title: 'Glossary', pane: 'w5H:pT1', revision: 1, updated_at: at, doc: { sections }, threads: [], ...extra }
}

test('validateScope accepts the five doc kinds and rejects a bad kind, state, or version stamp', () => {
  for (const kind of DOC_KINDS) assert.deepEqual(validateScope(base({ kind })), [], kind)
  assert.ok(validateScope(base({ kind: 'memo' })).length, 'unknown kind')
  assert.ok(validateScope(base({ state: 'live' })).length, 'bad state')
  assert.ok(validateScope(base({ versions: [{ version: 1, revision: 1, at, by: 'alex' }] })).length, 'stamp without where')
  assert.ok(validateScope(base({ versions: [{ version: 1.5, revision: 1, at, by: 'agent', where: 'published' }] })).length, 'non-integer version')
})

test('a lane sets the destination; Alex cannot, and a later publish uses it', async () => {
  const h = await startScopeHarness({ ...base(), slug: 'glossary-report', revision: 3, kind: 'report' })
  try {
    const put = (headers, body) => h.request('/api/scope/glossary-report/destination', { method: 'PUT', headers, body })
    const alex = await put(human, { where: 'posted', target: 'Release notes' })
    assert.equal(alex.status, 403, alex.text)
    assert.equal(alex.json.error, 'lanes set the destination through the CLI')
    const lane = await put(h.bearer, { where: 'posted', target: 'Release notes' })
    assert.equal(lane.status, 200, lane.text)
    assert.deepEqual(lane.json.destination, { where: 'posted', target: 'Release notes' })
    const published = await h.request('/api/scope/glossary-report/publish', { method: 'POST', headers: h.bearer, body: { revision: 3 } })
    assert.equal(published.status, 200, published.text)
    const stamp = (await h.request('/api/scope/glossary-report', { headers: human })).json.scope.versions[0]
    assert.deepEqual([stamp.where, stamp.target, stamp.by], ['posted', 'Release notes', 'agent'])
  } finally { await h.close() }
})

test('scope new --kind report --parent writes both', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'unblock-kinds-'))
  const scopes = join(temp, 'scopes')
  const env = { ...process.env, UNBLOCK_STATE_DIR: join(temp, 'state'), UNBLOCK_CONFIG_DIR: join(temp, 'config'), UNBLOCK_PORT: '9', UNBLOCK_SCOPING_DIR: scopes, UNBLOCK_SECRET_BACKEND: 'env' }
  const child = spawn(process.execPath, [CLI, 'scope', 'new', 'glossary-report', '--pane', 'w5H:pT1', '--kind', 'report', '--parent', 'glossary'], { env })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const status = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(status, 0, stderr)
  const scope = JSON.parse(readFileSync(join(scopes, 'glossary-report', 'scope.json'), 'utf8'))
  assert.equal(scope.kind, 'report')
  assert.equal(scope.parent, 'glossary')
  assert.deepEqual(validateScope(scope), [])
})
