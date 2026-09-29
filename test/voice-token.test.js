import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startDaemon, loadOrCreateSecret } from '../src/daemon.js'
import { mintVoiceToken, mintXaiToken } from '../src/voice-token.js'
import { VOICE_SYSTEM_PROMPT, VOICE_TOOLS } from '../src/voice.js'

test('mint locks the Live setup and carries the key only in a header', async () => {
  const key = 'test-only-value'
  let request
  let receivedRef
  const token = await mintVoiceToken({
    keyRef: 'configured-voice-key', readKey: async (ref) => { receivedRef = ref; return key }, now: () => 1_000_000, model: 'gemini-test-live', voice: 'Kore',
    fetch: async (url, options) => { request = { url, ...options }; return { ok: true, json: async () => ({ name: 'auth_tokens/one' }) } },
  })
  assert.equal(receivedRef, 'configured-voice-key')
  assert.equal(token.token, 'auth_tokens/one')
  assert.equal(token.provider, 'gemini')
  assert.equal(token.voice, 'Kore')
  assert.equal(token.expires_at, new Date(1_120_000).toISOString())
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens')
  assert.equal(request.headers['x-goog-api-key'], key)
  assert.equal(request.url.includes(key), false)
  const body = JSON.parse(request.body)
  assert.equal(body.uses, 1)
  assert.equal(body.expireTime, new Date(2_800_000).toISOString())
  assert.equal(body.bidiGenerateContentSetup.model, 'models/gemini-test-live')
  assert.deepEqual(body.bidiGenerateContentSetup.generationConfig.responseModalities, ['AUDIO'])
  assert.equal(body.bidiGenerateContentSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore')
  assert.equal(body.bidiGenerateContentSetup.systemInstruction.parts[0].text, VOICE_SYSTEM_PROMPT)
  assert.deepEqual(body.bidiGenerateContentSetup.tools[0].functionDeclarations, VOICE_TOOLS)
  for (const field of ['model', 'generationConfig.responseModalities', 'generationConfig.speechConfig', 'systemInstruction.role', 'systemInstruction.parts', 'tools.0', 'inputAudioTranscription', 'outputAudioTranscription']) {
    // The SDK's shallow mask uses each immediate child key; arrays expose their index.
    if (field === 'tools.0') assert.ok(body.fieldMask.includes('tools.0'))
    else assert.ok(body.fieldMask.split(',').includes(field), field)
  }
  assert.equal(request.body.includes(key), false)
})

test('missing voice key is a distinct error without network access', async () => {
  await assert.rejects(mintVoiceToken({ readKey: async () => '', fetch: async () => { throw new Error('must not call fetch') } }), { code: 'VOICE_NOT_CONFIGURED' })
})

test('xAI client secret uses bearer authorization and never leaks the key in errors', async () => {
  const key = 'test-only-key'
  let request
  const token = await mintXaiToken({ readKey: async (ref, env) => { assert.equal(ref, 'xai-api-key'); assert.equal(env, 'XAI_API_KEY'); return key }, fetch: async (url, options) => {
    request = { url, ...options }
    return { ok: true, json: async () => ({ value: 'secret-value', expires_at: 180 }) }
  } })
  assert.deepEqual(token, { provider: 'xai', token: 'secret-value', model: 'grok-voice-think-fast-2.0', voice: 'eve', expires_at: new Date(180_000).toISOString() })
  assert.equal(request.url, 'https://api.x.ai/v1/realtime/client_secrets')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, `Bearer ${key}`)
  assert.deepEqual(JSON.parse(request.body), { expires_after: { seconds: 120 } })
  assert.equal(request.body.includes(key), false)
  for (const response of [{ ok: false }, { ok: true, json: async () => ({}) }]) {
    await assert.rejects(mintXaiToken({ readKey: async () => key, fetch: async () => response }), (error) => !error.message.includes(key) && /unavailable/.test(error.message))
  }
})

test('authenticated daemon voice session returns 503 when no key is configured', async () => {
  const state = mkdtempSync(join(tmpdir(), 'unblock-voice-route-'))
  const names = ['UNBLOCK_STATE_DIR', 'UNBLOCK_CONFIG_DIR', 'UNBLOCK_VOICE_KEY_REF', 'UNBLOCK_XAI_KEY_REF', 'UNBLOCK_PUBLIC_ORIGIN', 'UNBLOCK_TRUSTED_PROXY', 'UNBLOCK_ALLOWED_USERS', 'GEMINI_API_KEY', 'XAI_API_KEY']
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  Object.assign(process.env, {
    UNBLOCK_STATE_DIR: state,
    UNBLOCK_CONFIG_DIR: state,
    UNBLOCK_VOICE_KEY_REF: 'unblock-voice-test-nonexistent-ref',
    UNBLOCK_XAI_KEY_REF: 'unblock-xai-test-nonexistent-ref',
    UNBLOCK_PUBLIC_ORIGIN: 'https://studio.tailnet.test:8797',
    UNBLOCK_TRUSTED_PROXY: 'tailscale',
    UNBLOCK_ALLOWED_USERS: 'alex@example.test',
  })
  delete process.env.GEMINI_API_KEY
  delete process.env.XAI_API_KEY
  let daemon
  try {
    daemon = await startDaemon({ port: 0 })
    const url = `http://127.0.0.1:${daemon.port}/api/voice/session`
    const unauthorized = await fetch(url, { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    const bearer = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${loadOrCreateSecret()}` } })
    assert.equal(bearer.status, 403)
    assert.equal((await bearer.json()).code, 'HUMAN_ONLY')
    const human = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: daemon.port, path: '/api/voice/session', method: 'POST', headers: {
        Host: 'studio.tailnet.test:8797', 'tailscale-user-login': 'alex@example.test',
      } }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, cache: res.headers['cache-control'], body: JSON.parse(Buffer.concat(chunks).toString()) }))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(human.status, 503)
    assert.equal(human.cache, 'no-store')
    assert.equal(human.body.code, 'VOICE_NOT_CONFIGURED')
  } finally {
    if (daemon) await daemon.close()
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(state, { recursive: true, force: true })
  }
})
