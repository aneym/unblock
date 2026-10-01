// Owner test (Opus, Development S4a-u, 2026-10-01; the implementer may not edit it).
// Alex, 2026-10-01 ~13:10 ET on /s/scope-page-tabs: "set KPIs to monitor over time". A scope declares 1 to 3 KPIs:
// {id, name, source, target, direction: 'at_least'|'at_most', window_days}; window_days defaults to 14 (T6). The PM
// sets them with `unblock scope kpi <slug> set --from <file>` and reads them with `unblock scope kpi <slug> list`.
// The daemon validates the shape (PUT /api/scope/<slug>/kpis), stores it on scope.json as `kpis`, and validateScope
// rejects a malformed list. The Studio KPI collector (agent-rails scripts/kpi_collect.py) reads scope.json's kpis.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateScope } from '../src/scope-doc.js'
import { startScopeHarness } from './scope-harness.js'

const at = '2026-10-01T17:00:00Z'
const scope = { version: 2, slug: 'recruiter-messages', title: 'Recruiter messages', pane: 'w5H:pRM', revision: 3, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Recruiter messages', body_md: 'One inbox for replies.' }] }, threads: [] }
const kpi = (id, extra = {}) => ({ id, name: `KPI ${id}`, source: 'admin-feed', target: 60, direction: 'at_least', ...extra })
const cli = fileURLToPath(new URL('../bin/unblock.js', import.meta.url))

function run(args) {
  // Async: the daemon runs in this process, so a blocking spawnSync would starve it.
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    for (const name of ['UNBLOCK_ORIGIN_PID', 'UNBLOCK_PORT', 'UNBLOCK_AUTH']) delete env[name]
    const child = spawn(process.execPath, [cli, ...args], { env })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill(), 20000)
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c })
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

test('validateScope accepts 1-3 well-formed KPIs and rejects anything else', () => {
  assert.deepEqual(validateScope({ ...scope, kpis: [kpi('reply-rate', { window_days: 14 })] }), [])
  for (const bad of [
    [kpi('a'), kpi('b'), kpi('c'), kpi('d')],
    [],
    [{ ...kpi('a'), target: undefined }],
    [kpi('a', { direction: 'above' })],
    [kpi('Bad Id')],
    [kpi('a'), kpi('a')],
    [kpi('a', { window_days: 0 })],
  ]) assert.ok(validateScope({ ...scope, kpis: bad }).length > 0, JSON.stringify(bad))
})

test('PUT kpis stores them with window_days 14 by default, refuses 4 KPIs and a missing target', async () => {
  const h = await startScopeHarness(scope)
  try {
    const put = (kpis) => h.request('/api/scope/recruiter-messages/kpis', { method: 'PUT', headers: h.bearer, body: { kpis } })
    const four = await put([kpi('a'), kpi('b'), kpi('c'), kpi('d')])
    assert.equal(four.status, 400, four.text)
    assert.match(four.json.error, /1 to 3/)
    const missing = await put([{ ...kpi('a'), target: undefined }])
    assert.equal(missing.status, 400, missing.text)
    assert.match(missing.json.error, /target/)
    const ok = await put([kpi('reply-rate'), kpi('errors', { direction: 'at_most', target: 5, source: 'reports', window_days: 30 })])
    assert.equal(ok.status, 200, ok.text)
    const stored = JSON.parse(readFileSync(join(process.env.UNBLOCK_SCOPING_DIR, 'recruiter-messages', 'scope.json'), 'utf8'))
    assert.deepEqual(stored.kpis.map((k) => [k.id, k.window_days]), [['reply-rate', 14], ['errors', 30]])
    assert.deepEqual(validateScope(stored), [])
    const read = await h.request('/api/scope/recruiter-messages', { headers: h.bearer })
    assert.deepEqual(read.json.scope.kpis.map((k) => k.id), ['reply-rate', 'errors'])
  } finally { await h.close() }
})

test('unblock scope kpi set and list round-trip; a bad file is refused with the reason', async () => {
  const h = await startScopeHarness(scope)
  try {
    const file = join(process.env.UNBLOCK_SCOPING_DIR, '..', 'kpis.json')
    writeFileSync(file, JSON.stringify([kpi('reply-rate', { name: 'Reply rate' })]))
    const set = await run(['scope', 'kpi', 'recruiter-messages', 'set', '--from', file])
    assert.equal(set.status, 0, set.stderr)
    const list = await run(['scope', 'kpi', 'recruiter-messages', 'list', '--json'])
    assert.equal(list.status, 0, list.stderr)
    assert.deepEqual(JSON.parse(list.stdout).kpis, [{ ...kpi('reply-rate', { name: 'Reply rate' }), window_days: 14 }])
    const text = await run(['scope', 'kpi', 'recruiter-messages', 'list'])
    assert.match(text.stdout, /reply-rate\s+Reply rate\s+at_least 60\s+admin-feed\s+14d/)
    writeFileSync(file, JSON.stringify([kpi('a'), kpi('b'), kpi('c'), kpi('d')]))
    const refused = await run(['scope', 'kpi', 'recruiter-messages', 'set', '--from', file])
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /1 to 3/)
  } finally { await h.close() }
})
