import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startDaemon, loadOrCreateSecret } from '../src/daemon.js'
import { mintVoiceToken, mintXaiToken, mintOpenAiToken } from '../src/voice-token.js'
import { VOICE_SYSTEM_PROMPT, VOICE_TOOLS } from '../src/voice.js'
import { SCOPE_VOICE_PROMPT, SCOPE_VOICE_TOOLS } from '../src/scope-voice.js'

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
  assert.equal(body.fieldMask, 'model,generationConfig,systemInstruction,tools,inputAudioTranscription,outputAudioTranscription')
  assert.equal(request.body.includes(key), false)
})

test('extended-thinking Live setup declares a thinking level and non-blocking tools', async () => {
  const setups = []
  for (const model of ['gemini-3.8-live-extended-thinking', 'gemini-3.8-live']) {
    await mintVoiceToken({ model, readKey: async () => 'test-only-value', fetch: async (_url, options) => {
      setups.push(JSON.parse(options.body).bidiGenerateContentSetup)
      return { ok: true, json: async () => ({ name: 'auth_tokens/one' }) }
    } })
  }
  assert.deepEqual(setups[0].generationConfig.thinkingConfig, { thinkingLevel: 'LOW' })
  assert.ok(setups[0].tools[0].functionDeclarations.every((tool) => tool.behavior === 'NON_BLOCKING'))
  assert.equal(setups[1].generationConfig.thinkingConfig, undefined)
  assert.deepEqual(setups[1].tools[0].functionDeclarations, VOICE_TOOLS)
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
  const names = ['UNBLOCK_STATE_DIR', 'UNBLOCK_CONFIG_DIR', 'UNBLOCK_VOICE_KEY_REF', 'UNBLOCK_XAI_KEY_REF', 'UNBLOCK_OPENAI_KEY_REF', 'OPENAI_API_KEY', 'UNBLOCK_PUBLIC_ORIGIN', 'UNBLOCK_TRUSTED_PROXY', 'UNBLOCK_ALLOWED_USERS', 'GEMINI_API_KEY', 'XAI_API_KEY']
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  Object.assign(process.env, {
    UNBLOCK_STATE_DIR: state,
    UNBLOCK_CONFIG_DIR: state,
    UNBLOCK_VOICE_KEY_REF: 'unblock-voice-test-nonexistent-ref',
    UNBLOCK_XAI_KEY_REF: 'unblock-xai-test-nonexistent-ref',
    UNBLOCK_OPENAI_KEY_REF: 'unblock-openai-test-nonexistent-ref',
    UNBLOCK_PUBLIC_ORIGIN: 'https://studio.tailnet.test:8797',
    UNBLOCK_TRUSTED_PROXY: 'tailscale',
    UNBLOCK_ALLOWED_USERS: 'alex@example.test',
  })
  delete process.env.GEMINI_API_KEY
  delete process.env.XAI_API_KEY
  delete process.env.OPENAI_API_KEY
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

// The provider pins these declarations: queue tools cannot handle scoping calls.
test('scoping token pins the scoping prompt and tools', async () => {
  let setup
  await mintVoiceToken({
    prompt: SCOPE_VOICE_PROMPT, tools: SCOPE_VOICE_TOOLS,
    model: 'gemini-3.8-live-extended-thinking', readKey: async () => 'test-only-value',
    fetch: async (_url, options) => {
      setup = JSON.parse(options.body).bidiGenerateContentSetup
      return { ok: true, json: async () => ({ name: 'auth_tokens/scope' }) }
    },
  })
  assert.equal(setup.systemInstruction.parts[0].text, SCOPE_VOICE_PROMPT)
  assert.deepEqual(setup.tools[0].functionDeclarations.map((tool) => tool.name),
    ['next_question', 'previous_question', 'read_thread', 'next_section', 'previous_section', 'go_to_section', 'show_resolved', 'scroll', 'explain', 'note_lane', 'answer', 'take_recommendation', 'reject', 'park', 'confirm', 'cancel', 'resolve', 'comment', 'reply', 'set_speed', 'end_call'])
  assert.ok(setup.tools[0].functionDeclarations.every((tool) => tool.behavior === 'NON_BLOCKING'))
})

test('Gemini locks a brisk instruction into queue and scope tokens only above normal speed', async () => {
  for (const prompt of [VOICE_SYSTEM_PROMPT, SCOPE_VOICE_PROMPT]) {
    for (const speed of [1, 1.5]) {
      let setup
      await mintVoiceToken({ prompt, speed, readKey: async () => 'test-only-value', fetch: async (_url, options) => {
        setup = JSON.parse(options.body).bidiGenerateContentSetup
        return { ok: true, json: async () => ({ name: 'auth_tokens/brisk' }) }
      } })
      assert.equal(setup.systemInstruction.parts[0].text, prompt + (speed > 1 ? '\nSpeak quickly, at a brisk pace, with no pauses between sentences.' : ''))
    }
  }
})

test('OpenAI mint pins the realtime session and sanitizes every service failure', async () => {
  const key = 'fake-openai-test-key'
  let request
  const token = await mintOpenAiToken({ readKey: async (ref, env) => {
    assert.equal(ref, 'openai-rails-voice-prod')
    assert.equal(env, 'OPENAI_API_KEY')
    return key
  }, fetch: async (url, options) => {
    request = { url, ...options }
    return { ok: true, json: async () => ({ value: 'fake-client-token', expires_at: 180 }) }
  } })
  assert.deepEqual(token, { provider: 'openai', token: 'fake-client-token', model: 'gpt-realtime-2.1', voice: 'marin', expires_at: new Date(180_000).toISOString() })
  assert.equal(request.url, 'https://api.openai.com/v1/realtime/client_secrets')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, `Bearer ${key}`)
  assert.deepEqual(JSON.parse(request.body), { expires_after: { anchor: 'created_at', seconds: 120 }, session: { type: 'realtime', model: 'gpt-realtime-2.1', audio: { output: { voice: 'marin' } } } })
  assert.equal(request.body.includes(key), false)
  await assert.rejects(mintOpenAiToken({ readKey: async () => '', fetch: async () => { throw new Error('must not fetch') } }), { code: 'VOICE_NOT_CONFIGURED' })
  for (const fetch of [async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({}) }), async () => { throw new Error(key) }]) {
    await assert.rejects(mintOpenAiToken({ readKey: async () => key, fetch }), { message: 'Voice token service unavailable' })
  }
  await assert.rejects(mintOpenAiToken({ readKey: async () => { throw new Error(key) } }), { message: 'Voice token service unavailable' })
})

test('daemon defaults to OpenAI and records sanitized settled session metrics once', async () => {
  const state = mkdtempSync(join(tmpdir(), 'unblock-openai-route-'))
  const names = ['UNBLOCK_STATE_DIR', 'UNBLOCK_CONFIG_DIR', 'UNBLOCK_VOICE_KEY_REF', 'UNBLOCK_XAI_KEY_REF', 'UNBLOCK_OPENAI_KEY_REF', 'UNBLOCK_OPENAI_MODEL', 'UNBLOCK_OPENAI_VOICE', 'UNBLOCK_VOICE_PROVIDER', 'UNBLOCK_PUBLIC_ORIGIN', 'UNBLOCK_TRUSTED_PROXY', 'UNBLOCK_ALLOWED_USERS', 'GEMINI_API_KEY', 'XAI_API_KEY', 'OPENAI_API_KEY']
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  const originalFetch = globalThis.fetch
  let daemon
  Object.assign(process.env, { UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: state, UNBLOCK_VOICE_KEY_REF: 'test-nonexistent-gemini', UNBLOCK_XAI_KEY_REF: 'test-nonexistent-xai', UNBLOCK_OPENAI_KEY_REF: 'test-openai', UNBLOCK_OPENAI_MODEL: 'gpt-realtime-2.1', UNBLOCK_OPENAI_VOICE: 'marin', UNBLOCK_VOICE_PROVIDER: 'openai', UNBLOCK_PUBLIC_ORIGIN: 'https://studio.tailnet.test:8797', UNBLOCK_TRUSTED_PROXY: 'tailscale', UNBLOCK_ALLOWED_USERS: 'alex@example.test', OPENAI_API_KEY: 'fake-openai-route-key' })
  delete process.env.GEMINI_API_KEY
  delete process.env.XAI_API_KEY
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ value: 'fake-client-token', expires_at: 180 }) })
  const request = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: daemon.port, path, method: body ? 'POST' : 'GET', headers: { Host: 'studio.tailnet.test:8797', 'tailscale-user-login': 'alex@example.test', 'content-type': 'application/json' } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
  try {
    daemon = await startDaemon({ port: 0 })
    const providers = await request('/api/voice/providers')
    assert.equal(providers.body.default, 'openai')
    assert.deepEqual(providers.body.providers.map((provider) => provider.id), ['openai', 'xai', 'gemini'])
    const session = await request('/api/voice/session', { provider: 'gemini' })
    assert.equal(session.status, 200)
    assert.equal(session.body.provider, 'openai')
    const end = { session_id: session.body.session_id, seconds: 61, metrics: { first_audio_ms: 234, tool_calls: -1, tool_ok: '2', profile: 's'.repeat(50) } }
    assert.equal((await request('/api/voice/end', end)).body.ok, true)
    assert.equal((await request('/api/voice/end', end)).body.ok, false)
    const file = join(state, 'voice-sessions.jsonl')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const line = JSON.parse(lines[0])
    assert.ok(Number.isFinite(Date.parse(line.at)))
    assert.deepEqual({ ...line, at: undefined }, { at: undefined, session_id: session.body.session_id, provider: 'openai', model: 'gpt-realtime-2.1', seconds: 61, usd: 0.2, usd_per_minute: 0.1, first_audio_ms: 234, tool_calls: null, tool_ok: null, profile: 's'.repeat(40) })
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    globalThis.fetch = originalFetch
    if (daemon) await daemon.close()
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(state, { recursive: true, force: true })
  }
})
