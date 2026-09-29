import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { VOICE_SYSTEM_PROMPT, VOICE_TOOLS } from './voice.js'

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

export async function mintVoiceToken({ readKey = defaultReadKey, fetch = globalThis.fetch, now = Date.now, keyRef = 'gemini-api-key', model = 'gemini-3.8-live', voice = 'Kore', prompt = VOICE_SYSTEM_PROMPT, tools = VOICE_TOOLS } = {}) {
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
    systemInstruction: { role: 'user', parts: [{ text: prompt }] },
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
