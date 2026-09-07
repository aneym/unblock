/**
 * Durable daemon configuration.
 *
 * Everything the daemon needs to be reachable from the tailnet used to live
 * only in environment variables. That worked for exactly one spawner — the
 * launchd job that carried them — and failed for every other: the herdr
 * startup hook, an MCP server's auto-start, the CLI. Whoever won the port
 * first after a reboot served a daemon with no public origin, and the
 * bookmarked tailnet URL 403'd until someone noticed.
 *
 * So the settings live in a file every spawner can read:
 *
 *   ~/.config/unblock/config.json
 *   {
 *     "public_origin": "https://studio.tailf266ac.ts.net:8797",
 *     "trusted_proxy": "tailscale",
 *     "allowed_users": ["a.neyman17@gmail.com"],
 *     "root": "/path/to/the/canonical/checkout"
 *   }
 *
 * Environment variables still win, so a test or a one-off can override the
 * file without editing it. Values are validated here, strictly: a public
 * origin is ONE https URL with a hostname and nothing else. There is no
 * wildcard, because the host allowlist is what stops a rebinding page from
 * reading the queue.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function configDir() {
  return (
    process.env.UNBLOCK_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'unblock')
  )
}

export function configPath() {
  return join(configDir(), 'config.json')
}

/** Parsed file, or {} when absent or unreadable. Never throws. */
export function readConfig(path = configPath()) {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    console.error(`unblock: ignoring unreadable ${path} (${error.message})`)
    return {}
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * One origin, or null. https is required unless the host is loopback; a
 * path, query, fragment, credentials, or a wildcard character rejects it.
 */
export function normalizePublicOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const raw = value.trim()
  if (/[*\s]/.test(raw)) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (!url.hostname) return null
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return null
  }
  return url.origin
}

export function normalizeTrustedProxy(value) {
  return value === 'tailscale' ? 'tailscale' : null
}

/** Comma string or array of logins → comma string, or null when empty. */
export function normalizeAllowedUsers(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const users = list
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter((u) => u.includes('@') && !/[*\s]/.test(u))
  return users.length ? users.join(',') : null
}

export function normalizePort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? String(port) : null
}

/**
 * Fill UNBLOCK_* variables that are unset from the config file. Returns what
 * was applied and from where so health can report it. Idempotent.
 */
export function applyConfig({ env = process.env, path = configPath() } = {}) {
  const file = readConfig(path)
  const applied = []
  const settings = [
    ['UNBLOCK_PUBLIC_ORIGIN', normalizePublicOrigin(file.public_origin)],
    ['UNBLOCK_TRUSTED_PROXY', normalizeTrustedProxy(file.trusted_proxy)],
    ['UNBLOCK_ALLOWED_USERS', normalizeAllowedUsers(file.allowed_users)],
    ['UNBLOCK_PORT', normalizePort(file.port)],
  ]
  for (const [name, value] of settings) {
    if (env[name] !== undefined && env[name] !== '') continue
    if (value === null) continue
    env[name] = value
    applied.push(name)
  }
  // A trusted proxy without an origin trusts nothing; say so instead of
  // silently running open-loop.
  if (env.UNBLOCK_TRUSTED_PROXY && !env.UNBLOCK_PUBLIC_ORIGIN) {
    console.error('unblock: UNBLOCK_TRUSTED_PROXY is set without UNBLOCK_PUBLIC_ORIGIN; proxy identity is disabled')
  }
  return { path, present: existsSync(path), applied }
}

/**
 * The checkout every spawner should start the daemon from. When several
 * copies of this code exist (a herdr-managed clone, a canonical checkout),
 * only one may own the queue's process, or the loser serves a stale panel.
 * Returns null when unset or when the path has no daemon to run.
 */
export function daemonRoot({ path = configPath() } = {}) {
  const root = process.env.UNBLOCK_ROOT || readConfig(path).root
  if (typeof root !== 'string' || root.trim() === '') return null
  return existsSync(join(root, 'src', 'daemon.js')) ? root : null
}
