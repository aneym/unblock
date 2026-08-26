/** Resolve the repo root from this file, never a hardcoded home path — the
 *  installed copy lives under ~/.config/herdr/plugins/github/unblock-<hash>/. */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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

async function alive(port) {
  if (!port) return false
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1200),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Find the daemon, starting it detached if it is not up. Returns a base URL. */
export async function daemon({ start = true, timeoutMs = 5000 } = {}) {
  let port = readPort()
  if (await alive(port)) return `http://127.0.0.1:${port}`
  if (!start) throw new Error('unblock daemon is not running')

  spawn(process.execPath, [join(ROOT, 'src', 'daemon.js')], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT,
  }).unref()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    port = readPort()
    if (await alive(port)) return `http://127.0.0.1:${port}`
  }
  throw new Error(`unblock daemon did not come up within ${timeoutMs}ms`)
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
