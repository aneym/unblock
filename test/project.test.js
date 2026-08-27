import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateAsk } from '../src/schema.js'
import { Store } from '../src/store.js'

const raw = (overrides = {}) => ({
  kind: 'file',
  title: 'Need the staging hostname',
  why: 'Deploy config needs it before anything can ship.',
  fields: [{ name: 'hostname', type: 'text', label: 'Hostname' }],
  ...overrides,
})

const origin = (agent = 'claude') => ({ agent, session_id: `s-${agent}` })

test('validateAsk passes project through, scrubbed and trimmed', () => {
  assert.equal(validateAsk(raw({ project: '  homebase\n' })).project, 'homebase')
  assert.equal(validateAsk(raw()).project, undefined)
  assert.equal(validateAsk(raw({ project: '' })).project, undefined)
  assert.throws(() => validateAsk(raw({ project: 'x'.repeat(65) })), /at most 64/)
})

test('store persists project and filters the list by it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unblock-project-'))
  const store = new Store(join(dir, 'queue.db'))
  try {
    const a = store.create(validateAsk(raw({ project: 'homebase' })), origin('one'))
    const b = store.create(validateAsk(raw({ project: 'night-vision' })), origin('two'))
    const c = store.create(validateAsk(raw()), origin('three'))

    assert.equal(a.project, 'homebase')
    assert.equal(store.get(b.ticket).project, 'night-vision')
    assert.equal(c.project, undefined)

    assert.deepEqual(store.list({ project: 'homebase' }).map((ask) => ask.ticket), [a.ticket])
    assert.equal(store.list().length, 3)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
