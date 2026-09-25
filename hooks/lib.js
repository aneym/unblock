import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { daemon, authToken, stateDir } from '../plugin/paths.js'
import { paneOrigin } from '../plugin/herdr.js'
import { ASK_PURPOSES, validateAsk } from '../src/schema.js'

export const registryDir = () => join(stateDir(), 'pane-asks')
export const entryPath = (ticket) => join(registryDir(), `${ticket}.json`)

/** Hook stdout is a decision channel; failures go only to the local log. */
export function log(message) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(join(stateDir(), 'pane-hooks.log'), JSON.stringify({ at: new Date().toISOString(), message }) + '\n', { mode: 0o600 })
  } catch { /* logging must never block a hook */ }
}

export function plainify(text) {
  return String(text ?? '')
    .replace(/(?:~\/|\/(?:Users|Volumes|home)\/)[^\s,;:!?]+/gi, (path) => basename(path.replace(/\/+$/, '')))
    .replace(/\bADR[ -]?(\d+)\b/gi, 'decision record $1')
    .replace(/\bv(\d+(?:\.\d+)?)\b/gi, 'version $1')
    .replace(/\blane[\/:-]([^\s,;:!?]+)/gi, '$1')
    .replace(/\brung\b/gi, 'step')
    .replace(/\bub_[a-z0-9]{6}\b/gi, 'that ticket')
    .replace(/\s+/g, ' ').trim()
}

export function cut(text, max) {
  text = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const prefix = text.slice(0, max - 1)
  const word = prefix.lastIndexOf(' ')
  return (word > max / 2 ? prefix.slice(0, word) : prefix).trimEnd() + '…'
}

export function eligible(input) {
  return Boolean(process.env.HERDR_PANE_ID && !input?.agent_id && process.env.UNBLOCK_ALLOW_DIALOG !== '1')
}

export async function origin() {
  const pane_id = process.env.HERDR_PANE_ID
  const extra = await paneOrigin(pane_id)
  return {
    agent: process.env.UNBLOCK_AGENT || 'claude',
    pane_id,
    tab_id: process.env.HERDR_TAB_ID,
    workspace_id: process.env.HERDR_WORKSPACE_ID,
    session_id: process.env.HERDR_SESSION_ID || process.env.CLAUDE_SESSION_ID,
    cwd: process.cwd(),
    workspace_name: extra.workspace_name,
    profiles: extra.profiles,
  }
}

export async function request(path, body) {
  const base = await daemon({ start: false, timeoutMs: 1500 })
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${authToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(1500),
  })
  const data = await res.json()
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`)
    error.status = res.status
    error.data = data
    throw error
  }
  return data
}

// A daemon that predates v2 names the unknown purpose or v2-only key in its 400.
export const NEWER_SHAPE = /(?:purpose.*(?:unknown|unsupported|invalid|must be one of)|(?:unknown|unsupported|invalid).*purpose)|recommend|permission|choices\[\d+\]\.description|summary|after/i
// Only an unknown purpose: once the daemon knows 'permission', its passkey gate must not be sidestepped.
export const UNKNOWN_PURPOSE = /^purpose: must be one of/i

/** Fall back only when the daemon does not recognize a newer ask shape. */
export async function fileFirst(candidates, source, fallback = NEWER_SHAPE) {
  for (let i = 0; i < candidates.length; i++) {
    const ask = candidates[i]
    if (ASK_PURPOSES.includes(ask.purpose)) validateAsk(ask)
    try {
      const filed = await request('/api/asks', { ask, origin: source })
      return { ticket: filed.ticket, created: true }
    } catch (error) {
      if (error.status === 409 && error.data?.ticket) {
        const old = await request(`/api/asks/${encodeURIComponent(error.data.ticket)}`)
        if (old.status !== 'open' || old.origin?.pane_id !== source.pane_id) throw new Error('duplicate belongs to another pane or is closed')
        return { ticket: old.ticket, created: false }
      }
      const detail = String(error.data?.error ?? '')
      if (error.status === 400 && i < candidates.length - 1 &&
        fallback.test(detail)) continue
      throw error
    }
  }
}

export async function answerLink(ticket) {
  const health = await request('/api/health')
  if (health.public_origin) return `${health.public_origin.replace(/\/$/, '')}/#ask=${ticket}`
  return (await request('/api/links', { ticket, ttl_seconds: 900 })).url
}

export function readEntry(ticket) {
  try { return JSON.parse(readFileSync(entryPath(ticket), 'utf8')) } catch { return null }
}

export function entries(paneId) {
  try {
    return readdirSync(registryDir()).filter((name) => /^ub_[a-z0-9]+\.json$/.test(name))
      .map((name) => readEntry(name.slice(0, -5)))
      .filter((entry) => entry?.pane_id === paneId)
  } catch { return [] }
}

export function register(ticket, pane_id, type, extra = {}) {
  mkdirSync(registryDir(), { recursive: true, mode: 0o700 })
  writeFileSync(entryPath(ticket), JSON.stringify({ ticket, pane_id, type, created_at: new Date().toISOString(), ...extra }), { mode: 0o600 })
}

export function remove(ticket) {
  try { unlinkSync(entryPath(ticket)) } catch { /* already gone */ }
}

export function watcher(ticket) {
  spawn(process.execPath, [join(import.meta.dirname, 'pane-wake.js'), ticket], {
    detached: true, stdio: 'ignore', env: process.env,
  }).unref()
}

/** Never persist credential-looking command fragments in an ask. */
export function redact(summary) {
  return String(summary)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b([A-Za-z0-9_]*(?:token|key|secret|password|passwd|auth)[A-Za-z0-9_]*)([=: ]+)\S+/gi, '$1$2[redacted]')
    .replace(/--(token|key|secret|password|api-key)([= ]+)\S+/gi, '--$1$2[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
}

export const project = (cwd) => basename(cwd || process.cwd())
