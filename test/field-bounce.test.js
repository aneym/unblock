import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Store } from '../src/store.js'
import { validateAsk, normalizeOrigin } from '../src/schema.js'

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'unblock-test-'))
  const dbPath = join(dir, 'queue.db')
  const store = new Store(dbPath)
  return { store, dbPath, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const decisionAsk = () =>
  validateAsk({
    kind: 'park',
    purpose: 'decision',
    title: 'Grill round',
    why: 'Three decisions shape the plan.',
    fields: [
      {
        name: 'strategy',
        type: 'choice',
        choices: ['expand', 'big_bang'],
        recommend: { value: 'expand', why: 'reversible' },
      },
      { name: 'name', type: 'text', recommend: { value: 'x', why: 'short' } },
      { name: 'scope', type: 'text', recommend: { value: 'small', why: 'ships' }, must_decide: true },
    ],
  })

test('a bounced field counts as answered and carries its note to the agent', () => {
  const { store, cleanup } = freshStore()
  try {
    const ask = store.create(decisionAsk(), normalizeOrigin({ agent: 'test' }))
    const result = store.answer(
      ask.ticket,
      { strategy: 'expand', name: 'thing' },
      { fieldBounce: { scope: 'wrong framing', ghost: 'unknown field is dropped' } },
    )
    assert.equal(result.complete, true)
    assert.deepEqual(result.ask.answers.scope, { $bounce: 'wrong framing' })
    assert.equal('ghost' in result.ask.answers, false)
    assert.equal(result.ask.status, 'answered')
  } finally {
    cleanup()
  }
})

test('a bounce with an empty note stores the bare sentinel', () => {
  const { store, cleanup } = freshStore()
  try {
    const ask = store.create(decisionAsk(), normalizeOrigin({ agent: 'test' }))
    const result = store.answer(
      ask.ticket,
      { strategy: 'expand', name: 'thing' },
      { fieldBounce: { scope: '  ' } },
    )
    assert.deepEqual(result.ask.answers.scope, { $bounce: true })
    assert.equal(result.complete, true)
  } finally {
    cleanup()
  }
})

test('bouncing a secret field never stores the typed value', () => {
  const { store, cleanup } = freshStore()
  try {
    const ask = store.create(
      validateAsk({
        kind: 'file',
        title: 'Key needed',
        why: 'Deploy is blocked on the API key.',
        fields: [{ name: 'api_key', type: 'secret' }],
      }),
      normalizeOrigin({ agent: 'test' }),
    )
    // The client sends the raw value alongside the bounce by mistake; the
    // store must record only the sentinel.
    const result = store.answer(ask.ticket, { api_key: 'raw-secret' }, { fieldBounce: { api_key: 'wrong ask' } })
    assert.deepEqual(result.ask.answers.api_key, { $bounce: 'wrong ask' })
    assert.equal(JSON.stringify(result.ask).includes('raw-secret'), false)
  } finally {
    cleanup()
  }
})

test('a whole-ask bounce works without a note', () => {
  const { store, cleanup } = freshStore()
  try {
    const ask = store.create(decisionAsk(), normalizeOrigin({ agent: 'test' }))
    const bounced = store.bounce(ask.ticket, undefined)
    assert.equal(bounced.status, 'bounced')
    assert.equal(bounced.reply, undefined)
  } finally {
    cleanup()
  }
})

test('the reply drafts under __reply__ and hydrates back as draft_reply', () => {
  const { store, cleanup } = freshStore()
  try {
    const ask = store.create(decisionAsk(), normalizeOrigin({ agent: 'test' }))
    let updated = store.saveDraft(ask.ticket, { name: 'half' }, undefined, 'also check X')
    assert.equal(updated.draft_reply, 'also check X')
    assert.equal(updated.draft.name, 'half')
    assert.equal('__reply__' in updated.draft, false)
    assert.ok(updated.draft_updated_at > 0)
    updated = store.saveDraft(ask.ticket, {}, undefined, '')
    assert.equal(updated.draft_reply, undefined)
  } finally {
    cleanup()
  }
})

test('sweep prunes closed asks older than 30 days but keeps recent ones', () => {
  const { store, dbPath, cleanup } = freshStore()
  try {
    const oldAsk = store.create(decisionAsk(), normalizeOrigin({ agent: 'old' }))
    store.cancel(oldAsk.ticket)
    // Backdate it past the retention window through a second connection.
    const raw = new DatabaseSync(dbPath)
    raw.prepare('UPDATE asks SET closed_at = ? WHERE ticket = ?')
      .run(Date.now() - 31 * 24 * 60 * 60 * 1000, oldAsk.ticket)
    raw.close()
    const freshAsk = store.create(decisionAsk(), normalizeOrigin({ agent: 'fresh' }))
    store.cancel(freshAsk.ticket)
    store.sweep()
    assert.equal(store.get(oldAsk.ticket), null)
    assert.ok(store.get(freshAsk.ticket))
  } finally {
    cleanup()
  }
})
