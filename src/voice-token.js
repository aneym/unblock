import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { VOICE_SYSTEM_PROMPT, VOICE_TOOLS } from './voice.js'

const call = promisify(execFile)
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens'

export async function defaultReadKey(ref) {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim()
  try {
    const { stdout } = await call(`${process.env.HOME}/.local/bin/agent-secret`, ['get', ref], { timeout: 5000 })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function mintVoiceToken({ readKey = defaultReadKey, fetch = globalThis.fetch, now = Date.now, keyRef = 'gemini-api-key', model = 'gemini-3.8-live', voice = 'Kore' } = {}) {
  const key = await readKey(keyRef)
  if (!key) {
    const error = new Error('Voice is not configured')
    error.code = 'VOICE_NOT_CONFIGURED'
    throw error
  }
  const modelName = model.startsWith('models/') ? model : `models/${model}`
  const newSessionExpireTime = new Date(now() + 2 * 60_000).toISOString()
  const setup = {
    model: modelName,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
    systemInstruction: { role: 'user', parts: [{ text: VOICE_SYSTEM_PROMPT }] },
    tools: [{ functionDeclarations: VOICE_TOOLS }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  }
  // The SDK flattens bidiGenerateContentSetup.setup, then getFieldMasks scans
  // its top level and the immediate child keys (including the empty objects).
  const fieldMask = Object.entries(setup).flatMap(([name, value]) =>
    value && typeof value === 'object' && Object.keys(value).length
      ? Object.keys(value).map((child) => `${name}.${child}`)
      : [name],
  ).join(',')
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
  return { token: data.name, model, expires_at: newSessionExpireTime }
}
