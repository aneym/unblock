import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateAsk, normalizeOrigin } from '../src/schema.js'
import { Store } from '../src/store.js'

const ask = (over = {}) => ({
  title: 'Something',
  why: 'It unblocks the thing.',
  fields: [{ name: 'a', type: 'text' }],
  ...over,
})

/*
 * The blocker/decision line, enforced rather than trusted.
 *
 * Blocker = the agent knows what should happen but cannot do it, so it needs
 * an ACTION only the human can perform. Decision = the agent does not know and
 * should not guess, so it needs JUDGEMENT and owes a recommendation.
 */

test('a blocker made only of choices is rejected', () => {
  // Enumerating the options means the agent knows the option space, so it can
  // recommend one — which makes it a decision, not a blocker.
  assert.throws(
    () =>
      validateAsk(
        ask({
          purpose: 'blocker',
          fields: [{ name: 'pick', type: 'choice', choices: ['a', 'b'] }],
        }),
      ),
    /cannot be only choices/,
  )
})

test('a blocker asking for a value the agent cannot know is accepted', () => {
  // "What is your staging hostname" is a real blocker: the answer exists, the
  // agent has no way to reach it, and there is nothing to recommend.
  const out = validateAsk(
    ask({ purpose: 'blocker', fields: [{ name: 'host', type: 'text', label: 'Staging hostname' }] }),
  )
  assert.equal(out.purpose, 'blocker')
})

test('a blocker asking for an action is accepted', () => {
  for (const type of ['secret', 'confirm']) {
    const out = validateAsk(ask({ purpose: 'blocker', fields: [{ name: 'f', type }] }))
    assert.equal(out.purpose, 'blocker')
  }
  const paste = validateAsk(
    ask({ purpose: 'blocker', fields: [{ name: 'f', type: 'paste', command: 'ls' }] }),
  )
  assert.equal(paste.fields[0].command, 'ls')
})

test('a blocker field may not carry a recommendation', () => {
  assert.throws(
    () =>
      validateAsk(
        ask({
          purpose: 'blocker',
          fields: [
            { name: 'done', type: 'confirm' },
            { name: 'note', type: 'text', recommend: { value: 'x', why: 'y' } },
          ],
        }),
      ),
    /cannot carry a recommendation/,
  )
})

test('every decision field needs a recommendation', () => {
  assert.throws(
    () =>
      validateAsk(
        ask({ purpose: 'decision', fields: [{ name: 'p', type: 'choice', choices: ['a', 'b'] }] }),
      ),
    /needs recommend/,
  )
})

test('a recommended choice must name a declared option', () => {
  assert.throws(
    () =>
      validateAsk(
        ask({
          purpose: 'decision',
          fields: [
            {
              name: 'p',
              type: 'choice',
              choices: ['a', 'b'],
              // The one-tap path. A recommendation nobody can select would
              // silently break accept-all.
              recommend: { value: 'not-an-option', why: 'r' },
            },
          ],
        }),
      ),
    /must be one of the declared choices/,
  )
})

test('a decision may not ask for a secret or a paste', () => {
  for (const type of ['secret', 'paste']) {
    assert.throws(
      () =>
        validateAsk(
          ask({
            purpose: 'decision',
            fields: [{ name: 'f', type, command: 'ls', recommend: { value: 'x', why: 'y' } }],
          }),
        ),
      /cannot ask for a/,
      type,
    )
  }
})

test('at most 3 must_decide fields', () => {
  const field = (n) => ({
    name: `f${n}`,
    type: 'choice',
    choices: ['a', 'b'],
    recommend: { value: 'a', why: 'r' },
    must_decide: true,
  })
  assert.doesNotThrow(() =>
    validateAsk(ask({ purpose: 'decision', fields: [field(1), field(2), field(3)] })),
  )
  assert.throws(
    () => validateAsk(ask({ purpose: 'decision', fields: [1, 2, 3, 4].map(field) })),
    /at most 3 must_decide/,
  )
})

test('purpose and the free-text reply survive a round trip', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'unblock-purpose-')), 'queue.db'))
  const origin = normalizeOrigin({ agent: 'claude', session_id: 's1' })

  const created = store.create(
    validateAsk(
      ask({
        purpose: 'decision',
        title: 'Pick a strategy',
        fields: [
          {
            name: 'p',
            type: 'choice',
            choices: ['a', 'b'],
            recommend: { value: 'a', why: 'reversible' },
          },
        ],
      }),
    ),
    origin,
  )
  // purpose validated but never reached SQLite once; every ask came back a
  // blocker. Assert the column, not just the validator.
  assert.equal(created.purpose, 'decision')
  assert.equal(created.fields[0].recommend.value, 'a')

  const { complete, ask: answered } = store.answer(created.ticket, { p: 'b' }, { reply: 'went the other way' })
  assert.equal(complete, true)
  assert.equal(answered.purpose, 'decision')
  assert.equal(answered.answers.p, 'b')
  assert.equal(answered.reply, 'went the other way')

  store.close()
})
