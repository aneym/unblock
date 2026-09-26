/** Secret delivery for the headless daemon. No macOS keychain calls. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const AGENT_SECRET = join(homedir(), '.local', 'bin', 'agent-secret')
const CONFIG_DIR = join(homedir(), '.agent-rails', 'custody')
const ENV_FILE = join(CONFIG_DIR, 'unblock', 'secrets.env')
// agent-secret's own name rule and directory, so presence can be checked without reading a value.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const STORE_DIR = join(CONFIG_DIR, 'agent-secret')

function storeDirId() {
  const info = lstatSync(STORE_DIR)
  return info.isDirectory() ? `${info.dev}:${info.ino}` : null
}

function call(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(AGENT_SECRET, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 30_000 })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', () => reject(new Error('agent-secret unavailable')))
    child.on('close', (code) => {
      if (code !== 0) reject(new Error('agent-secret operation failed'))
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(input)
  })
}

export class SecretStore {
  backend() { return Promise.resolve('file') }
  backendIfResolved() { return 'file' }

  // Each attempt gets its own ref, so a failed re-answer can delete what it
  // stored without touching the secret an earlier answer committed.
  async put({ name, value, ticket, envName }) {
    if (typeof value !== 'string' || value === '') throw new Error('empty secret')
    const attempt = randomBytes(16).toString('hex')
    const ref = `${ticket}-${name}-${attempt}`.replace(/[^A-Za-z0-9._-]/g, '-')
    const env_name = envName || `UNBLOCK_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
    // No record reaches the caller on a throw, so nothing would queue this ref
    // for cleanup: a put that failed or timed out may still have written it,
    // so remove it here (best effort) before failing.
    const stored = await call(['put', ref], Buffer.from(value, 'utf8')).then(() => call(['get', ref])).catch(() => null)
    if (!stored?.equals(Buffer.from(value, 'utf8'))) {
      await call(['rm', ref]).catch(() => {})
      throw new Error('secret round trip failed')
    }
    return {
      store: 'file', ref, env_name,
      resolve: `${AGENT_SECRET} get ${ref}`,
      hint: `Pipe ${AGENT_SECRET} get ${ref} into the command that needs it; do not print it.`,
    }
  }

  /**
   * True only when the secret is confirmed gone (or was never there). Never
   * throws. Other stores cannot be deleted from here, so they stay queued.
   */
  async delete(record) {
    if (record?.store !== 'file' || typeof record.ref !== 'string' || !NAME_RE.test(record.ref)) return false
    // Taken before rm, which recreates a missing store directory: a store moved
    // away must not read as an empty one.
    let before = null
    try { before = storeDirId() } catch { /* no store yet: a failed rm stays queued */ }
    try {
      await call(['rm', record.ref])
      return true
    } catch {
      // rm fails on a missing name and on anything that is not a plain file:
      // gone only when nothing at all is left under that name, checked inside
      // one store directory that stayed in place throughout.
      if (!before) return false
      try {
        try { lstatSync(join(STORE_DIR, record.ref)); return false } catch (error) { if (error.code !== 'ENOENT') return false }
        return storeDirId() === before
      } catch {
        return false
      }
    }
  }

  async reveal(record) {
    if (!record?.store) throw new Error('not a secret reference')
    if (record.store === 'file') return (await call(['get', record.ref])).toString('utf8')
    if (record.store === 'keychain') throw new Error('keychain reads disabled; migrate this reference to agent-secret')
    throw new Error(`unsupported secret store: ${record.store}`)
  }
}

export { ENV_FILE, CONFIG_DIR }
