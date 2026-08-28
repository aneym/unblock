import test from 'node:test'
import assert from 'node:assert/strict'

import { buildDeck, groupOf, isShort, projectCounts, selectDeck, sortAsks } from '../src/queue-model.js'

let clock = 1_000
const ask = (ticket, overrides = {}) => ({
  ticket,
  status: 'open',
  gating: false,
  created_at: (clock += 1000),
  fields: [{ name: 'pick', type: 'choice', required: true, choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
  answers: {},
  origin: {},
  ...overrides,
})

const long = (ticket, overrides = {}) =>
  ask(ticket, { fields: [{ name: 'note', type: 'text', required: true }], ...overrides })

test('groupOf prefers the declared project, then origin, then a fallback', () => {
  assert.equal(groupOf(ask('a', { project: 'homebase', origin: { workspace_name: 'ws' } })), 'homebase')
  assert.equal(groupOf(ask('b', { origin: { workspace_name: 'ws' } })), 'ws')
  assert.equal(groupOf(ask('c', { origin: { repo: 'unblock' } })), 'unblock')
  assert.equal(groupOf(ask('d', { origin: { cwd: '/Volumes/x/repos/personal/unblock' } })), 'unblock')
  assert.equal(groupOf(ask('e', { origin: { agent: 'hermes' } })), 'hermes')
  assert.equal(groupOf(ask('f')), 'elsewhere')
})

test('sortAsks puts gating first and detected last, oldest first within each', () => {
  const input = [
    ask('detected', { origin: { detected: true }, created_at: 1 }),
    ask('filed-new', { created_at: 30 }),
    ask('gating-new', { gating: true, created_at: 20 }),
    ask('filed-old', { created_at: 10 }),
    ask('gating-old', { gating: true, created_at: 5 }),
  ]
  assert.deepEqual(sortAsks(input).map((item) => item.ticket), [
    'gating-old', 'gating-new', 'filed-old', 'filed-new', 'detected',
  ])
})

test('isShort admits only tap-sized, non-gating asks', () => {
  assert.equal(isShort(ask('choice')), true)
  assert.equal(isShort(ask('confirm', { fields: [{ name: 'ok', type: 'confirm' }] })), true)
  assert.equal(isShort(long('text')), false, 'free text needs the full card')
  assert.equal(isShort(ask('gating', { gating: true })), false, 'an agent is stopped on it')
  assert.equal(isShort(ask('stepped', { steps: ['open the console'] })), false)
  assert.equal(isShort(ask('secret', { fields: [{ name: 'key', type: 'secret' }] })), false)
  assert.equal(isShort(ask('answered', { answers: { pick: 'a' } })), false, 'nothing left to ask')
  assert.equal(
    isShort(ask('three', { fields: [
      { name: 'a', type: 'confirm' }, { name: 'b', type: 'confirm' }, { name: 'c', type: 'confirm' },
    ] })),
    false,
    'three questions is a full card',
  )
})

test('buildDeck pools short same-project asks and leaves everything else alone', () => {
  const deck = buildDeck([
    ask('s1', { project: 'p' }),
    ask('s2', { project: 'p' }),
    ask('other', { project: 'q' }),
    long('big', { project: 'p' }),
  ])
  assert.deepEqual(deck.map((item) => item.asks.map((a) => a.ticket)), [['s1', 's2'], ['other'], ['big']])
  // A lone short ask still rides the tap-sized card; it just has one row.
  assert.deepEqual(deck.map((item) => item.grouped), [true, true, false])
  assert.equal(deck[0].project, 'p')
})

test('buildDeck caps a group at 3 asks and 4 open fields', () => {
  const many = ['a', 'b', 'c', 'd'].map((t) => ask(t, { project: 'p' }))
  assert.deepEqual(
    buildDeck(many).map((item) => item.asks.length),
    [3, 1],
    'a fourth short ask starts a new card',
  )

  const wide = [
    ask('w1', { project: 'p', fields: [{ name: 'a', type: 'confirm' }, { name: 'b', type: 'confirm' }] }),
    ask('w2', { project: 'p', fields: [{ name: 'c', type: 'confirm' }, { name: 'd', type: 'confirm' }] }),
    ask('w3', { project: 'p' }),
  ]
  assert.deepEqual(
    buildDeck(wide).map((item) => item.asks.map((a) => a.ticket)),
    [['w1', 'w2'], ['w3']],
    'four fields is the ceiling regardless of ask count',
  )
})

test('projectCounts ranks by volume, then alphabetically', () => {
  const counts = projectCounts([
    ask('1', { project: 'zed' }),
    ask('2', { project: 'alpha' }),
    ask('3', { project: 'alpha' }),
    ask('4', { project: 'beta' }),
  ])
  assert.deepEqual(counts, [['alpha', 2], ['beta', 1], ['zed', 1]])
})

test('selectDeck filters to one project and reports it back', () => {
  const asks = [long('a', { project: 'sfp' }), long('b', { project: 'hiring' })]
  const result = selectDeck({ asks, project: 'sfp' })
  assert.equal(result.activeProject, 'sfp')
  assert.equal(result.remaining, 1)
  assert.equal(result.current.asks[0].ticket, 'a')
})

test('a filter naming a project with nothing open falls back to everything', () => {
  const asks = [long('a', { project: 'sfp' })]
  const result = selectDeck({ asks, project: 'gone' })
  assert.equal(result.activeProject, null)
  assert.equal(result.remaining, 1)
})

test('a pinned ask sets the project instead of being smuggled past the filter', () => {
  // The regression: the picker said sfp-application while a hiring-theory card
  // sat on screen, because the pin prepended itself to a filtered deck.
  const asks = [long('sfp1', { project: 'sfp' }), long('hire1', { project: 'hiring' }), long('hire2', { project: 'hiring' })]
  const result = selectDeck({ asks, project: 'sfp', pinnedTicket: 'hire1' })
  assert.equal(result.activeProject, 'hiring', 'the picker must name what is on screen')
  assert.equal(result.current.asks[0].ticket, 'hire1', 'the pinned ask leads')
  assert.deepEqual(result.items.map((item) => item.key), ['hire1', 'hire2'])
  assert.ok(!result.items.some((item) => item.asks.some((a) => a.ticket === 'sfp1')))
})

test('a stale pin is ignored once its ask is gone', () => {
  const asks = [long('a', { project: 'sfp' })]
  const result = selectDeck({ asks, project: 'sfp', pinnedTicket: 'answered-already' })
  assert.equal(result.activeProject, 'sfp')
  assert.equal(result.current.asks[0].ticket, 'a')
})

test('skipped cards go to the back, in the order they were skipped', () => {
  const asks = [long('a'), long('b'), long('c')]
  const result = selectDeck({ asks, deferredKeys: ['a', 'b'] })
  assert.deepEqual(result.items.map((item) => item.key), ['c', 'a', 'b'])
})

test('answered-this-session asks leave immediately, before the server agrees', () => {
  const asks = [long('a'), long('b')]
  const result = selectDeck({ asks, doneTickets: new Set(['a']) })
  assert.equal(result.remaining, 1)
  assert.equal(result.current.asks[0].ticket, 'b')
  assert.deepEqual(result.projects.map(([name]) => name), ['elsewhere'])
})

test('only open asks reach the deck', () => {
  const asks = [long('a', { status: 'answered' }), long('b', { status: 'collected' }), long('c')]
  const result = selectDeck({ asks })
  assert.equal(result.remaining, 1)
  assert.equal(result.current.asks[0].ticket, 'c')
})

test('an empty queue selects nothing without throwing', () => {
  const result = selectDeck({ asks: [] })
  assert.equal(result.current, undefined)
  assert.equal(result.remaining, 0)
  assert.deepEqual(result.projects, [])
  assert.equal(result.activeProject, null)
})
