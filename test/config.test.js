import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  applyConfig,
  daemonRoot,
  normalizeAllowedUsers,
  normalizePublicOrigin,
  normalizeTrustedProxy,
  readConfig,
} from '../src/config.js'

const dir = mkdtempSync(join(tmpdir(), 'unblock-config-'))
const file = join(dir, 'config.json')
test.after(() => rmSync(dir, { recursive: true, force: true }))

test('a public origin is one https URL with a hostname and nothing else', () => {
  assert.equal(normalizePublicOrigin('https://studio.tailf266ac.ts.net:8797'), 'https://studio.tailf266ac.ts.net:8797')
  assert.equal(normalizePublicOrigin('https://studio.tailf266ac.ts.net:8797/'), 'https://studio.tailf266ac.ts.net:8797')
  assert.equal(normalizePublicOrigin('http://127.0.0.1:4488'), 'http://127.0.0.1:4488')
  for (const bad of [
    'http://studio.tailf266ac.ts.net:8797', // plaintext off loopback
    'https://*.ts.net', // wildcard
    '*',
    'https://',
    'studio.tailf266ac.ts.net:8797', // no scheme
    'https://studio.tailf266ac.ts.net:8797/u/', // path
    'https://studio.tailf266ac.ts.net:8797?x=1',
    'https://user:pw@studio.tailf266ac.ts.net',
    'https://a.example, https://b.example',
    '',
    null,
    42,
  ]) {
    assert.equal(normalizePublicOrigin(bad), null, `accepted ${JSON.stringify(bad)}`)
  }
})

test('only tailscale is a known trusted proxy', () => {
  assert.equal(normalizeTrustedProxy('tailscale'), 'tailscale')
  assert.equal(normalizeTrustedProxy('nginx'), null)
  assert.equal(normalizeTrustedProxy('*'), null)
})

test('allowed users accept a list or a comma string, never a wildcard', () => {
  assert.equal(normalizeAllowedUsers(['a@example.com', ' b@example.com ']), 'a@example.com,b@example.com')
  assert.equal(normalizeAllowedUsers('a@example.com,b@example.com'), 'a@example.com,b@example.com')
  assert.equal(normalizeAllowedUsers(['*']), null)
  assert.equal(normalizeAllowedUsers(['not-an-email']), null)
  assert.equal(normalizeAllowedUsers([]), null)
})

test('the file fills unset variables and the environment wins', () => {
  writeFileSync(
    file,
    JSON.stringify({
      public_origin: 'https://studio.tailf266ac.ts.net:8797/',
      trusted_proxy: 'tailscale',
      allowed_users: ['a.neyman17@gmail.com'],
      port: 4488,
    }),
  )
  const env = {}
  const first = applyConfig({ env, path: file })
  assert.equal(first.present, true)
  assert.deepEqual(first.applied.sort(), [
    'UNBLOCK_ALLOWED_USERS',
    'UNBLOCK_PORT',
    'UNBLOCK_PUBLIC_ORIGIN',
    'UNBLOCK_TRUSTED_PROXY',
  ])
  assert.equal(env.UNBLOCK_PUBLIC_ORIGIN, 'https://studio.tailf266ac.ts.net:8797')
  assert.equal(env.UNBLOCK_PORT, '4488')

  const pinned = { UNBLOCK_PUBLIC_ORIGIN: 'http://127.0.0.1:4488', UNBLOCK_PORT: '0' }
  const second = applyConfig({ env: pinned, path: file })
  assert.equal(pinned.UNBLOCK_PUBLIC_ORIGIN, 'http://127.0.0.1:4488')
  assert.equal(pinned.UNBLOCK_PORT, '0')
  assert.deepEqual(second.applied.sort(), ['UNBLOCK_ALLOWED_USERS', 'UNBLOCK_TRUSTED_PROXY'])
})

test('an invalid origin in the file is dropped rather than half-applied', () => {
  writeFileSync(file, JSON.stringify({ public_origin: 'https://*.ts.net', trusted_proxy: 'tailscale' }))
  const env = {}
  const result = applyConfig({ env, path: file })
  assert.equal(env.UNBLOCK_PUBLIC_ORIGIN, undefined)
  assert.deepEqual(result.applied, ['UNBLOCK_TRUSTED_PROXY'])
})

test('a missing or corrupt file is an empty config, not a crash', () => {
  assert.deepEqual(readConfig(join(dir, 'nope.json')), {})
  writeFileSync(file, '{not json')
  assert.deepEqual(readConfig(file), {})
  const env = {}
  assert.equal(applyConfig({ env, path: file }).applied.length, 0)
})

test('daemonRoot only points at a checkout that has a daemon to run', () => {
  const root = join(dir, 'checkout')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(file, JSON.stringify({ root }))
  assert.equal(daemonRoot({ path: file }), null)
  writeFileSync(join(root, 'src', 'daemon.js'), '')
  assert.equal(daemonRoot({ path: file }), root)
  writeFileSync(file, JSON.stringify({}))
  assert.equal(daemonRoot({ path: file }), null)
})
