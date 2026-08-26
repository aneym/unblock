import assert from 'node:assert/strict'
import test from 'node:test'

import { missingRequired } from '../src/schema.js'

// An explicit skip (null) is a real response: it completes a required field
// without supplying a value. Untouched (undefined) still holds the ask open.
const ask = {
  fields: [
    { name: 'strategy', type: 'choice', required: true },
    { name: 'notes', type: 'text', required: true },
    { name: 'extra', type: 'text', required: false },
  ],
}

test('an untouched required field is missing', () => {
  assert.deepEqual(missingRequired(ask, {}), ['strategy', 'notes'])
})

test('an explicitly skipped required field is answered', () => {
  assert.deepEqual(missingRequired(ask, { strategy: null, notes: 'done' }), [])
})

test('empty strings and empty selections still count as missing', () => {
  assert.deepEqual(missingRequired(ask, { strategy: [], notes: '   ' }), ['strategy', 'notes'])
})

test('an "other" free-text choice answer satisfies the field', () => {
  assert.deepEqual(
    missingRequired(ask, { strategy: 'my own third option', notes: null }),
    [],
  )
})
