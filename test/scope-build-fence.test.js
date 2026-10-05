// Alex (2026-10-05 ~10:12 ET): "make this a shared component, graph based ... and a time estimation that shows
// total time expected. when we review, we see at the top the expected time and the result time so we can see for issues."
// Through the daemon: a ```build fence is linted on write (cycles, unknown deps), the doc's estimate rows come back
// read-only from ESTIMATES.jsonl, and the page shows the longest-path total and says when a piece ran past its p90.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { markdown } from '../web/src/scope/markdown.ts'
import { buildStrip, setBuildEstimates } from '../web/src/scope/build.ts'
import { human, startScopeHarness } from './scope-harness.js'

const initial = {
  version: 2, slug: 'plan', title: 'Plan scope', pane: 'w5H:pT1', revision: 1, updated_at: '2026-10-05T14:00:00Z',
  doc: { sections: [{ id: 'title', heading: 'Plan scope', body_md: 'A small page.' }, { id: 'build', heading: 'How it gets built', body_md: 'Words for now.' }] }, threads: [],
}
const fence = body => 'One wave, then the scenario.\n\n```build\n' + JSON.stringify(body, null, 2) + '\n```'
const piece = (id, deps, p50_min, p90_min) => ({ id, label: `Piece ${id}`, deps, p50_min, p90_min, runs_on: 'Studio' })
// A and C start at once; B waits on A. By p50 the longest path is C then the scenario (30 + 5 = 35);
// by p90 it is A, B, scenario (20 + 40 + 10 = 70), so the total is not one path's p50 and p90.
const plan = { pieces: [piece('A', [], 10, 20), piece('B', ['A'], 5, 40), piece('C', [], 30, 35)], scenario: { label: 'Scenario on main', p50_min: 5, p90_min: 10, runs_on: 'Studio' } }

test('build fences lint on write, read actuals from the estimates file, and show expected against actual', async () => {
  const estimates = join(mkdtempSync(join(tmpdir(), 'unblock-estimates-')), 'ESTIMATES.jsonl')
  writeFileSync(estimates, [
    { scope: 'plan', piece: 'A', p50_min: 10, p90_min: 20, rev: 1 },
    { scope: 'other', piece: 'A', actual_min: 999 },
    'not json',
    { scope: 'plan', piece: 'A', sub: 'a1', actual_min: 12 },
    { scope: 'plan', piece: 'A', sub: 'a2', actual_min: 26 },
  ].map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
  process.env.UNBLOCK_ESTIMATES_FILE = estimates
  const h = await startScopeHarness(initial)
  const put = body_md => h.request('/api/scope/plan/doc', { method: 'PUT', headers: h.bearer, body: { sections: [initial.doc.sections[0], { id: 'build', heading: 'How it gets built', body_md }] } })
  const read = async () => (await h.request('/api/scope/plan', { headers: human })).json
  try {
    for (const [bad, error] of [
      [{ pieces: [piece('A', ['B'], 5, 10), piece('B', ['A'], 5, 10)] }, /dependency cycle A → B → A/],
      [{ pieces: [piece('A', ['Z'], 5, 10)] }, /unknown piece Z/],
      [{ pieces: [piece('A', [], 30, 10)] }, /p50_min is above p90_min/],
      [{ pieces: [] }, /non-empty "pieces"/],
    ]) {
      const refused = await put(fence(bad))
      assert.equal(refused.status, 400, JSON.stringify(bad)); assert.match(refused.json.error, error)
    }
    assert.equal((await put('```build\n{ not json\n```')).status, 400)
    assert.equal((await read()).estimates, undefined, 'a doc with no build fence carries no estimate rows')

    assert.equal((await put(fence(plan))).status, 200)
    const payload = await read()
    assert.deepEqual(payload.estimates.map(row => row.actual_min ?? null), [null, 12, 26], 'only this scope, torn lines skipped')
    setBuildEstimates(payload.estimates)
    const sections = payload.scope.doc.sections
    const html = markdown(sections.find(s => s.id === 'build').body_md, payload.scope.doc.assets, '/assets')
    assert.equal((html.match(/class="build-node/g) || []).length, 4)
    assert.match(html, /35–70 min<\/span> along the longest path, C → scenario/)
    // A merged in two sub-PRs: it is done when the second lands, 26 min against a 20 min p90.
    assert.match(html, /data-piece="A"[^>]*>.*?Took 26 min<\/span><span class="build-over">6 min over its p90<\/span>/)
    const strip = buildStrip(sections).replace(/<[^>]+>/g, '')
    assert.equal(strip, 'Expected 35–70 min·Actual 1 of 4 pieces in·1 piece over p90')

    writeFileSync(estimates, ['A', 'B', 'C', 'scenario'].map((id, n) => JSON.stringify({ scope: 'plan', piece: id, actual_min: [26, 40, 20, 12][n] })).join('\n'))
    setBuildEstimates((await read()).estimates)
    // Actual wall clock is the longest path through actuals: A, B, scenario = 26 + 40 + 12 = 78, past the 70 min p90.
    assert.equal(buildStrip(sections).replace(/<[^>]+>/g, ''), 'Expected 35–70 min·Actual 78 min, 8 min over the p90')
  } finally { delete process.env.UNBLOCK_ESTIMATES_FILE; await h.close() }
})
