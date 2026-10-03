// Owner: Opus (explainers lane for w5H:p0M, 2026-10-03). Implementers make it pass and never edit it.
// Alex (2026-10-03): big empty gaps around demos. A demo's stage height came only from the fence's `height`, while the
// demo itself is often shorter. Contract: a demo may report its own content height with
// {type: 'rails-demo/size', v: 1, h: <px>} (rails-demo/1, same plain-object validation as the other messages). The
// page sizes that demo's stage to h, clamped to 160..2400 px; the fence height is only the placeholder until then.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readDemoMessage } from '../src/demo-host.js'

test('a size message reads as the demo content height, clamped to 160..2400', () => {
  assert.deepEqual(readDemoMessage({ type: 'rails-demo/size', v: 1, h: 520 }), { type: 'rails-demo/size', v: 1, h: 520 })
  assert.equal(readDemoMessage({ type: 'rails-demo/size', v: 1, h: 519.6 }).h, 520, 'whole pixels')
  assert.equal(readDemoMessage({ type: 'rails-demo/size', v: 1, h: 40 }).h, 160)
  assert.equal(readDemoMessage({ type: 'rails-demo/size', v: 1, h: 90000 }).h, 2400)
})

test('a size message that is not a plain rails-demo/1 object with a finite positive h is ignored', () => {
  for (const bad of [
    { type: 'rails-demo/size', v: 2, h: 520 },
    { type: 'rails-demo/size', h: 520 },
    { type: 'rails-demo/size', v: 1 },
    { type: 'rails-demo/size', v: 1, h: '520' },
    { type: 'rails-demo/size', v: 1, h: Number.NaN },
    { type: 'rails-demo/size', v: 1, h: Infinity },
    { type: 'rails-demo/size', v: 1, h: 0 },
    { type: 'rails-demo/size', v: 1, h: -5 },
    [{ type: 'rails-demo/size', v: 1, h: 520 }],
    Object.assign(Object.create({ evil: true }), { type: 'rails-demo/size', v: 1, h: 520 }),
  ]) assert.equal(readDemoMessage(bad), null, JSON.stringify(bad))
})
