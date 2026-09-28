import test from 'node:test'
import assert from 'node:assert/strict'

import { hideProducts, projectCounts, sortAsks } from '../src/queue-model.js'

let clock = 1_000
const ask = (ticket, project, overrides = {}) => ({
  ticket,
  project,
  status: 'open',
  gating: false,
  created_at: (clock += 1000),
  fields: [],
  origin: {},
  ...overrides,
})

const queue = [
  ask('rails-1', 'agent-rails'),
  ask('home-1', 'homebase'),
  ask('ci-1', 'rails-ci'),
  ask('home-2', 'homebase', { gating: true }),
  ask('rails-2', 'agent-rails'),
]

test('unchecking homebase leaves every other product, in queue order', () => {
  const shown = hideProducts(sortAsks(queue), ['homebase'])
  assert.deepEqual(shown.map((item) => item.ticket), ['rails-1', 'ci-1', 'rails-2'])
})

test('nothing hidden shows the whole queue, and the input is not mutated', () => {
  const before = queue.map((item) => item.ticket)
  assert.deepEqual(hideProducts(queue, []).map((item) => item.ticket), before)
  assert.deepEqual(hideProducts(queue, new Set()).map((item) => item.ticket), before)
  assert.deepEqual(queue.map((item) => item.ticket), before)
})

test('hiding a product that has no asks changes nothing', () => {
  assert.equal(hideProducts(queue, ['frank']).length, queue.length)
})

test('a product is matched by the same name the list shows, including origin fallbacks', () => {
  const fromOrigin = ask('cwd-1', undefined, { origin: { cwd: '/Volumes/StudioExt/repos/homebase' } })
  const shown = hideProducts([...queue, fromOrigin], new Set(['homebase']))
  assert.ok(!shown.some((item) => item.ticket === 'cwd-1'))
})

test('the product list still names a hidden product so it can be checked again', () => {
  const names = projectCounts(queue).map(([name]) => name)
  assert.ok(names.includes('homebase'))
})
