/**
 * Local human sessions: the login wall's whole security model.
 *
 * Agents hold the daemon bearer, so the bearer can never prove "a person is
 * sitting here". A passphrase the agent does not know can. The hash lives on
 * disk (0600, scrypt); sessions live only in daemon memory and travel as an
 * HttpOnly cookie, so a restart signs everyone out.
 *
 * Accepted limitation, stated plainly: any process running as this same OS
 * user can rewrite the hash file. That is the same trust level as the bearer
 * secret beside it — this protects against an agent that asks for approval,
 * not against a malicious local user.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

export const SESSION_COOKIE = 'unblock_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }
/** Five wrong passphrases inside five minutes locks further attempts. */
const MAX_FAILURES = 5
const FAILURE_WINDOW_MS = 5 * 60 * 1000

function stateDir() {
  return (
    process.env.UNBLOCK_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')
  )
}
function passphraseFile() {
  return join(stateDir(), 'passphrase.json')
}

export function isConfigured() {
  return existsSync(passphraseFile())
}

export function configurePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('passphrase must be at least 8 characters')
  }
  const salt = randomBytes(16)
  const hash = scryptSync(passphrase, salt, SCRYPT.keylen, SCRYPT)
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  writeFileSync(passphraseFile(), JSON.stringify({
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  }), { mode: 0o600 })
}

export function verifyPassphrase(passphrase) {
  let record
  try {
    record = JSON.parse(readFileSync(passphraseFile(), 'utf8'))
  } catch {
    return false
  }
  try {
    const salt = Buffer.from(record.salt, 'base64')
    const expected = Buffer.from(record.hash, 'base64')
    const actual = scryptSync(String(passphrase ?? ''), salt, expected.length, {
      N: record.N ?? SCRYPT.N, r: record.r ?? SCRYPT.r, p: record.p ?? SCRYPT.p,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function clearPassphrase() {
  rmSync(passphraseFile(), { force: true })
}

/** The viewer a local signed-in session represents. */
export function localViewer() {
  const { username } = userInfo()
  return { login: username, name: username }
}

// --- sessions (daemon memory only) ---

const sessions = new Map()

export function createSession(viewer) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + SESSION_TTL_MS
  sessions.set(token, { viewer, expiresAt })
  return { token, expiresAt }
}

export function sessionFor(token) {
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  return session
}

export function destroySession(token) {
  if (token) sessions.delete(token)
}

// --- login rate limiting ---

const failures = []

function pruneFailures(now = Date.now()) {
  while (failures.length && now - failures[0] > FAILURE_WINDOW_MS) failures.shift()
}

export function loginRateLimited() {
  pruneFailures()
  return failures.length >= MAX_FAILURES
}

export function noteLoginFailure() {
  failures.push(Date.now())
}

export function resetLoginFailures() {
  failures.length = 0
}

export function loginRetryAfterMs() {
  pruneFailures()
  if (!failures.length) return 0
  return Math.max(0, failures[0] + FAILURE_WINDOW_MS - Date.now())
}

// --- cookies ---

export function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function sessionCookieValue(token, { secure = false } = {}) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`
}

export const clearedCookieValue = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`

/**
 * Hidden passphrase prompt for CLI auth commands. TTY-only on purpose: a pipe
 * or an env var would let a non-interactive process (an agent) set or change
 * the credential that separates people from agents.
 */
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error('run this in an interactive terminal'))
      return
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let writes = 0
    rl._writeToOutput = (text) => {
      // The first write is the prompt itself; every later write would echo a
      // typed character of the secret.
      if (writes++ === 0) process.stdout.write(text)
    }
    rl.question('', (answer) => {
      process.stdout.write('\n')
      rl.close()
      resolve(answer)
    })
  })
}