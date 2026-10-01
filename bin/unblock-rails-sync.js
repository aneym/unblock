#!/usr/bin/env node
import { constants } from 'node:fs'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { createRailsSync } from '../src/rails-sync.js'
import { loadOrCreateSecret } from '../src/daemon.js'

function log(message) {
  process.stderr.write(`${new Date().toISOString()} ${String(message).split('\n')[0]}\n`)
}

function stateDir() {
  return (
    process.env.UNBLOCK_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')
  )
}

function configuredPort() {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'daemon.json'), 'utf8')).port
  } catch {
    return Number(process.env.UNBLOCK_PORT || 4488)
  }
}

function intervalMs() {
  const raw = process.env.UNBLOCK_RAILS_SYNC_INTERVAL_MS
  if (raw == null || raw === '') return 10_000
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : 10_000
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const lockPath = join(stateDir(), 'rails-sync.lock')

function releaseLock() {
  try {
    const pid = Number(String(readFileSync(lockPath, 'utf8')).trim())
    if (pid === process.pid) unlinkSync(lockPath)
  } catch { /* lock already gone */ }
}

function acquireLock() {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, flags, 0o600)
      writeFileSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const pid = Number(String(readFileSync(lockPath, 'utf8')).trim())
      if (pidAlive(pid)) {
        log('rails-sync already running')
        process.exit(0)
      }
      try { unlinkSync(lockPath) } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  log('rails-sync already running')
  process.exit(0)
}

acquireLock()
process.on('exit', releaseLock)
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

const host = process.env.UNBLOCK_RAILS_SYNC_HOST || hostname().split('.')[0].toLowerCase()
const sync = createRailsSync({
  daemonOrigin: `http://127.0.0.1:${configuredPort()}`,
  daemonToken: loadOrCreateSecret(),
  hostedUrl: process.env.UNBLOCK_RAILS_URL || 'https://unblock.rails.so/mcp',
  statePath: join(stateDir(), 'rails-sync.json'),
  host,
  log,
  accessToken: async (options) => {
    const { railsAccessToken } = await import('../src/rails-auth.js')
    return railsAccessToken(options)
  },
})

const interval = intervalMs()
while (true) {
  try {
    await sync.once()
  } catch (error) {
    log(String(error?.message || error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'))
  }
  await new Promise((resolve) => setTimeout(resolve, interval))
}
