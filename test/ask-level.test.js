// Scenario for daily-workflow slice 1 (agent-rails docs/prd/daily-workflow/PRD.md):
// every ask carries a level (P1 to P4) and a project, and the queue sorts by level,
// then project order, then oldest. "Same level, project decides": a P1 from Poker
// sits above a P2 from Recruiter, which sits above a P2 from Poker.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateAsk, validateUpdate } from '../src/schema.js'
import { Store } from '../src/store.js'

const qm = await import('../src/queue-model.js')

const raw = (overrides = {}) => ({
  kind: 'file',
  title: 'Need the staging hostname',
  why: 'Deploy config needs it before anything can ship.',
  only_you: 'credential',
  tried: ['Checked the CLI and API; neither can reach the vault for this value.'],
  fields: [{ name: 'hostname', type: 'text', label: 'Hostname' }],
  ...overrides,
})

const origin = (agent) => ({ agent, session_id: `s-${agent}` })

test('an explicit level is kept, and anything but P1 to P4 is refused', () => {
  for (const level of ['P1', 'P2', 'P3', 'P4']) assert.equal(validateAsk(raw({ level })).level, level)
  assert.throws(() => validateAsk(raw({ level: 'P5' })), /level/)
  assert.throws(() => validateAsk(raw({ level: 'high' })), /level/)
})

test('an ask without a level gets one from what it is', () => {
  assert.equal(typeof qm.levelOf, 'function', 'queue-model exports levelOf')
  // A real person or money is waiting.
  assert.equal(qm.levelOf({ purpose: 'message' }), 'P1')
  assert.equal(qm.levelOf({ purpose: 'spend' }), 'P1')
  // Holds up a lane.
  assert.equal(qm.levelOf({ purpose: 'blocker' }), 'P2')
  assert.equal(qm.levelOf({ purpose: 'decision', blocks: 'the Recruiter invites lane' }), 'P2')
  assert.equal(qm.levelOf({ purpose: 'question', gating: true }), 'P2')
  // Decide when it suits you.
  assert.equal(qm.levelOf({ purpose: 'decision' }), 'P4')
  // An explicit level wins.
  assert.equal(qm.levelOf({ purpose: 'message', level: 'P3' }), 'P3')
  // validateAsk fills the same default in.
  assert.equal(validateAsk(raw()).level, 'P2')
})

test('project names map onto the owner project order', () => {
  assert.equal(typeof qm.projectRank, 'function', 'queue-model exports projectRank')
  const r = (project) => qm.projectRank(project)
  assert.ok(r('Recruiter') < r('closer'))
  assert.ok(r('recruiter-linkedin') === r('Recruiter'))
  assert.ok(r('chord') === r('Recruiter'), 'Chord recruiting ranks as Recruiter')
  assert.ok(r('closer') < r('agent-rails'))
  assert.ok(r('rails-admin') === r('agent-rails'))
  assert.ok(r('agent-rails') < r('poker'))
  assert.ok(r('poker') < r('night-vision'), 'an unlisted project comes after every listed one')
  assert.ok(r(undefined) === r('night-vision'))
  // The order is a seam: a different order changes the ranking.
  const order = qm.parseProjectOrder('Poker=poker;Recruiter=recruiter,chord')
  assert.ok(qm.projectRank('poker', order) < qm.projectRank('chord', order))
})

test('Same level, project decides: the queue reads Poker P1, Recruiter P2, Poker P2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unblock-level-'))
  const store = new Store(join(dir, 'queue.db'))
  try {
    const pokerP2 = store.create(validateAsk(raw({ project: 'poker', level: 'P2', title: 'Price the new drill pack' })), origin('poker'))
    const recruiterP2 = store.create(validateAsk(raw({ project: 'recruiter', level: 'P2', title: 'Turn on LinkedIn tracking' })), origin('recruiter'))
    const pokerP1 = store.create(validateAsk(raw({ project: 'poker', level: 'P1', title: 'Payments are down' })), origin('poker-2'))
    const railsP4 = store.create(validateAsk(raw({ project: 'agent-rails', level: 'P4', title: 'Name the new tab' })), origin('rails'))

    assert.equal(store.get(pokerP1.ticket).level, 'P1', 'the store keeps the level')
    const order = qm.sortAsks(store.list()).map((ask) => ask.ticket)
    assert.deepEqual(order, [pokerP1.ticket, recruiterP2.ticket, pokerP2.ticket, railsP4.ticket])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('revising an ask keeps its level, and a revision can change it', () => {
  const ask = { ...validateAsk(raw({ level: 'P3' })), ticket: 't1', revision: 1 }
  assert.equal(validateUpdate(ask, { why: 'Still needed before the deploy can go out.' }).level, 'P3')
  assert.equal(validateUpdate(ask, { level: 'P1' }).level, 'P1')
})
