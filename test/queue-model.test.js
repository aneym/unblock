import test from 'node:test'
import assert from 'node:assert/strict'
import { applyKey, initialValues, missingFor, redactValue, sortAsks } from '../plugin/queue-model.js'

const ask = (ticket, created_at, options = {}) => ({
  ticket,
  created_at,
  gating: false,
  origin: {},
  ...options,
})

test('sortAsks orders gating, filed, then detected, oldest within groups', () => {
  const input = [
    ask('detected-new', '2026-01-06', { gating: true, origin: { detected: true } }),
    ask('filed-new', '2026-01-05'),
    ask('gating-new', '2026-01-04', { gating: true }),
    ask('detected-old', '2026-01-03', { origin: { detected: true } }),
    ask('filed-old', '2026-01-02'),
    ask('gating-old', '2026-01-01', { gating: true }),
  ]
  assert.deepEqual(sortAsks(input).map((item) => item.ticket), [
    'gating-old', 'gating-new', 'filed-old', 'filed-new', 'detected-old', 'detected-new',
  ])
  assert.deepEqual(input.map((item) => item.ticket), [
    'detected-new', 'filed-new', 'gating-new', 'detected-old', 'filed-old', 'gating-old',
  ])
})

test('missingFor covers all field types and already-answered fields', () => {
  const item = {
    fields: [
      { name: 'text', type: 'text', required: true },
      { name: 'secret', type: 'secret', required: true },
      { name: 'choice', type: 'choice', required: true },
      { name: 'confirm', type: 'confirm', required: true },
      { name: 'paste', type: 'paste', required: true },
      { name: 'optional', type: 'text', required: false },
      { name: 'answered', type: 'text', required: true },
    ],
    answers: { answered: 'stored' },
  }
  assert.deepEqual(missingFor(item, {
    text: '', secret: null, choice: [], confirm: false, paste: undefined,
  }), ['text', 'secret', 'choice', 'confirm', 'paste'])
  assert.deepEqual(missingFor(item, {
    text: 'ok', secret: 'token', choice: 'a', confirm: true, paste: 'output',
  }), [])
})

test('initialValues excludes secrets and redactValue labels choices', () => {
  const item = {
    fields: [{ name: 'token', type: 'secret' }, { name: 'mode', type: 'choice', choices: [{ value: 'a', label: 'Alpha' }] }],
    draft: { token: 'hidden', mode: 'a' },
  }
  assert.deepEqual(initialValues(item), { mode: 'a' })
  assert.equal(redactValue(item.fields[0], 'abc'), '•••')
  assert.equal(redactValue(item.fields[1], 'a'), 'Alpha')
})

test('applyKey types and backspaces', () => {
  const field = { type: 'text' }
  const start = { value: 'a' }
  const typed = applyKey(start, { name: 'b', sequence: 'b', ctrl: false, meta: false }, field)
  assert.deepEqual(typed, { value: 'ab' })
  assert.deepEqual(applyKey(typed, { name: 'backspace', sequence: '\x7f' }, field), { value: 'a' })
  assert.strictEqual(applyKey(start, { name: 'up', sequence: '\x1b[A' }, field), start)
})

test('applyKey moves choice selection with arrows and digits', () => {
  const field = { type: 'choice', choices: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] }
  assert.deepEqual(applyKey({ value: 'a' }, { name: 'right' }, field), { value: 'b' })
  assert.deepEqual(applyKey({ value: 'a' }, { name: 'left' }, field), { value: 'c' })
  assert.deepEqual(applyKey({ value: 'a' }, { name: '2', sequence: '2' }, field), { value: 'b' })
})

test('applyKey toggles confirm with space', () => {
  const start = { value: false }
  assert.deepEqual(applyKey(start, { name: 'space', sequence: ' ' }, { type: 'confirm' }), { value: true })
  assert.strictEqual(applyKey(start, { name: 'x', sequence: 'x' }, { type: 'confirm' }), start)
})
