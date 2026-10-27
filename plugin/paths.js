/** Resolve the repo root from this file, never a hardcoded home path — the
 *  installed copy lives under ~/.config/herdr/plugins/github/unblock-<hash>/. */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'

import { daemonRoot, readConfig } from '../src/config.js'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Where to start the daemon from. The config file's `root` wins, because a
 * herdr-managed clone of this repo and the canonical checkout must not both
 * be able to own the port — the one without a built panel serves a blank page.
 */
export function daemonSource() {
  return daemonRoot() || ROOT
}

export function stateDir() {
  return (
    process.env.UNBLOCK_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')
  )
}

function readDaemonFile() {
  const file = join(stateDir(), 'daemon.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function readPort() {
  if (process.env.UNBLOCK_PORT) return Number(process.env.UNBLOCK_PORT)
  return readDaemonFile().port ?? null
}

/** The daemon secret, written 0600 beside the port. Local clients only. */
export function authToken() {
  return process.env.UNBLOCK_AUTH || readDaemonFile().auth || null
}

function launchdJob() {
  return `gui/${process.getuid?.()}/${process.env.UNBLOCK_LAUNCHD_LABEL || 'com.aneyman.unblock'}`
}

function launchdLoaded() {
  if (process.env.UNBLOCK_STATE_DIR || process.platform !== 'darwin' || !process.getuid) return false
  const result = spawnSync('launchctl', ['print', launchdJob()], { stdio: 'ignore', timeout: 5000 })
  return result.status === 0
}

async function alive(port, timeoutMs = Number(process.env.UNBLOCK_HEALTH_TIMEOUT_MS) || 4000) {
  if (!port) return false
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Find the daemon, starting it detached if it is not up. Returns a base URL. */
export async function daemon({ start = true, timeoutMs } = {}) {
  if (readConfig().remote) {
    if (await alive(readPort())) return `http://127.0.0.1:${readPort()}`
    throw new Error('remote unblock forward is unavailable; local autostart is disabled')
  }
  let port = readPort()
  if (await alive(port)) return `http://127.0.0.1:${port}`
  if (port && await alive(port, 8000)) return `http://127.0.0.1:${port}`
  if (!start) throw new Error('unblock daemon is not running')

  const supervised = launchdLoaded()
  timeoutMs ??= Number(process.env.UNBLOCK_START_TIMEOUT_MS) || (supervised ? 45000 : 15000)
  if (!supervised) {
    const source = daemonSource()
    spawn(process.execPath, [join(source, 'src', 'daemon.js')], {
      detached: true,
      stdio: 'ignore',
      cwd: source,
    }).unref()
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    port = readPort()
    if (await alive(port)) return `http://127.0.0.1:${port}`
  }
  throw new Error(supervised
    ? `unblock daemon (launchd ${launchdJob()}) did not answer within ${timeoutMs}ms`
    : `unblock daemon did not come up within ${timeoutMs}ms`)
}

export async function api(path, body) {
  const base = await daemon()
  const token = authToken()
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}
