/** Hosted Unblock OAuth. Refresh tokens stay in agent-secret; access tokens stay in memory. */
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const cache = new Map()
const flights = new Map()
const resources = new Map()
const secretsSeen = new Set()
const pendingRefresh = new Map()
const writes = new Map()
const TOKEN_ERRORS = new Set(['invalid_grant', 'invalid_client', 'invalid_request', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'access_denied', 'temporarily_unavailable'])
const REGISTRATION_ERRORS = new Set(['invalid_redirect_uri', 'invalid_client_metadata', 'invalid_software_statement',
  'unapproved_software_statement', 'invalid_request', 'temporarily_unavailable'])
const AUTHORIZE_ERRORS = new Set(['access_denied', 'invalid_request', 'unauthorized_client', 'unsupported_response_type',
  'invalid_scope', 'server_error', 'temporarily_unavailable'])

function stateDir() {
  return process.env.UNBLOCK_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')
}

function secretBin() {
  return process.env.UNBLOCK_AGENT_SECRET_BIN || 'agent-secret'
}

function coded(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function assertIssuer(issuer) {
  let url
  try { url = new URL(issuer) } catch { throw coded('issuer must be https') }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return
  throw coded('issuer must be https')
}

function runSecret(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(secretBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(coded('secret_unavailable'))
    }, 10_000)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      reject(coded('secret_unavailable'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(coded('secret_unavailable'))
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
    child.stdin.end(input === undefined ? undefined : input)
  })
}

function secretGet(name) {
  return runSecret(['get', name])
}

function secretPut(name, value) {
  return runSecret(['put', name], value)
}

function remember(secretName, accessToken, expiresIn, resource) {
  const seconds = Number(expiresIn)
  const expiresAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.now()
  cache.set(secretName, { accessToken, expiresAt })
  secretsSeen.add(accessToken)
  if (resource) resources.set(secretName, resource)
}

function usable(secretName) {
  const hit = cache.get(secretName)
  return Boolean(hit && hit.expiresAt - Date.now() > 60_000)
}

// Rails treats reuse of a spent refresh token as theft and revokes the whole chain, so two
// refreshes at once force the person to consent again. Correctness rests on the spend claim
// below, which lets each refresh token be submitted at most once; this lock only keeps
// processes from queueing behind each other's claims. The lock never steals on age: a holder
// is dead only when its pid is gone (ESRCH) or the pid now belongs to a process with a
// different start time. A live but hung holder makes the others fail with lock_timeout, and
// the holder's own work is bounded by the fetch and agent-secret timeouts.
const psEnv = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
const aliveSeen = new Map()
let ownStart

function lstartOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: psEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim()
  } catch {
    return ''
  }
}

function myStart() {
  if (ownStart === undefined) ownStart = lstartOf(process.pid)
  if (!ownStart) throw coded('lock_unavailable')
  return ownStart
}

function ownerDead(owner) {
  const pid = Number(owner.pid)
  if (!Number.isInteger(pid) || pid <= 0) return false
  const start = typeof owner.start === 'string' ? owner.start : ''
  if (pid === process.pid) return start !== '' && start !== myStart()
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error.code === 'ESRCH'
  }
  if (!start) return false
  // Only a match is remembered, and only briefly, so a cached answer can delay a steal but never cause one.
  const key = `${pid}\n${start}`
  if (Date.now() - (aliveSeen.get(key) || 0) < 250) return false
  const now = lstartOf(pid)
  if (now === start || now === '') {
    aliveSeen.set(key, Date.now())
    return false
  }
  return true
}

// A lock or mutex file holds its owner's record. Older builds made the lock a directory with owner.json.
function readOwner(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error.code !== 'EISDIR') throw error
    try { raw = readFileSync(join(path, 'owner.json'), 'utf8') } catch { return { raw: '', dir: true } }
  }
  let record = {}
  try { record = JSON.parse(raw) || {} } catch { /* torn or foreign: never judged dead */ }
  return { raw, pid: record.pid, start: record.start, token: record.token, dir: false }
}

// The record is written to a temp file and hard-linked into place, so the path never exists without an owner.
function linkOwned(path, token) {
  const tmp = join(dirname(path), `rails-auth.tmp-${randomBytes(6).toString('hex')}`)
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, start: myStart(), token }), { mode: 0o600, flag: 'wx' })
  try {
    linkSync(tmp, path)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(tmp, { force: true })
  }
}

// Moves the file aside and deletes it only if it is still the record the caller judged. Returns 'conflict',
// after putting the other record back where it can, when the path changed hands in between.
function removeIfSame(path, raw) {
  const stale = join(dirname(path), `rails-auth.stale-${randomBytes(6).toString('hex')}`)
  try {
    renameSync(path, stale)
  } catch (error) {
    if (error.code === 'ENOENT') return 'gone'
    throw error
  }
  const moved = readOwner(stale)
  if (moved && moved.raw === raw) {
    rmSync(stale, { recursive: true, force: true })
    return 'removed'
  }
  if (moved && !moved.dir) {
    try { linkSync(stale, path) } catch { /* the path was taken again; the sweep removes the copy */ }
    rmSync(stale, { force: true })
  }
  return 'conflict'
}

function sweepStale(dir) {
  try {
    for (const name of readdirSync(dir)) {
      if (!/^rails-auth\.(?:stale|tmp|lock\.stale)-/.test(name)) continue
      const path = join(dir, name)
      try {
        if (Date.now() - statSync(path).mtimeMs > 600_000) rmSync(path, { recursive: true, force: true })
      } catch { /* gone or unreadable */ }
    }
  } catch { /* best effort */ }
}

// Steals and releases run under a second lock, the steal mutex, so the lock a stealer judged dead cannot
// be released and taken again before the stealer moves it. The mutex is removed by others only when its
// own owner is dead. One residual case remains: a mutex holder dies mid-steal, and two waiters both judge
// its mutex dead. The first moves it aside and takes a fresh mutex; the second then moves the fresh one
// aside, sees a different record and puts it back, unless a third waiter linked a new mutex in that gap.
// That needs a crash and three interleavings inside a few syscalls, and costs no more than a wait: both
// holders read the same refresh token, and only one of them can claim it.
function takeMutex(mutexPath) {
  const token = randomBytes(16).toString('hex')
  if (linkOwned(mutexPath, token)) return token
  const holder = readOwner(mutexPath)
  if (holder && !holder.dir && ownerDead(holder)) removeIfSame(mutexPath, holder.raw)
  return null
}

function dropMutex(mutexPath, token) {
  const holder = readOwner(mutexPath)
  if (holder && holder.token === token) rmSync(mutexPath, { force: true })
}

function trySteal(lockPath) {
  const holder = readOwner(lockPath)
  if (!holder || !ownerDead(holder)) return
  const mutexPath = `${lockPath}.steal`
  const mutex = takeMutex(mutexPath)
  if (!mutex) return
  try {
    const again = readOwner(lockPath)
    if (!again || !ownerDead(again)) return
    if (removeIfSame(lockPath, again.raw) === 'conflict') throw coded('lock_conflict')
  } finally {
    dropMutex(mutexPath, mutex)
  }
}

async function release(lockPath, token) {
  const mutexPath = `${lockPath}.steal`
  const deadline = Date.now() + 15_000
  for (;;) {
    const mutex = takeMutex(mutexPath)
    if (mutex || Date.now() > deadline) {
      try {
        const holder = readOwner(lockPath)
        // Past the deadline this runs without the mutex. That is still safe: nobody steals a live
        // owner's lock, and removeIfSame puts back any record that is not ours.
        if (holder && holder.token === token) removeIfSame(lockPath, holder.raw)
      } finally {
        if (mutex) dropMutex(mutexPath, mutex)
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function withLock(fn) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  sweepStale(dir)
  const lockPath = join(dir, 'rails-auth.lock')
  const deadline = Date.now() + 30_000
  const token = randomBytes(16).toString('hex')
  while (!linkOwned(lockPath, token)) {
    trySteal(lockPath)
    if (Date.now() > deadline) throw coded('lock_timeout')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  try {
    return await fn()
  } finally {
    await release(lockPath, token)
  }
}

async function readJson(response) {
  return response.json().catch(() => ({}))
}

function assertEndpoint(endpoint) {
  let url
  try { url = new URL(endpoint) } catch { throw coded('insecure_endpoint') }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return
  throw coded('insecure_endpoint')
}

async function discover(issuer) {
  const response = await fetch(new URL('/.well-known/oauth-authorization-server', issuer), {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const body = await readJson(response)
  if (!response.ok || !body.authorization_endpoint || !body.token_endpoint || !body.registration_endpoint) {
    throw coded('discovery_failed')
  }
  assertEndpoint(body.authorization_endpoint)
  assertEndpoint(body.token_endpoint)
  assertEndpoint(body.registration_endpoint)
  return body
}

async function registerClient(endpoint, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const registered = await readJson(response)
  if (!response.ok || typeof registered.client_id !== 'string') {
    throw coded(REGISTRATION_ERRORS.has(registered.error) ? registered.error : 'registration_failed')
  }
  return registered.client_id
}

// The error body is the server's text, and a confused server can echo the refresh token back, so only
// a known OAuth error code passes through. The body is a one-shot stream: fetch replays a body that has a
// source (a string or URLSearchParams) on its own after a 421, which would send a refresh token or an auth
// code twice inside one call. A stream has no source, so it can be sent only once.
async function tokenRequest(endpoint, params) {
  assertEndpoint(endpoint)
  const form = new TextEncoder().encode(new URLSearchParams(params).toString())
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new ReadableStream({ start(controller) { controller.enqueue(form); controller.close() } }),
      duplex: 'half',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw coded('token_request_failed')
  }
  const body = await readJson(response)
  if (!response.ok || typeof body.access_token !== 'string') {
    throw coded(TOKEN_ERRORS.has(body.error) ? body.error : 'token_request_failed')
  }
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expires_in: body.expires_in,
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

function waitForCode(expectedState, timeoutMs) {
  let settle
  let timer
  let settled = false
  const done = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const finish = (fn, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    fn(value)
  }
  const server = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url, 'http://127.0.0.1') } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    if (url.searchParams.get('state') !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('state mismatch')
      return
    }
    const oauthError = url.searchParams.get('error')
    if (oauthError) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('authorization failed')
      finish(settle.reject, coded(AUTHORIZE_ERRORS.has(oauthError) ? oauthError : 'authorization_failed'))
      server.close()
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('missing code')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Connected. You can close this tab.', () => {
      server.close()
      finish(settle.resolve, code)
    })
  })
  timer = setTimeout(() => {
    server.close()
    finish(settle.reject, new Error('authorization timed out'))
  }, timeoutMs)
  return { server, done, cancel: () => clearTimeout(timer) }
}

async function readClient(secretName) {
  let stored
  try { stored = JSON.parse(await secretGet(secretName)) } catch (error) {
    if (error.code === 'secret_unavailable') throw error
    throw coded('secret_invalid')
  }
  if (!stored || typeof stored !== 'object' || typeof stored.refresh_token !== 'string' || typeof stored.token_endpoint !== 'string' || typeof stored.client_id !== 'string' || typeof stored.resource !== 'string') {
    throw coded('secret_invalid')
  }
  assertEndpoint(stored.token_endpoint)
  assertEndpoint(stored.resource)
  if (stored.issuer !== undefined) assertEndpoint(stored.issuer)
  secretsSeen.add(stored.refresh_token)
  resources.set(secretName, stored.resource)
  return stored
}

// Each refresh token is submitted at most once, ever, whatever the lock does. Before submitting one, a
// process creates spent/<hash> exclusively, and the claim is never released or pruned: any attempt, even
// one that seems never to have left the machine (undici retries a 421 on a fresh connection by itself), may
// have reached Rails, and a pending token in one process is invisible to every other. A process that finds
// a token claimed never submits it and waits for an unclaimed successor in the vault instead. The hash is
// not a secret. One small file per refresh, about hourly, is about 9k files a year.
function spentDir() {
  return join(stateDir(), 'spent')
}

function spendPath(refreshToken) {
  return join(spentDir(), createHash('sha256').update(refreshToken).digest('hex').slice(0, 40))
}

function claimed(refreshToken) {
  return existsSync(spendPath(refreshToken))
}

// Returns the claim's path, or null when the token is already claimed.
function claimSpend(refreshToken, secretName) {
  mkdirSync(spentDir(), { recursive: true, mode: 0o700 })
  const path = spendPath(refreshToken)
  let fd
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') return null
    throw error
  }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, secret: secretName, at: new Date().toISOString() })) } finally {
    closeSync(fd)
  }
  return path
}

// A token-free check that the token endpoint's host answers, so a machine that is offline fails without
// claiming, and so without spending, its refresh token. Any HTTP answer counts as reachable. A failure
// between this check and the token request still keeps the claim, and the next refresh ends in
// reconnect_needed; that window is a few milliseconds wide.
async function preflight(tokenEndpoint) {
  try {
    const response = await fetch(new URL('/.well-known/oauth-authorization-server', tokenEndpoint), {
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    await response.body?.cancel().catch(() => {})
  } catch {
    throw coded('offline')
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Vault writes for one secret run one at a time, so an older rotated token never lands after a newer one.
function serialWrite(secretName, fn) {
  const next = (writes.get(secretName) || Promise.resolve()).catch(() => {}).then(fn)
  writes.set(secretName, next)
  return next
}

// A rotated refresh token is held in pendingRefresh until the vault has it, because the token it
// replaced is spent and the new one exists nowhere else. With check set, the vault is read first: if
// it already holds the new token there is nothing to do, and if it holds neither that token nor the
// one it replaced, someone connected again and the pending chain is dropped.
function savePending(secretName, backoffs = [], check = false) {
  return serialWrite(secretName, async () => {
    for (let attempt = 0; ; attempt++) {
      const entry = pendingRefresh.get(secretName)
      if (!entry) return
      try {
        const current = check ? (await readClient(secretName)).refresh_token : entry.from
        if (current === entry.from) await secretPut(secretName, JSON.stringify(entry.record))
        if (pendingRefresh.get(secretName) === entry) pendingRefresh.delete(secretName)
        return
      } catch {
        if (attempt >= backoffs.length) throw coded('secret_save_failed')
        await sleep(backoffs[attempt])
      }
    }
  })
}

// Uses the pending token when it is unclaimed, otherwise the vault's. A claimed token is never sent; the
// caller waits for a successor instead. Every claim is kept, whatever the answer: an error may come after
// Rails committed the rotation, and a 2xx without a new refresh token leaves this one claimed too, so the
// next refresh ends in reconnect_needed.
async function refreshOnce(secretName) {
  const pending = pendingRefresh.get(secretName)
  const fromPending = Boolean(pending && !claimed(pending.record.refresh_token))
  const stored = fromPending ? pending.record : await readClient(secretName)
  if (claimed(stored.refresh_token)) return { spent: stored.refresh_token }
  await preflight(stored.token_endpoint)
  if (!claimSpend(stored.refresh_token, secretName)) return { spent: stored.refresh_token }
  const token = await tokenRequest(stored.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: stored.client_id,
    resource: stored.resource,
  })
  remember(secretName, token.access_token, token.expires_in, stored.resource)
  if (!token.refresh_token) return token.access_token
  secretsSeen.add(token.refresh_token)
  pendingRefresh.set(secretName, {
    from: fromPending ? pending.from : stored.refresh_token,
    record: {
      client_id: stored.client_id,
      refresh_token: token.refresh_token,
      issuer: stored.issuer,
      resource: stored.resource,
      token_endpoint: stored.token_endpoint,
      connected_at: stored.connected_at,
    },
  })
  await savePending(secretName, [500, 2000])
  return token.access_token
}

// Returns only when the vault holds a token with no claim. A claimed vault token, older ones included, is
// never a successor. When the wait ends, a claim over a minute old is stuck: its holder got an answer it
// could not use, or died before saving the rotated token, and only connecting again clears it.
async function waitForSuccessor(secretName, spent) {
  let current = spent
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    await sleep(200)
    try {
      current = (await readClient(secretName)).refresh_token
    } catch (error) {
      if (error.code !== 'secret_unavailable') throw error
      continue
    }
    if (!claimed(current)) return
  }
  let age = 0
  try { age = Date.now() - statSync(spendPath(current)).mtimeMs } catch { /* unreadable: treat as fresh */ }
  throw coded(age > 60_000 ? 'reconnect_needed' : 'refresh_in_flight')
}

async function refreshAccess(secretName) {
  for (;;) {
    const outcome = await withLock(() => refreshOnce(secretName))
    if (typeof outcome === 'string') return outcome
    await waitForSuccessor(secretName, outcome.spent)
  }
}

export async function connect({
  issuer = 'https://rails.so',
  resource = 'https://unblock.rails.so/mcp',
  clientName = 'Unblock on Studio',
  secretName = 'rails-unblock-client',
  scope = 'runs:start actions:submit installations:read',
  openUrl,
  timeoutMs = 600000,
} = {}) {
  assertIssuer(issuer)
  const metadata = await discover(issuer)
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const { server, done, cancel } = waitForCode(state, timeoutMs)
  const approval = done.catch((error) => error)
  try {
    const port = await listen(server)
    const redirectUri = `http://127.0.0.1:${port}/callback`
    const clientId = await registerClient(metadata.registration_endpoint, {
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    })
    const authorize = new URL(metadata.authorization_endpoint)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', clientId)
    authorize.searchParams.set('redirect_uri', redirectUri)
    authorize.searchParams.set('scope', scope)
    authorize.searchParams.set('state', state)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('resource', resource)
    const authorizeUrl = authorize.href
    const opener = openUrl
      ? Promise.resolve(openUrl(authorizeUrl)).then(() => ({ ok: true }), (error) => ({ ok: false, error }))
      : null
    if (!opener) {
      console.error('Open this URL and approve:')
      console.error(authorizeUrl)
    }
    const code = await new Promise((resolve, reject) => {
      approval.then((value) => {
        if (value instanceof Error) reject(value)
        else resolve(value)
      })
      if (opener) opener.then((opened) => { if (!opened.ok) reject(opened.error) })
    })
    if (opener) {
      const opened = await opener
      if (!opened.ok) throw opened.error
    }
    const token = await tokenRequest(metadata.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    })
    if (!token.refresh_token) throw coded('invalid_grant')
    const connectedAt = new Date().toISOString()
    pendingRefresh.delete(secretName)
    await serialWrite(secretName, () => secretPut(secretName, JSON.stringify({
      client_id: clientId,
      refresh_token: token.refresh_token,
      issuer,
      resource,
      token_endpoint: metadata.token_endpoint,
      connected_at: connectedAt,
    })))
    remember(secretName, token.access_token, token.expires_in, resource)
    return { client_id: clientId, issuer, resource }
  } finally {
    cancel()
    server.close()
  }
}

export async function railsAccessToken({ secretName = 'rails-unblock-client', refresh = false } = {}) {
  if (pendingRefresh.has(secretName)) await savePending(secretName, [], true).catch(() => {})
  if (!refresh && usable(secretName)) return cache.get(secretName).accessToken
  const current = flights.get(secretName)
  if (current) return current
  const flight = refreshAccess(secretName).finally(() => {
    if (flights.get(secretName) === flight) flights.delete(secretName)
  })
  flights.set(secretName, flight)
  return flight
}

export async function railsResource(secretName = 'rails-unblock-client') {
  const known = resources.get(secretName)
  if (known) return known
  const stored = await readClient(secretName)
  return stored.resource
}

/** True when text carries a Rails token this process has held, so callers can drop it from error output. */
export function railsSecretIn(text) {
  const value = String(text)
  for (const secret of secretsSeen) if (secret && value.includes(secret)) return true
  return false
}
