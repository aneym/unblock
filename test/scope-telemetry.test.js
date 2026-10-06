// Scenario for the comment-latency freeze telemetry piece (written by Opus; the implementer may not edit it).
// The scope page beacons a compact summary of its own load to the daemon, which appends it to
// scope-telemetry.jsonl under its state dir. Over 16 KB is refused; a stranger is refused.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const initial = { slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', updated_at: new Date().toISOString(), plan_md: 'Initial plan' }
const report = { v: 1, reason: 'pagehide', since_load_ms: 61000, mode: 'events', doc_rendered_ms: 1234, composer_ready_ms: 1300,
  longtasks: { n: 1, total_ms: 2500, max_ms: 2500, top: [{ at: 3000, dur: 2500, attr: 'self' }] } }

test('the scope page telemetry lands in the daemon jsonl and oversize or stranger posts do not', async () => {
  const h = await startScopeHarness(initial)
  const file = join(process.env.UNBLOCK_STATE_DIR, 'scope-telemetry.jsonl')
  try {
    const ok = await h.request('/api/scope/demo/telemetry', { method: 'POST', headers: { ...human, 'User-Agent': 'Scenario UA' }, body: report })
    assert.equal(ok.status, 204, ok.text)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].slug, 'demo')
    assert.equal(lines[0].ua, 'Scenario UA')
    assert.deepEqual(lines[0].report, report)
    assert.ok(!Number.isNaN(Date.parse(lines[0].at)))

    const big = await h.request('/api/scope/demo/telemetry', { method: 'POST', headers: human, body: { ...report, pad: 'x'.repeat(16 * 1024) } })
    assert.equal(big.status, 413)
    const stranger = await h.request('/api/scope/demo/telemetry', { method: 'POST', body: report })
    assert.ok([401, 403].includes(stranger.status), String(stranger.status))
    const missing = await h.request('/api/scope/nope/telemetry', { method: 'POST', headers: human, body: report })
    assert.equal(missing.status, 404)
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1)
  } finally {
    await h.close()
  }
})
