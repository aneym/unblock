// Owner: Opus (fix-seat-authority, 2026-10-07). Implementers make it pass and never edit it.
// Under an owner steer that lets agents decide, a lane records its own scope approval:
// `unblock scope approve <slug> --by agent --approver <pane> --reason "<why>" --steer <file>`.
// The record says by 'agent' (never Alex), names the approving pane, its reason and the steer file it cites,
// and every reader counts it as approved. It quotes no one. The banner says it was an agent decision.
// Regression: before this, the schema accepted only by 'alex', so a hand-written agent record made the page
// report "invalid approval" and factory-grant refused the scope.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateScope } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-01T15:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first.' },
]
const scopeWith = (slug) => ({ version: 2, slug, title: 'Demo scope', pane: 'w5H:pT1', revision: 7, updated_at: at, doc: { sections }, threads: [] })

function cliFor(h) {
  return (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args],
      { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('an agent records its own approval under a steer; readers count it, it never claims Alex', async () => {
  const h = await startScopeHarness(scopeWith('agentdemo'))
  const cli = cliFor(h)
  const get = async () => (await h.request('/api/scope/agentdemo', { headers: human })).json.scope
  const steer = join(mkdtempSync(join(tmpdir(), 'agent-approve-steer-')), 'speed-order.md')
  writeFileSync(steer, '# Steer\nAgents adopt scopes themselves.\n')
  const REASON = 'Speed order: agents decide; open questions take the recommendation'
  const base = ['scope', 'approve', 'agentdemo', '--by', 'agent']
  try {
    // 1. Every field is required, the steer must exist, and an agent approval quotes no one.
    assert.notEqual((await cli(...base, '--reason', REASON, '--steer', steer)).status, 0, '--approver is required')
    assert.notEqual((await cli(...base, '--approver', 'w5H:pT9', '--steer', steer)).status, 0, '--reason is required')
    assert.notEqual((await cli(...base, '--approver', 'w5H:pT9', '--reason', REASON)).status, 0, '--steer is required')
    assert.notEqual((await cli(...base, '--approver', 'w5H:pT9', '--reason', REASON, '--steer', steer + '.missing')).status, 0, 'the steer file must exist')
    assert.notEqual((await cli(...base, '--approver', 'not a pane', '--reason', REASON, '--steer', steer)).status, 0, 'the approver is a pane id')
    assert.notEqual((await cli(...base, '--approver', 'w5H:pT9', '--reason', REASON, '--steer', steer, '--quote', 'yes')).status, 0, 'no quote')
    assert.equal((await get()).approval, undefined)

    // 2. Record it.
    const ok = await cli(...base, '--approver', 'w5H:pT9', '--reason', REASON, '--steer', steer)
    assert.equal(ok.status, 0, ok.stderr)
    const a = (await get()).approval
    assert.equal(a.mode, 'approve', 'readers count approve as approved')
    assert.equal(a.by, 'agent')
    assert.equal(a.via, 'agent')
    assert.equal(a.approver, 'w5H:pT9')
    assert.equal(a.reason, REASON)
    assert.equal(a.steer, steer)
    assert.equal(a.quote, undefined)
    assert.equal(a.revision, 7)
    assert.deepEqual(validateScope(await get()), [], 'the page no longer reports invalid approval')
    const md = readFileSync(join(process.env.UNBLOCK_SCOPING_DIR, 'agentdemo', 'APPROVAL.md'), 'utf8')
    assert.match(md, /agent decision/)
    assert.ok(md.includes(steer) && md.includes(REASON) && md.includes('w5H:pT9'))

    // 3. The banner says an agent decided, which pane, and the steer.
    const { approvalBannerHtml } = await import('../web/src/scope/approval-banner.js')
    const text = approvalBannerHtml(a).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    assert.match(text, /Approved by an agent \(w5H:pT9\)/)
    assert.match(text, /not Alex/)
    assert.doesNotMatch(text, /Approved by Alex/)

    // 4. Unapprove takes it back like any other approval.
    assert.equal((await cli('scope', 'unapprove', 'agentdemo', '--reason', 'steer withdrawn')).status, 0)
    assert.equal((await get()).approval, undefined)
  } finally { await h.close() }
})

test('the schema never lets an agent record pass as Alex or skip its steer', () => {
  const scope = scopeWith('schema')
  const agent = { mode: 'approve', by: 'agent', who: 'agent:w5H:pT9', at, at_et: 'Oct 1, 11:00 AM ET', revision: 7, comment: 'why',
    reason: 'why', approver: 'w5H:pT9', steer: '/tmp/steer.md', via: 'agent' }
  assert.deepEqual(validateScope({ ...scope, approval: agent }), [])
  for (const broken of [
    { ...agent, mode: 'approve_with_changes' },
    { ...agent, steer: 'relative/steer.md' },
    { ...agent, steer: undefined },
    { ...agent, reason: '  ' },
    { ...agent, approver: 'alex' },
    { ...agent, via: 'admin' },
    { ...agent, quote: 'ok' },
    { ...agent, by: 'nate' },
  ]) assert.ok(validateScope({ ...scope, approval: broken }).includes('invalid approval'), JSON.stringify(broken))
})
