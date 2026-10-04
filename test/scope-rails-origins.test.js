import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyConfig } from '../src/config.js'
import { embedBridgeScript } from '../src/demo-host.js'

test('embedBridgeScript embeds a parent origin with a single script closer', () => {
  const html = embedBridgeScript(['https://a.example'])
  assert.equal(html.match(/<\/script>/g).length, 1)
})

test('applyConfig keeps UNBLOCK_RAILS_ORIGINS when the environment already set it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'unblock-rails-origins-')), 'config.json')
  writeFileSync(path, JSON.stringify({ rails_origins: ['https://file.example'] }))
  const env = { UNBLOCK_RAILS_ORIGINS: 'https://kept.example' }
  applyConfig({ env, path })
  assert.equal(env.UNBLOCK_RAILS_ORIGINS, 'https://kept.example')
})

test('a comma-separated rails_origins string normalizes like an array', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'unblock-rails-origins-')), 'config.json')
  writeFileSync(path, JSON.stringify({ rails_origins: 'https://a.example, https://b.example/, http://plain.example' }))
  const env = {}
  applyConfig({ env, path })
  assert.equal(env.UNBLOCK_RAILS_ORIGINS, 'https://a.example,https://b.example')
})
