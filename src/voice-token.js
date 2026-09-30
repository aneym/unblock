import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { VOICE_SYSTEM_PROMPT, VOICE_TOOLS, xaiTools } from './voice.js'

const call = promisify(execFile)
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens'

export async function defaultReadKey(ref, envName = 'GEMINI_API_KEY') {
  if (process.env[envName]?.trim()) return process.env[envName].trim()
  try {
    const { stdout } = await call(`${process.env.HOME}/.local/bin/agent-secret`, ['get', ref], { timeout: 5000 })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function mintVoiceToken({ readKey = defaultReadKey, fetch = globalThis.fetch, now = Date.now, keyRef = 'gemini-api-key', model = 'gemini-3.8-live', voice = 'Kore', prompt = VOICE_SYSTEM_PROMPT, tools = VOICE_TOOLS, speed = 1 } = {}) {
  const key = await readKey(keyRef, 'GEMINI_API_KEY')
  if (!key) {
    const error = new Error('Voice is not configured')
    error.code = 'VOICE_NOT_CONFIGURED'
    throw error
  }
  const modelName = model.startsWith('models/') ? model : `models/${model}`
  const newSessionExpireTime = new Date(now() + 2 * 60_000).toISOString()
  const extendedThinking = modelName.includes('extended-thinking')
  const setup = {
    model: modelName,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      ...(extendedThinking ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
    },
    systemInstruction: { role: 'user', parts: [{ text: speed > 1 ? prompt + '\nSpeak quickly, at a brisk pace, with no pauses between sentences.' : prompt }] },
    tools: [{ functionDeclarations: extendedThinking ? tools.map((tool) => ({ ...tool, behavior: 'NON_BLOCKING' })) : tools }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  }
  // The token API accepts the setup's top-level keys, not nested field paths.
  const fieldMask = Object.keys(setup).join(',')
  const body = {
    expireTime: new Date(now() + 30 * 60_000).toISOString(),
    newSessionExpireTime,
    uses: 1,
    bidiGenerateContentSetup: setup,
    fieldMask,
  }
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error('Voice token service unavailable')
  const data = await response.json()
  if (typeof data.name !== 'string' || !data.name.startsWith('auth_tokens/')) throw new Error('Voice token service returned an invalid token')
  return { provider: 'gemini', token: data.name, model, voice, expires_at: newSessionExpireTime }
}

export async function mintXaiToken({ keyRef = 'xai-api-key', readKey = defaultReadKey, fetch = globalThis.fetch, now = Date.now, model = 'grok-voice-think-fast-2.0', voice = 'eve' } = {}) {
  const key = await readKey(keyRef, 'XAI_API_KEY')
  if (!key) {
    const error = new Error('Voice is not configured')
    error.code = 'VOICE_NOT_CONFIGURED'
    throw error
  }
  try {
    const response = await fetch('https://api.x.ai/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { seconds: 120 } }),
    })
    if (!response.ok) throw new Error('Voice token service unavailable')
    const data = await response.json()
    if (typeof data.value !== 'string' || !data.value) throw new Error('Voice token service unavailable')
    return { provider: 'xai', token: data.value, model, voice, expires_at: new Date(Number(data.expires_at) * 1000).toISOString() }
  } catch {
    throw new Error('Voice token service unavailable')
  }
}

export async function mintOpenAiToken({ keyRef = 'openai-rails-voice-prod', readKey = defaultReadKey, fetch = globalThis.fetch, model = 'gpt-realtime-2.1', voice = 'marin' } = {}) {
  let key
  try { key = await readKey(keyRef, 'OPENAI_API_KEY') } catch { throw new Error('Voice token service unavailable') }
  if (!key) {
    const error = new Error('Voice is not configured')
    error.code = 'VOICE_NOT_CONFIGURED'
    throw error
  }
  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_after: { anchor: 'created_at', seconds: 120 }, session: { type: 'realtime', model, audio: { output: { voice } } } }),
    })
    if (!response.ok) throw new Error('Voice token service unavailable')
    const data = await response.json()
    if (typeof data.value !== 'string' || !data.value) throw new Error('Voice token service unavailable')
    return { provider: 'openai', token: data.value, model, voice, expires_at: new Date(Number(data.expires_at) * 1000).toISOString() }
  } catch {
    throw new Error('Voice token service unavailable')
  }
}

export function buildLiveSession({ model = 'gpt-live-1', voice = 'marin', delegate = 'gpt-6-luna', prompt, tools }) {
  return { model, instructions: prompt, audio: { output: { voice } }, delegation: { type: 'responses', responses: { model: delegate, instructions: prompt, tools: xaiTools(tools) } } }
}

export async function connectLiveCall({ keyRef = 'openai-rails-voice-prod', readKey = defaultReadKey, fetch = globalThis.fetch, sdp, session }) {
  let key
  try { key = await readKey(keyRef, 'OPENAI_API_KEY') } catch { throw new Error('Voice token service unavailable') }
  if (!key) {
    const error = new Error('Voice is not configured')
    error.code = 'VOICE_NOT_CONFIGURED'
    throw error
  }
  try {
    const response = await fetch('https://api.openai.com/v1/live/sessions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
    })
    if (!response.ok) throw new Error('Voice token service unavailable')
    const data = await response.json()
    if (typeof data.transport?.sdp !== 'string' || !data.transport.sdp || typeof data.session?.id !== 'string' || !data.session.id) throw new Error('Voice token service unavailable')
    return { sdp: data.transport.sdp, id: data.session.id }
  } catch { throw new Error('Voice token service unavailable') }
}
