// The Studio daemon's file-backed secret store (headless/secrets.js), run
// against the real agent-secret in a throwaway HOME with dummy values.
// Skipped where agent-secret is not installed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const installed = join(homedir(), '.local', 'bin', 'agent-secret')
const home = mkdtempSync(join(tmpdir(), 'unblock-headless-'))
const bin = join(home, '.local', 'bin', 'agent-secret')
const real = `${bin}.real`
const dir = join(home, '.agent-rails', 'custody', 'agent-secret')
const skip = existsSync(installed) ? false : 'agent-secret is not installed'

let SecretStore
if (!skip) {
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  copyFileSync(installed, real)
  process.env.HOME = home
  ;({ SecretStore } = await import('../headless/secrets.js'))
}
test.after(() => rmSync(home, { recursive: true, force: true }))

// agent-secret as installed, or with one step sabotaged by a shell prefix.
function wrap(prefix = '') {
  writeFileSync(bin, `#!/bin/sh\n${prefix}exec ${real} "$@"\n`)
  chmodSync(bin, 0o755)
}
const withWrapper = async (prefix, run) => { wrap(prefix); try { return await run() } finally { wrap() } }
const store = () => { wrap(); mkdirSync(dir, { recursive: true, mode: 0o700 }); return new SecretStore() }

test('stores each attempt under its own private 128-bit ref and deletes it', { skip }, async () => {
  const secrets = store()
  const record = await secrets.put({ name: 'api_key', value: 'dummy-1', ticket: 'ub_test01' })
  assert.match(record.ref, /^ub_test01-api_key-[0-9a-f]{32}$/)
  assert.equal(statSync(join(dir, record.ref)).mode & 0o777, 0o600)
  assert.equal(await secrets.reveal(record), 'dummy-1')
  assert.equal(await secrets.delete(record), true)
  assert.equal(existsSync(join(dir, record.ref)), false)
  assert.equal(await secrets.delete(record), true, 'already gone counts as gone')
})

test('delete keeps anything it cannot confirm gone queued', { skip }, async () => {
  const secrets = store()
  const ref = `ub_test02-dir-${'0'.repeat(32)}`
  mkdirSync(join(dir, ref))
  assert.equal(await secrets.delete({ store: 'file', ref }), false, 'not a plain file')
  for (const record of [{ store: 'keychain', ref: 'x' }, { store: 'op', ref: 'op://v/i/credential' }, { store: 'file', ref: '../escape' }, null]) {
    assert.equal(await secrets.delete(record), false, JSON.stringify(record))
  }
  const missing = { store: 'file', ref: `ub_test03-k-${'0'.repeat(32)}` }
  const away = `${dir}.away`
  await withWrapper('[ "$1" = rm ] && exit 1\n', async () => {
    renameSync(dir, away)
    try { assert.equal(await secrets.delete(missing), false, 'store unavailable') } finally { renameSync(away, dir) }
  })
  const moved = { store: 'file', ref: `ub_test04-k-${'1'.repeat(32)}` }
  writeFileSync(join(dir, moved.ref), 'dummy-4', { mode: 0o600 })
  // The populated store moves away just before rm, which then recreates an empty one.
  await withWrapper(`[ "$1" = rm ] && mv ${dir} ${away}\n`, async () => {
    try { assert.equal(await secrets.delete(moved), false, 'store moved away') } finally { rmSync(dir, { recursive: true, force: true }); renameSync(away, dir) }
  })
})

test('a failed put leaves no value behind', { skip }, async () => {
  const secrets = store()
  for (const [prefix, why] of [
    ['[ "$1" = get ] && exit 1\n', 'read-back failed'],
    [`if [ "$1" = put ]; then ${real} "$@"; exit 1; fi\n`, 'put wrote, then failed'],
  ]) {
    const before = readdirSync(dir).length
    await withWrapper(prefix, () => assert.rejects(secrets.put({ name: 'k', value: 'dummy-5', ticket: 'ub_test05' })))
    assert.equal(readdirSync(dir).length, before, why)
  }
})
