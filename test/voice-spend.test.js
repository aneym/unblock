import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpendLedger, rateFor } from '../src/voice-spend.js'

test('reservations enforce the monthly cap and settlement bills whole minutes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-spend-'))
  const file = join(dir, 'ledger.json')
  try {
    const ledger = createSpendLedger({ file, capUsd: 1, maxMinutes: 15, now: () => Date.parse('2026-09-29T23:00:00Z') })
    assert.equal(rateFor('unknown'), 0.10)
    assert.equal(rateFor('gpt-realtime-2.1'), 0.10)
    assert.equal(rateFor('gpt-realtime-2.1-mini'), 0.04)
    const a = ledger.reserve({ provider: 'xai', model: 'grok-voice-think-fast-2.0' })
    assert.equal(a.max_minutes, 12)
    assert.deepEqual(ledger.status(), { spent_usd: 0.96, cap_usd: 1, period: '2026-09' })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.throws(() => ledger.reserve({ provider: 'xai', model: 'grok-voice-latest' }), { code: 'VOICE_SPEND_CAP' })
    assert.equal(ledger.get(a.session_id).settled, false)
    assert.equal(ledger.get('unknown'), undefined)
    assert.equal(ledger.settle(a.session_id, 61), true)
    assert.equal(ledger.get(a.session_id).charged_usd, 0.16)
    assert.equal(ledger.get(a.session_id).provider, 'xai')
    assert.equal(ledger.get(a.session_id).model, 'grok-voice-think-fast-2.0')
    assert.equal(ledger.get(a.session_id).settled, true)
    assert.equal(ledger.settle(a.session_id, 80), false)
    assert.equal(ledger.settle('unknown', 2), false)
    assert.equal(ledger.status().spent_usd, 0.16)
    const b = ledger.reserve({ provider: 'gemini', model: 'gemini-3.8-live' })
    assert.equal(b.max_minutes, 15)
    assert.equal(ledger.status().spent_usd, 0.46)
    assert.equal(ledger.settle(b.session_id, 20_000), true)
    assert.equal(ledger.status().spent_usd, 0.46)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the default ledger has no cap and keeps metering past $20', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-spend-'))
  const file = join(dir, 'ledger.json')
  try {
    const ledger = createSpendLedger({ file, maxMinutes: 15, now: () => Date.parse('2026-09-29T23:00:00Z') })
    for (let count = 1; count <= 20; count++) {
      const reservation = ledger.reserve({ provider: 'openai', model: 'gpt-realtime-2.1' })
      assert.equal(reservation.max_minutes, 15)
      assert.deepEqual(ledger.status(), { spent_usd: count * 1.5, cap_usd: null, period: '2026-09' })
      assert.equal(ledger.settle(reservation.session_id, 15 * 60), true)
      assert.equal(ledger.status().spent_usd, count * 1.5)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('corrupt ledger starts empty and UTC month rollover discards older periods', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-spend-'))
  const file = join(dir, 'ledger.json')
  let time = Date.parse('2026-09-30T23:59:00Z')
  try {
    writeFileSync(file, '{broken')
    const ledger = createSpendLedger({ file, capUsd: 1, maxMinutes: 2, now: () => time })
    assert.equal(ledger.status().spent_usd, 0)
    ledger.reserve({ provider: 'xai', model: 'grok-voice-latest' })
    time = Date.parse('2026-10-01T00:00:00Z')
    assert.deepEqual(ledger.status(), { spent_usd: 0, cap_usd: 1, period: '2026-10' })
    ledger.reserve({ provider: 'xai', model: 'grok-voice-latest' })
    time = Date.parse('2026-11-01T00:00:00Z')
    ledger.reserve({ provider: 'xai', model: 'grok-voice-latest' })
    assert.deepEqual(JSON.parse(readFileSync(file)).sessions.map((session) => session.period), ['2026-10', '2026-11'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
