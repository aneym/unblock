// Owner: Opus (demo-system lane, 2026-10-01). Implementers make it pass and never edit it.
// Alex (2026-10-01 17:01 ET): "i also wanna be able to puase a demo ... and leave timestamped comments and highllight
// parts of it, all in a system that we build that actually works seemlessly."
// The demo player (agent-rails tools/demo-kit, protocol rails-demo/1) posts a note to the scope page; the page files
// it as a scope comment on the demo's caption with the moment (t), the step, the highlighted region and a frame shot.
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAnchor } from '../src/scope-anchor.js'
import { readDemoMessage, demoNote, demoPins } from '../src/demo-host.js'
import { human, startScopeHarness } from './scope-harness.js'

const cap = { section: 'try', quote: 'Sending a shortlist', prefix: '', suffix: '.' }

test('anchors keep a demo moment, its step and a highlighted region; junk is dropped', () => {
  const a = normalizeAnchor({ ...cap, t: 12.34, step: 2, region: { x: 0.1234, y: 0.5, w: 0.25, h: 0.3 } })
  assert.equal(a.t, 12.3)
  assert.equal(a.step, 2)
  assert.deepEqual(a.region, { x: 0.123, y: 0.5, w: 0.25, h: 0.3 })
  const clamped = normalizeAnchor({ ...cap, t: 1, region: { x: 0.9, y: -0.2, w: 0.5, h: 2 } })
  assert.deepEqual(clamped.region, { x: 0.9, y: 0, w: 0.1, h: 1 })
  for (const region of [{ x: 'a', y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 0.5 }, [1, 2, 3, 4], null])
    assert.ok(!('region' in normalizeAnchor({ ...cap, t: 1, region })), JSON.stringify(region))
  for (const step of [-1, 1.5, 'x', 1000])
    assert.ok(!('step' in normalizeAnchor({ ...cap, t: 1, step })), String(step))
  assert.ok(!('region' in normalizeAnchor({ ...cap, region: { x: 0, y: 0, w: 1, h: 1 } })), 'a region needs a moment')
})

test('the page reads only well-formed player messages', () => {
  const note = { type: 'rails-demo/note', v: 1, id: 'n-1', t: 8.25, step: 1, caption: 'Open the role.', region: { x: 0.2, y: 0.1, w: 0.3, h: 0.2 }, text: '  This list needs a filter  ', shot: 'data:image/png;base64,iVBORw0KGgo=' }
  const read = readDemoMessage(note)
  assert.equal(read.type, 'rails-demo/note')
  assert.equal(read.text, 'This list needs a filter')
  assert.equal(read.t, 8.3)
  assert.equal(readDemoMessage({ ...note, v: 2 }), null)
  assert.equal(readDemoMessage({ ...note, text: '   ' }), null)
  assert.equal(readDemoMessage({ ...note, text: 'x'.repeat(4001) }), null)
  assert.equal(readDemoMessage({ ...note, t: Infinity }), null)
  assert.equal(readDemoMessage({ ...note, shot: 'javascript:alert(1)' }).shot, null)
  assert.equal(readDemoMessage({ demo: 'ran' }), null)
  assert.equal(readDemoMessage('rails-demo/note'), null)
  const ready = readDemoMessage({ type: 'rails-demo/ready', v: 1, title: 'Shortlist', duration: 15, steps: [{ start: 0, caption: 'a' }], demo: { unit: 'recruiter/roles/list', sha: 'a'.repeat(40), run: 'r1' } })
  assert.equal(ready.duration, 15)
  assert.deepEqual(ready.demo, { unit: 'recruiter/roles/list', sha: 'a'.repeat(40), run: 'r1' })
})

test('a demo note becomes a comment on the caption with its moment, step, region and shot', async () => {
  const msg = readDemoMessage({ type: 'rails-demo/note', v: 1, id: 'n-2', t: 4.04, step: 1, caption: 'Open the role.', region: { x: 0.2, y: 0.1, w: 0.3, h: 0.2 }, text: 'Make the row taller', shot: null })
  const { anchor, text } = demoNote(msg, cap)
  assert.deepEqual(anchor, { ...cap, t: 4, step: 1, region: { x: 0.2, y: 0.1, w: 0.3, h: 0.2 } })
  assert.equal(text, 'Make the row taller')

  const v2 = { version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: '2026-10-01T21:00:00Z',
    doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A page.' }, { id: 'try', heading: 'Try it', body_md: 'Words.\n\nFigure: Sending a shortlist.' }] }, threads: [] }
  const h = await startScopeHarness(v2)
  try {
    const made = await h.request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor, text, client_id: 'demo-n-2' } })
    assert.equal(made.status, 201, made.text)
    assert.deepEqual(made.json.thread.anchor.region, { x: 0.2, y: 0.1, w: 0.3, h: 0.2 })
    assert.equal(made.json.thread.anchor.step, 1)
    const scope = (await h.request('/api/scope/demo', { headers: human })).json.scope
    const pins = demoPins(scope.threads, cap)
    assert.deepEqual(pins, { type: 'rails-demo/notes', v: 1, notes: [{ id: made.json.thread.id, t: 4, region: { x: 0.2, y: 0.1, w: 0.3, h: 0.2 }, text: 'Make the row taller', author: 'Alex', resolved: false }] })
    assert.deepEqual(demoPins(scope.threads, { ...cap, quote: 'Another figure' }).notes, [])
  } finally { await h.close() }
})
