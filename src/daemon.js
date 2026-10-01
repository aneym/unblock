import { processStarts, sameProcess } from './origin-process.js'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { guardedAnswerNotice, recheckNotice, originFinishedNotice } from './pane-notice.js'
import { createScopeRoutes } from './scope.js'
import { ASSET_ID } from './scope-assets.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, lstatSync, fstatSync, openSync, closeSync, readSync, writeSync, renameSync, unlinkSync, chmodSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { applyConfig, daemonRoot } from './config.js'
import { createLivedocApprovals } from './scope-approvals.js'
import { APPROVAL_PURPOSES, normalizeOrigin, optionalScrub, validateAsk, validateUpdate, ValidationError } from './schema.js'
import { SecretStore } from './secrets.js'
import { defaultReadKey, mintVoiceToken, mintXaiToken, mintOpenAiToken, buildLiveSession, connectLiveCall } from './voice-token.js'
import { createSpendLedger, rateFor } from './voice-spend.js'
import { CLOSED_TO_ANSWERS, finished, Store } from './store.js'

const VERSION = '0.1.0'
const HOST = '127.0.0.1'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WEB_SRC = join(ROOT, 'web')
const WEB_DIST = join(WEB_SRC, 'dist')

/**
 * The panel is a Vite/React build, so what ships is `web/dist`. The source
 * tree is the fallback for a checkout where nobody has built yet — the daemon
 * should still serve something rather than 404 the whole UI.
 */
function webRoot() {
  return existsSync(join(WEB_DIST, 'index.html')) ? WEB_DIST : WEB_SRC
}
const MAX_BODY_BYTES = 1024 * 1024

function stateDir() {
  return (
    process.env.UNBLOCK_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')
  )
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const CLIENT_LOG_MAX_BYTES = 1024 * 1024

/**
 * The page reports its own network failures here once it can reach the daemon
 * again, so a "Load failed" on a phone leaves a trace on Studio. Only what the
 * page says about the request: path, attempt, error text, online and
 * visibility. Never a body or a value. Capped, so a loop cannot fill the disk.
 */
function appendClientLog(req, body) {
  const file = join(stateDir(), 'client-errors.log')
  try { if (statSync(file).size > CLIENT_LOG_MAX_BYTES) return 0 } catch { /* first write */ }
  const clip = (value, max = 200) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').slice(0, max)
  const events = Array.isArray(body.events) ? body.events.slice(0, 20) : []
  const agent = clip(req.headers['user-agent'])
  const lines = events.map((event) => [
    new Date().toISOString(), clip(event.at, 40), clip(event.path, 80), clip(event.outcome, 40),
    clip(event.attempts, 4), clip(event.message), clip(event.online, 8), clip(event.visibility, 12), agent,
  ].join('\t') + '\n')
  if (lines.length) appendFileSync(file, lines.join(''), { mode: 0o600 })
  return lines.length
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body is too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('invalid JSON')
    error.status = 400
    throw error
  }
}

/**
 * A shared secret minted at startup and stored 0600 alongside the port. Local
 * clients (CLI, plugin, MCP) read it from that file; the browser never sees it
 * and uses a link token instead.
 *
 * This exists because binding 127.0.0.1 stopped being the boundary the moment
 * the README suggested putting the daemon behind a tunnel. Only /u/:token was
 * gated, so anyone with a tunnel URL could read every ask and answer, mint
 * themselves tokens, and feed a parked agent an attacker-chosen "human
 * verified" answer.
 */
export function loadOrCreateSecret() {
  const file = join(stateDir(), 'auth')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    /* first run */
  }
  const secret = randomBytes(32).toString('base64url')
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${secret}\n`, { mode: 0o600 })
  return secret
}

/** Separate from the agent bearer. Only the rails-sync sidecar should hold this. */
export function loadOrCreateRailsSyncSecret() {
  const file = join(stateDir(), 'rails-sync-auth')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    /* first run */
  }
  const secret = randomBytes(32).toString('base64url')
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${secret}\n`, { mode: 0o600 })
  return secret
}

/** Constant-time compare so a token cannot be recovered by timing. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Identity from a trusted reverse proxy, or null.
 *
 * `tailscale serve` injects tailscale-user-login / -name on every proxied
 * request, so on a tailnet the person is already authenticated by Tailscale
 * and a URL token adds nothing but a thing to lose.
 *
 * The header is only trusted when the request ALSO arrived on the configured
 * public origin. A direct hit on 127.0.0.1 carries a loopback Host, so a local
 * process cannot forge its way in by setting the header alone.
 */
function proxyIdentity(req) {
  if (process.env.UNBLOCK_TRUSTED_PROXY !== 'tailscale') return null
  const publicOrigin = process.env.UNBLOCK_PUBLIC_ORIGIN
  if (!publicOrigin) return null
  let expected
  try {
    expected = new URL(publicOrigin).hostname
  } catch {
    return null
  }
  const host = String(req.headers.host || '').replace(/:\d+$/, '')
  if (host !== expected) return null

  const login = req.headers['tailscale-user-login']
  if (typeof login !== 'string' || !login.includes('@')) return null

  const allowed = process.env.UNBLOCK_ALLOWED_USERS
  if (!allowed || !allowed.split(',').map((u) => u.trim()).includes(login)) return null

  return { login, name: req.headers['tailscale-user-name'] || login }
}

function isAuthorized(req, secret) {
  if (proxyIdentity(req)) return true
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return sameSecret(header.slice(7).trim(), secret)
  }
  const alt = req.headers['x-unblock-auth']
  return typeof alt === 'string' && sameSecret(alt.trim(), secret)
}

/** Trusted-proxy human identity, never the bearer secret an agent uses. */
function requireHumanPath(req) {
  if (!proxyIdentity(req)) { const error = new Error('answer this on the page'); error.code = 'HUMAN_ONLY'; error.status = 403; throw error }
}

/**
 * Reject a request whose Host is not a loopback name. Without this, a page on
 * an attacker domain can rebind DNS to 127.0.0.1, become same-origin, and read
 * the whole queue — the Origin check does not help because it only ran on
 * writes. UNBLOCK_PUBLIC_ORIGIN lets a deliberate tunnel or tailnet host
 * through, which is also what makes the documented remote flow submit at all.
 */
function validateHostHeader(req) {
  const host = req.headers.host
  if (!host) return false
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (hostname === HOST || hostname === 'localhost' || hostname === '::1') return true
  const allowed = process.env.UNBLOCK_PUBLIC_ORIGIN
  if (!allowed) return false
  try {
    return new URL(allowed).hostname === hostname
  } catch {
    return false
  }
}

function validateOriginHeader(req, port) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === 'http:' && parsed.hostname === HOST && parsed.port === String(port)) {
      return true
    }
    const allowed = process.env.UNBLOCK_PUBLIC_ORIGIN
    if (allowed) {
      const permitted = new URL(allowed)
      return permitted.origin === parsed.origin
    }
    return false
  } catch {
    return false
  }
}

function routeTicket(pathname, suffix = '') {
  const match = pathname.match(new RegExp(`^/api/asks/([^/]+)${suffix}$`))
  return match ? decodeURIComponent(match[1]) : null
}

function parseStatuses(value) {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : ['open', 'answered']
}

function isTrue(value) {
  return value === 'true' || value === '1'
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

/**
 * Resolve a request path to a file inside the web root, or null.
 *
 * The resolved path is checked to still be INSIDE the root after resolution,
 * so an encoded `..` cannot walk out of it. Only known extensions are served.
 */
function staticAsset(pathname) {
  const rel = pathname.replace(/^\/(?:web\/)?/, '')
  if (!rel || rel.includes('\0')) return null
  const ext = extname(rel)
  if (!MIME[ext]) return null
  const root = webRoot()
  const full = resolve(root, rel)
  if (full !== root && !full.startsWith(root + sep)) return null
  if (!existsSync(full)) return null
  return { full, ext }
}

function sendAsset(res, { full, ext }) {
  try {
    const body = readFileSync(full)
    // Vite fingerprints filenames, so hashed assets are safe to cache hard;
    // anything unhashed must not be.
    const hashed = /\.[0-9a-zA-Z_-]{8,}\.[a-z0-9]+$/.test(full)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
    })
    return res.end(body)
  } catch {
    return notFound(res)
  }
}

function notFound(res) {
  sendJson(res, 404, { error: 'not found' })
}

function expiredPage(res) {
  sendText(
    res,
    410,
    '<!doctype html><html><head><meta charset="utf-8"><title>Expired</title></head><body><p>this link has expired</p></body></html>',
    'text/html; charset=utf-8',
  )
}

function safeSecretAnswer(ask, values, records) {
  const safe = { ...values }
  const refs = {}
  for (const [name, record] of records) {
    safe[name] = {
      ref: record.ref,
      store: record.store,
      env_name: record.env_name,
      resolve: record.resolve,
      hint: record.hint,
    }
    refs[name] = true
  }
  return { safe, refs }
}

function runIssueCommand(binary, argv, body) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, argv, { timeout: 20_000, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin.on('error', reject)
    child.stdin.end(body)
  })
}

export async function startDaemon({ port, secretStore: injectedSecretStore, issueRunner = runIssueCommand } = {}) {
  // The config file fills in whatever the spawner's environment left unset,
  // so the daemon is reachable on its public origin no matter who started it.
  const config = applyConfig()
  const configuredRepingMs = Number(process.env.UNBLOCK_REPING_AFTER_MS)
  const repingAfterMs = Number.isSafeInteger(configuredRepingMs) && configuredRepingMs > 0 ? configuredRepingMs : 15 * 60 * 1000
  const configuredRecheckMs = Number(process.env.UNBLOCK_RECHECK_AFTER_MS)
  const recheckAfterMs = Number.isSafeInteger(configuredRecheckMs) && configuredRecheckMs > 0 ? configuredRecheckMs : 30 * 60 * 1000
  const configuredWeeklyMs = Number(process.env.UNBLOCK_WEEKLY_AFTER_MS)
  const weeklyAfterMs = Number.isSafeInteger(configuredWeeklyMs) && configuredWeeklyMs > 0 ? configuredWeeklyMs : 72 * 60 * 60 * 1000
  const interval = (name, fallback) => { const value = Number(process.env[name]); return Number.isSafeInteger(value) && value > 0 ? value : fallback }
  const sweepMs = interval('UNBLOCK_SWEEP_MS', 60000)
  const replyMs = interval('UNBLOCK_RECHECK_REPLY_MS', 600000)
  const linkCheckMs = interval('UNBLOCK_LINK_CHECK_MS', 300000)
  const linkReads = new Map()
  const routeFailures = new Map()
  const refuseWorktreeOrigins = process.env.UNBLOCK_REFUSE_WORKTREE_ORIGINS === 'true'
  if (port === undefined) port = Number(process.env.UNBLOCK_PORT || 4488)
  const authSecret = loadOrCreateSecret()
  const railsSyncSecret = loadOrCreateRailsSyncSecret()
  function railsSyncProof(req) {
    const header = req.headers['x-unblock-rails-sync']
    return typeof header === 'string' && sameSecret(header.trim(), railsSyncSecret)
  }
  function rejectRailsWithoutProof(req, res, body) {
    if (body?.via !== 'rails' || railsSyncProof(req)) return false
    sendJson(res, 403, { code: 'RAILS_SYNC_PROOF' })
    return true
  }
  const relaySecret = process.env.UNBLOCK_ADMIN_RELAY_TOKEN || await defaultReadKey(process.env.UNBLOCK_ADMIN_RELAY_KEY_REF || 'unblock-admin-relay', 'UNBLOCK_ADMIN_RELAY_TOKEN')
  function relayIdentity(req) {
    if (relaySecret.length < 32 || !sameSecret(req.headers['x-unblock-relay'], relaySecret)) return null
    if (Object.keys(req.headers).some((header) => header === 'x-forwarded-for' || header === 'x-forwarded-host' || header.startsWith('tailscale-user-'))) return null
    const host = String(req.headers.host || '')
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) && host !== '::1') return null
    return { login: process.env.UNBLOCK_ALLOWED_USERS?.split(',')[0].trim() || 'alex', name: 'Alex', via: 'admin' }
  }
  const store = new Store()
  const scopeRoutes = createScopeRoutes({ store, webRoot, sendJson, sendText, readJson, requireHumanPath, proxyIdentity, relayIdentity })
  // A delayed store can be injected by tests to exercise the real async put boundary.
  const secretStore = injectedSecretStore ?? new SecretStore({ backend: process.env.UNBLOCK_SECRET_BACKEND || 'auto' })
  // Resolve the secret backend now rather than on the first /api/health. In
  // `auto` mode that probe runs `op whoami`, which can take seconds when
  // 1Password is installed but signed out — long enough that every spawner's
  // readiness poll gave up on a daemon that was in fact already serving.
  secretStore.backend().catch(() => {})
  const clients = new Set()
  const voiceKeyCache = new Map()
  const connectedLiveSessions = new Set()
  const connectingLiveSessions = new Set()
  // Listeners on ONE ask, keyed by ticket. The queue stream above says how many
  // asks are open; this one says what is happening inside a single ask while
  // the human fills it in, which is what an agent watching its own ask needs.
  const askClients = new Map()
  const ticketTails = new Map()
  // The store queues every secret a state change leaves undelivered, in that
  // change's own transaction. Deleting is then just draining the queue: right
  // after the change, and from the sweeper for anything that failed or was cut
  // off by a restart. Entries already being deleted are skipped.
  async function deleteSecret(record) {
    return Promise.resolve().then(() => secretStore.delete(record)).then((ok) => ok !== false, () => false)
  }
  const deleting = new Set()
  async function flushSecretDeletes() {
    if (unqueued.length) {
      try { store.queueSecretDeletes(unqueued); unqueued.length = 0 } catch { /* next time */ }
    }
    const due = store.pendingSecretDeletes().filter(({ id }) => !deleting.has(id))
    for (const { id } of due) deleting.add(id)
    await Promise.all(due.map(async ({ id, record }) => {
      try { if (await deleteSecret(record)) store.clearSecretDelete(id) } finally { deleting.delete(id) }
    }))
  }
  // A failed answer rolled back, so nothing queued its puts: queue them now.
  // If even that write fails, delete directly, and hold any delete that also
  // failed in memory until the queue accepts it.
  const unqueued = []
  async function compensate(records) {
    try { store.queueSecretDeletes(records) } catch {
      const results = await Promise.all(records.map(deleteSecret))
      unqueued.push(...records.filter((_, index) => !results[index]))
      return
    }
    await flushSecretDeletes()
  }
  // Queue only operations on the same ticket; cleanup works even on throw.
  async function withTicket(ticket, operation) {
    const previous = ticketTails.get(ticket) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    ticketTails.set(ticket, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (ticketTails.get(ticket) === tail) ticketTails.delete(ticket)
    }
  }
  let actualPort = port
  let isClosed = false

  const queueState = () => {
    const asks = store.list({ profile: '*', status: ['open', 'answered'] }).filter((ask) => ask.status === 'answered' || (ask.set_aside_at == null && ask.weekly_at == null))
    return {
      open: asks.length,
      gating: asks.filter((ask) => ask.gating).length,
      hidden: 0,
    }
  }

  const emitQueue = () => {
    const message = `event: queue\ndata: ${JSON.stringify(queueState())}\n\n`
    for (const client of clients) client.write(message)
  }

  /**
   * What a watcher gets on every event: enough to decide whether to act
   * without a follow-up GET. No secret can be in here — a draft never holds
   * one, and an answered secret is already a reference by the time it lands.
   */
  const askEvent = (ask) => ({
    ticket: ask.ticket,
    status: ask.status,
    draft: ask.draft,
    draft_reply: ask.draft_reply,
    draft_rev: ask.draft_rev,
    field_context: ask.field_context,
    draft_updated_at: ask.draft_updated_at,
    updated_at: ask.updated_at,
    missing: ask.missing,
  })

  const emitAsk = (ask, event) => {
    const listeners = ask && askClients.get(ask.ticket)
    if (!listeners?.size) return
    const message = `event: ${event}\ndata: ${JSON.stringify(askEvent(ask))}\n\n`
    for (const client of listeners) client.write(message)
  }

  /** One path for every draft write, so every transport emits the same event. */
  function applyDraft(ticket, body, answeredVia) {
    const existing = store.get(ticket)
    if (APPROVAL_PURPOSES.includes(existing?.purpose) &&
        (!answeredVia || answeredVia === 'local' || answeredVia === 'share-link:local')) {
      const error = new Error('answer this on the page'); error.code = 'HUMAN_ONLY'; error.status = 403; throw error
    }
    const ask = store.saveDraft(
      ticket,
      body.values || {},
      scrubFieldContext(body.field_context),
      draftReply(body),
      body.base_rev,
    )
    emitAsk(ask, 'draft')
    emitQueue()
    return ask
  }

  async function bounceAsk(ticket, reply, answeredVia, revision, fieldBounce) {
    const ask = store.get(ticket)
    if (!ask) return null
    if (APPROVAL_PURPOSES.includes(ask.purpose)) {
      const error = (code, message, status) => { const err = new Error(message); err.code = code; err.status = status; throw err }
      if (revision !== ask.revision) error('STALE_REVISION', 'The agent changed this ask. Check it again.', 409)
      if (!answeredVia || answeredVia === 'local' || answeredVia === 'share-link:local') error('HUMAN_ONLY', 'answer this on the page', 403)
      if (fieldBounce && Object.keys(fieldBounce).length) error('WHOLE_ASK_ONLY', 'send the entire ask back', 400)
      if (typeof reply !== 'string' || !reply.trim()) error('WHOLE_ASK_ONLY', 'send the entire ask back with a note', 400)
    }
    const bounced = store.bounce(ticket, optionalScrub(reply, 1000))
    await flushSecretDeletes()
    emitAsk(bounced, 'sent_back')
    return { ask: bounced, complete: true, bounced: true }
  }

/**
 * Per-field context typed by the human. It arrives outside validateAsk, so it
 * is scrubbed here. An empty string survives as '' on purpose: it is the
 * erase signal the store acts on.
 */
function scrubFieldContext(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out = {}
  for (const [name, note] of Object.entries(raw)) {
    if (typeof note !== 'string') continue
    out[name] = optionalScrub(note, 600) ?? ''
  }
  return out
}

/**
 * Per-field send-backs typed by the human. Same trust boundary as field
 * context: scrubbed here because it arrives outside validateAsk. An empty
 * note survives as '' (the store turns it into a bare `true`).
 */
function scrubFieldBounce(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out = {}
  for (const [name, note] of Object.entries(raw)) {
    out[name] = typeof note === 'string' ? (optionalScrub(note, 600) ?? '') : ''
  }
  return out
}

  async function routeFinished(ask, starts = processStarts([ask.origin?.pid])) {
    if (starts === null || ask.status !== 'answered' || !ask.origin?.pid || ask.routed_at || sameProcess(ask.origin.pid, ask.origin.pid_start, starts)) return ask
    const attempts = routeFailures.get(ask.ticket) || 0
    if (attempts >= 3) return ask
    if (ask.origin.pane_id && await originFinishedNotice(ask) === 'sent') {
      const routed = store.markRouted(ask.ticket, ask.origin.pane_id)
      emitAsk(routed, routed.status)
      emitQueue()
      return routed
    }
    routeFailures.set(ask.ticket, attempts + 1)
    if (attempts + 1 === 3) console.error(`unblock: answer routing failed for ${ask.ticket}`)
    return ask
  }

  async function deadReference(ask) {
    if (ask.purpose === 'permission' && ask.permission?.path && isAbsolute(ask.permission.path) && !existsSync(ask.permission.path)) return 'path_gone'
    for (const ref of ask.closes_on || []) {
      if (ref.startsWith('scope:')) {
        const [, slug, id] = ref.match(/^scope:([^#]+)#(T\d+)$/)
        try {
          const doc = JSON.parse(readFileSync(join(process.env.UNBLOCK_SCOPING_DIR || join(homedir(), '.agent-rails/scoping'), slug, 'scope.json'), 'utf8'))
          if (doc.threads?.some((thread) => thread.id === id && thread.status === 'resolved')) return 'thread_resolved'
        } catch {}
      } else {
        const previous = linkReads.get(ref)
        if (previous && Date.now() - previous.at < linkCheckMs) {
          if (previous.closed) return 'link_closed'
          continue
        }
        const entry = { at: Date.now(), closed: false }
        linkReads.set(ref, entry)
        try {
          const gh = process.env.UNBLOCK_GH || (existsSync(join(homedir(), '.local/bin/gh')) ? join(homedir(), '.local/bin/gh') : '/opt/homebrew/bin/gh')
          const output = await new Promise((resolve, reject) => execFile(gh, [ref.includes('/pull/') ? 'pr' : 'issue', 'view', ref, '--json', 'state'], { timeout: 20000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
          entry.closed = ['MERGED', 'CLOSED'].includes(JSON.parse(output).state)
          if (entry.closed) return 'link_closed'
        } catch { console.error(`unblock: link check failed for ${ask.ticket}`) }
      }
    }
  }

async function answerAsk(ticket, values, reply, fieldContext, fieldBounce, revision, answeredVia) {
  return withTicket(ticket, async () => {
    const ask = store.get(ticket)
    if (!ask) return null
    if (answeredVia?.startsWith('admin:')) {
      if (ask.fields.some((field) => ['secret', 'paste'].includes(field.type) && Object.hasOwn(values, field.name))) {
        const error = new Error('Admin cannot submit secret or paste values'); error.code = 'RELAY_NO_SECRETS'; error.status = 400; throw error
      }
      if (ask.status !== 'open') { const error = new Error('Ask is not open'); error.code = 'ASK_NOT_OPEN'; error.status = 409; throw error }
      if (revision !== ask.revision) { const error = new Error('The agent changed this ask. Check it again.'); error.code = 'STALE_REVISION'; error.status = 409; throw error }
    }
    if (APPROVAL_PURPOSES.includes(ask.purpose)) {
      // Reject stale or agent-supplied approvals before processing any values.
      if (revision !== ask.revision) { const error = new Error('The agent changed this ask. Check it again.'); error.code = 'STALE_REVISION'; error.status = 409; throw error }
      if (answeredVia === 'local' || answeredVia === 'share-link:local') { const error = new Error('answer this on the page'); error.code = 'HUMAN_ONLY'; error.status = 403; throw error }
    }
    // Before any secret is stored: a page retrying a send whose reply it lost
    // must not write the secret again once the agent already has the answer.
    if (CLOSED_TO_ANSWERS.includes(ask.status)) throw finished(ask)
    const records = []
    let result
    try {
      for (const field of ask.fields) {
        const value = values?.[field.name]
        if (field.type === 'secret' && typeof value === 'string' && value !== '') {
          let record
          try {
            record = await secretStore.put({
              name: field.name,
              value,
              ticket: ask.ticket,
              envName: field.env_name,
            })
          } catch (cause) {
            const error = new Error('secret storage failed', { cause })
            error.status = 502
            throw error
          }
          if (!record?.ref) {
            const error = new Error('secret storage returned no reference')
            error.status = 502
            throw error
          }
          records.push([field.name, record])
        }
      }
      const { safe, refs } = safeSecretAnswer(ask, values || {}, records)
      result = store.answer(ticket, safe, {
        puts: records.map(([, record]) => record),
        refs,
        reply: optionalScrub(reply, 1000),
        fieldContext: scrubFieldContext(fieldContext),
        fieldBounce: scrubFieldBounce(fieldBounce),
        revision, answeredVia,
      })
    } catch (error) {
      await compensate(records.map(([, record]) => record)).catch(() => {})
      throw error
    }
    // The answer queued any secret it replaced, sent back or did not commit.
    await flushSecretDeletes()
    if (result.ask.status === 'answered') result.ask = await routeFinished(result.ask)
    emitAsk(result.ask, result.ask.status)
    return result
  })
}

  /** The reply drafts alongside the fields; '' erases, undefined leaves it. */
  function draftReply(body) {
    if (typeof body.reply !== 'string') return undefined
    return optionalScrub(body.reply, 1000) ?? ''
  }

  /**
   * Render the panel. `token` is set for a link-scoped view; `who` is set when
   * a trusted proxy already identified the viewer, in which case the page uses
   * the plain /api routes and there is no token anywhere in the URL.
   */
  function servePanel(res, token, who) {
    let html
    try {
      html = readFileSync(join(webRoot(), 'index.html'), 'utf8')
    } catch {
      html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>'
    }
    const boot = {
      token: token ?? null,
      viewer: who ? { login: who.login, name: who.name } : null,
    }
    const injection =
      `<script>window.__UNBLOCK_TOKEN__=${JSON.stringify(token ?? '')};` +
      `window.__UNBLOCK_BOOT__=${JSON.stringify(boot)};</script>`
    html = html.includes('</head>') ? html.replace('</head>', `${injection}</head>`) : `${injection}${html}`
    return sendText(res, 200, html, 'text/html; charset=utf-8')
  }

  async function handleTokenRoute(req, res, url, token, tail) {
    // The built page is served at /u/<token> with Vite's relative base, so the
    // browser resolves ./assets/x.js against /u/ and asks for /u/assets/x.js.
    // Without this the token route reads "assets" as a link id, returns 410,
    // and the panel renders as a blank page — which a curl of the HTML does
    // not catch, because the HTML itself is fine.
    if (req.method === 'GET') {
      const nested = staticAsset(tail)
      if (nested) return sendAsset(res, nested)
      const viaToken = staticAsset(`/${token}${tail}`)
      if (viaToken) return sendAsset(res, viaToken)
    }

    const link = store.resolveLink(token)
    if (!link) return expiredPage(res)
    const scopedAsk = link.ask_id ? store.get(link.ask_id) : null

    if (tail === '' && req.method === 'GET') {
      return servePanel(res, token, null)
    }

    if (tail === '/api/queue' && req.method === 'GET') {
      const profile = url.searchParams.get('profile') || '*'
      const project = url.searchParams.get('project') || undefined
      const asks = scopedAsk
        ? [scopedAsk]
        : store.list({ profile, project, status: ['open', 'answered'] })
      return sendJson(res, 200, { asks, hidden: store.countHidden(profile), profile })
    }

    if (tail === '/api/client-log' && req.method === 'POST') {
      return sendJson(res, 200, { logged: appendClientLog(req, await readJson(req)) })
    }

    if ((tail === '/api/answer' || tail === '/api/draft') && req.method === 'POST') {
      const body = await readJson(req)
      // The body's ticket is read FIRST so the scope check below can fire.
      // With the scoped ticket taking precedence, a body naming a different
      // ask was silently redirected onto the scoped one — its values landed
      // on an ask the sender never saw — and the 403 branch was unreachable.
      const ticket = body.ticket || scopedAsk?.ticket
      if (!ticket) return sendJson(res, 400, { error: 'ticket is required' })
      if (scopedAsk && ticket !== scopedAsk.ticket) return sendJson(res, 403, { error: 'link is scoped to another ask' })
      const ask = store.get(ticket)
      if (!ask) return notFound(res)
      if (tail === '/api/draft') {
        return sendJson(res, 200, { ask: await withTicket(ticket, () => applyDraft(ticket, body, `share-link:${link.minted_by}`)) })
      }
      const result = body.bounce
        ? await withTicket(ticket, () => bounceAsk(ticket, body.reply, `share-link:${link.minted_by}`, body.revision, body.field_bounce))
        : await answerAsk(ticket, body.values || {}, body.reply, body.field_context, body.field_bounce, body.revision, `share-link:${link.minted_by}`)
      // Burn on ANY complete answer, not just a ticket-scoped one. A link
      // minted with no ticket — what `unblock link` and the TUI both produce —
      // used to stay live after submitting, still serving every ask's answers.
      if (result.complete) store.burnLink(token)
      emitQueue()
      return sendJson(res, 200, result)
    }

    notFound(res)
  }

  async function handle(req, res) {
    const relay = relayIdentity(req)
    if (req.headers['x-unblock-relay'] !== undefined && !relay) {
      return sendJson(res, 401, { error: 'unauthorized' })
    }
    if (!validateHostHeader(req)) {
      return sendJson(res, 403, { error: 'invalid host' })
    }
    if (!validateOriginHeader(req, actualPort)) {
      return sendJson(res, 403, { error: 'invalid origin' })
    }
    const url = new URL(req.url, `http://${HOST}:${actualPort}`)
    const pathname = url.pathname

    if (relay) {
      const slug = '[a-z0-9][a-z0-9-]{0,63}'
      const allowed = req.method === 'GET'
        ? pathname === '/api/scope' || new RegExp(`^/api/scope/${slug}(?:/assets/${ASSET_ID.source.slice(1, -1)})?$`).test(pathname)
        : req.method === 'POST' && (routeTicket(pathname, '/answer') || new RegExp(`^/api/scope/${slug}/(?:assets|approve|lane-note|threads(?:/T[1-9][0-9]*/(?:reply|resolve|reject|park))?)$`).test(pathname))
      if (!allowed) return sendJson(res, 403, { code: 'RELAY_SCOPE_ONLY' })
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      // Health must answer fast: every spawner polls it to decide whether
      // the daemon is up. Wait briefly for the secret-backend probe, and if
      // 1Password is still deciding, report 'auto' rather than hang.
      const backend = await Promise.race([
        secretStore.backend(),
        new Promise((r) => setTimeout(() => r(secretStore.backendIfResolved()), 400).unref()),
      ])
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        backend,
        // Clients use this to build ONE stable answer URL instead of minting a
        // throwaway token for every ask.
        public_origin: process.env.UNBLOCK_PUBLIC_ORIGIN ?? null,
        scope_link_template: process.env.UNBLOCK_SCOPE_LINK_TEMPLATE || null,
        // Which viewer identity, if any, the daemon trusts, and whether the
        // settings came from the config file — so a wrong deployment is
        // visible from one curl instead of a 403 hunt.
        trusted_proxy: process.env.UNBLOCK_TRUSTED_PROXY || null,
        config: { path: config.path, present: config.present, applied: config.applied },
      })
    }

    // Everything under /api needs the daemon secret. /u/:token routes carry
    // their own capability and are checked in handleTokenRoute; the page's two
    // static assets are public because they contain nothing.
    //
    // Default deny: a route added later is authenticated unless someone
    // deliberately exempts it, rather than open unless someone remembers.
    const isPublic =
      pathname === '/api/health' ||
      (pathname === '/s' || pathname.startsWith('/s/')) ||
      // Built panel assets carry nothing secret; the page itself is gated by
      // its link token, which is checked in handleTokenRoute.
      staticAsset(pathname) !== null ||
      pathname.startsWith('/u/')
    if (!isPublic && !relay && !isAuthorized(req, authSecret)) {
      return sendJson(res, 401, { error: 'unauthorized' })
    }

    if (pathname === '/api/scope' || pathname.startsWith('/api/scope/') || pathname === '/s' || pathname.startsWith('/s/')) {
      return scopeRoutes.handle(req, res, url)
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      clients.add(res)
      res.write(`event: queue\ndata: ${JSON.stringify(queueState())}\n\n`)
      req.on('close', () => clients.delete(res))
      return
    }

    if (req.method === 'POST' && pathname === '/api/asks') {
      const body = await readJson(req)
      const origin = normalizeOrigin(body.origin)
      const paths = [origin.cwd, origin.repo].filter(Boolean)
      if (origin.kind?.toLowerCase() === 'eval' || paths.some((path) =>
        path === '/Users/aneyman/.agent-rails/orch-lab' || path.startsWith('/Users/aneyman/.agent-rails/orch-lab/'))) {
        return sendJson(res, 403, { error: 'eval seats cannot file asks for Alex', code: 'EVAL_ORIGIN' })
      }
      if (refuseWorktreeOrigins && paths.some((path) =>
        path.includes('-wt/') || path.includes('/factory-worktrees/') || path.includes('/.claude/worktrees/'))) {
        return sendJson(res, 403, { error: 'worktree origins cannot file asks while refuseWorktreeOrigins is enabled', code: 'WORKTREE_ORIGIN' })
      }
      if (origin.pid) {
        const start = processStarts([origin.pid])?.get(origin.pid)
        if (start) origin.pid_start = start
        else delete origin.pid
      }
      const ask = store.create(validateAsk(body.ask), origin)
      emitQueue()
      return sendJson(res, 201, ask)
    }

    if (req.method === 'GET' && pathname === '/api/asks') {
      const profile = url.searchParams.get('profile') || '*'
      const asks = store.list({
        profile,
        project: url.searchParams.get('project') || undefined,
        status: parseStatuses(url.searchParams.get('status')),
        includeClosed: isTrue(url.searchParams.get('includeClosed')),
      })
      return sendJson(res, 200, { asks, hidden: store.countHidden(profile) })
    }

    let ticket = routeTicket(pathname, '/keep')
    if (ticket && req.method === 'POST') {
      const body = await readJson(req)
      const ask = await withTicket(ticket, () => {
        const existing = store.get(ticket)
        if (!existing) return null
        let origin
        if (Number.isSafeInteger(body.pid) && body.pid > 0) {
          const start = processStarts([body.pid])?.get(body.pid)
          if (start) origin = { ...existing.origin, pid: body.pid, pid_start: start }
        }
        return store.keep(ticket, origin)
      })
      if (!ask) return sendJson(res, 404, { error: 'not found' })
      emitAsk(ask, ask.status); emitQueue()
      return sendJson(res, 200, { ask })
    }
    ticket = routeTicket(pathname, '/pay-claim')
    if (ticket && req.method === 'POST') return sendJson(res, 200, await withTicket(ticket, () => store.payClaim(ticket)))

    ticket = routeTicket(pathname, '/receipt')
    if (ticket && req.method === 'POST') {
      if (!/^ub_[a-z0-9]{6}$/.test(ticket)) return sendJson(res, 400, { error: 'invalid ticket' })
      const body = await readJson(req)
      const isSpend = body.spend_request_id !== undefined || body.spend_status !== undefined
      if (isSpend) {
        if (typeof body.spend_request_id !== 'string' || !body.spend_request_id ||
            typeof body.spend_status !== 'string' || !body.spend_status || Object.keys(body).some((key) => !['spend_request_id','spend_status'].includes(key))) {
          return sendJson(res, 400, { error: 'invalid spend receipt' })
        }
        return sendJson(res, 200, { ask: await withTicket(ticket, () => store.receipt(ticket, body)) })
      }
      if (Object.keys(body).some((key) => !['final_url', 'before', 'after'].includes(key)) ||
          (body.final_url !== undefined && (typeof body.final_url !== 'string' || !/^https:\/\//.test(body.final_url)))) {
        return sendJson(res, 400, { error: 'invalid receipt' })
      }
      // Authorize, write the images and record the receipt under one ticket lock, so two receipts cannot interleave.
      return await withTicket(ticket, () => {
        const ask = store.get(ticket)
        if (!ask || ask.purpose !== 'consent' || !['answered', 'collected', 'orphaned'].includes(ask.status) || ask.answers.verdict !== 'approve') {
          return sendJson(res, 409, { error: 'receipt not allowed', code: 'RECEIPT_NOT_ALLOWED' })
        }
        const data = { ...(body.final_url === undefined ? {} : { final_url: body.final_url }) }
        const images = []
        for (const name of ['before', 'after']) {
          if (body[name] === undefined) continue
          const path = body[name]
          let info
          try { if (typeof path === 'string' && path.startsWith('/')) info = lstatSync(path) } catch { /* invalid path */ }
          if (!info?.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024) {
            return sendJson(res, 400, { error: 'invalid PNG file' })
          }
          const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          let bytes
          try { if (!fstatSync(fd).isFile() || fstatSync(fd).size > 5 * 1024 * 1024) return sendJson(res, 400, { error: 'invalid PNG file' })
            bytes = Buffer.allocUnsafe(5 * 1024 * 1024 + 1); const size = readSync(fd, bytes, 0, bytes.length, 0); bytes = bytes.subarray(0, size) }
          finally { closeSync(fd) }
          if (bytes.length > 5 * 1024 * 1024 || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return sendJson(res, 400, { error: 'invalid PNG file' })
          images.push([name, bytes]); data[name] = true
        }
        const dir = join(stateDir(), 'receipts', ticket)
        const root = join(stateDir(), 'receipts')
        // lstat before chmod or writing: neither directory may redirect to another tree.
        for (const directory of [root, dir]) {
          try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
          const info = lstatSync(directory)
          if (info.isSymbolicLink() || !info.isDirectory()) return sendJson(res, 400, { error: 'invalid receipt directory' })
          chmodSync(directory, 0o700)
        }
        for (const [name, bytes] of images) {
          const target = join(dir, `${name}.png`)
          const temporary = `${target}.tmp`
          try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
          const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600)
          try {
            let offset = 0
            while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
          } finally { closeSync(fd) }
          renameSync(temporary, target)
        }
        return sendJson(res, 200, { ask: store.receipt(ticket, data) })
      })
    }

    const imageMatch = pathname.match(/^\/api\/asks\/(ub_[a-z0-9]{6})\/receipt\/(before|after)\.png$/)
    if (imageMatch && req.method === 'GET') {
      const ask = store.get(imageMatch[1])
      if (!ask?.receipt?.[imageMatch[2]]) return notFound(res)
      const bytes = readFileSync(join(stateDir(), 'receipts', imageMatch[1], `${imageMatch[2]}.png`))
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
      return res.end(bytes)
    }

    ticket = routeTicket(pathname)
    if (ticket && req.method === 'GET') {
      const ask = store.get(ticket)
      return ask ? sendJson(res, 200, ask) : notFound(res)
    }

    ticket = routeTicket(pathname, '/answer')
    if (ticket && req.method === 'POST') {
      const body = await readJson(req)
      if (relay) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['values', 'reply', 'revision', 'via', 'client_id'].includes(key))) {
          return sendJson(res, 400, { error: 'invalid relay answer body' })
        }
        if (body.via !== 'admin' || typeof body.client_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.client_id)) {
          return sendJson(res, 400, { error: 'invalid relay answer identity' })
        }
        const result = await answerAsk(ticket, body.values || {}, body.reply, undefined, undefined, body.revision, `admin:${relay.login}`)
        if (!result) return notFound(res)
        emitQueue()
        return sendJson(res, 200, result)
      }
      if (rejectRailsWithoutProof(req, res, body)) return
      const answeredVia = proxyIdentity(req) ? `tailnet:${proxyIdentity(req).login}` : body.via === 'rails' ? 'rails' : 'local'
      const result = body.bounce
        ? await withTicket(ticket, () => bounceAsk(ticket, body.reply, answeredVia, body.revision, body.field_bounce))
        : await answerAsk(ticket, body.values || {}, body.reply, body.field_context, body.field_bounce, body.revision, answeredVia)
      if (!result) return notFound(res)
      emitQueue()
      return sendJson(res, 200, result)
    }

    ticket = routeTicket(pathname, '/draft')
    if (ticket && req.method === 'POST') {
      if (!store.get(ticket)) return notFound(res)
      const body = await readJson(req)
      return sendJson(res, 200, { ask: await withTicket(ticket, () => applyDraft(ticket, body, proxyIdentity(req) ? `tailnet:${proxyIdentity(req).login}` : 'local')) })
    }

    // Revise a live ask instead of cancelling and refiling it. The ticket, the
    // link the human has open, and every draft on a field this does not touch
    // all survive.
    ticket = routeTicket(pathname, '/update')
    if (ticket && req.method === 'POST') {
      const body = await readJson(req)
      const ask = await withTicket(ticket, () => {
        const existing = store.get(ticket)
        return existing ? store.update(ticket, validateUpdate(existing, body)) : null
      })
      if (!ask) return notFound(res)
      emitAsk(ask, 'updated')
      emitQueue()
      return sendJson(res, 200, { ask })
    }

    /**
     * Watch ONE ask. Events: draft (they typed something), answered,
     * sent_back, cancelled, updated (the agent revised the questions).
     *
     * An agent that files an ask and then sits on this stream sees the human
     * think — a choice clicked, a note written — and can ask the obvious
     * follow-up through unblock_update while they are still on the page.
     */
    ticket = routeTicket(pathname, '/events')
    if (ticket && req.method === 'GET') {
      const ask = store.get(ticket)
      if (!ask) return notFound(res)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const listeners = askClients.get(ask.ticket) ?? new Set()
      listeners.add(res)
      askClients.set(ask.ticket, listeners)
      // The current state first, so a watcher that attached late is not stuck
      // waiting for a keystroke to learn where the ask already stands.
      res.write(`event: state\ndata: ${JSON.stringify(askEvent(ask))}\n\n`)
      req.on('close', () => {
        listeners.delete(res)
        if (listeners.size === 0) askClients.delete(ask.ticket)
      })
      return
    }

    ticket = routeTicket(pathname, '/collect')
    if (ticket && req.method === 'POST') {
      const ask = await withTicket(ticket, () => {
        const collected = store.collect(ticket)
        return collected
      })
      if (!ask) return notFound(res)
      emitQueue()
      return sendJson(res, 200, { ask })
    }

    ticket = routeTicket(pathname, '/cancel')
    if (ticket && req.method === 'POST') {
      const body = await readJson(req)
      // Everything else agent-supplied is scrubbed at the schema boundary;
      // this one slipped past because it arrives on its own route. Nothing
      // renders it today, which makes it a trap for whoever adds the first
      // renderer rather than a bug you would notice.
      const note = optionalScrub(body.note, 600)
      const ask = await withTicket(ticket, async () => {
        const cancelled = store.cancel(ticket, note)
        await flushSecretDeletes()
        return cancelled
      })
      if (!ask) return notFound(res)
      emitAsk(ask, 'cancelled')
      emitQueue()
      return sendJson(res, 200, { ask })
    }

    if (req.method === 'GET' && pathname === '/api/pending') {
      const origin = normalizeOrigin(Object.fromEntries(url.searchParams))
      // `open` rides along so unblock_check can report what the human is part
      // way through as well as what they finished.
      return sendJson(res, 200, { asks: store.pending(origin), open: store.openForAgent(origin) })
    }

    if (req.method === 'POST' && pathname === '/api/links') {
      const body = await readJson(req)
      const ask = body.ticket ? store.get(body.ticket) : null
      if (body.ticket && !ask) return notFound(res)
      const link = store.mintLink({
        askId: ask?.id || null,
        scope: ask ? 'ask' : 'queue',
        ttlSeconds: body.ttl_seconds || 900,
        mintedBy: proxyIdentity(req) ? `tailnet:${proxyIdentity(req).login}` : 'local',
      })
      return sendJson(res, 201, {
        url: `http://${HOST}:${actualPort}/u/${link.token}`,
        token: link.token,
        expires_at: link.expires_at,
      })
    }

    // Canonical per-person entry point. Stable URL, nothing secret in it,
    // safe to bookmark or pin to a home screen — because the capability is
    // the viewer's tailnet identity, not the address.
    const who = proxyIdentity(req)
    if (who && (pathname === '/' || pathname === '/index.html')) {
      return servePanel(res, null, who)
    }
    if (who && pathname.startsWith('/api/')) {
      // handled by the normal /api routes below, already authorized
    }

    // The panel speaks ONE dialect regardless of how it was reached: /api/queue,
    // /api/answer, /api/draft. Those existed only under /u/:token, so the
    // canonical identity-authenticated page rendered its shell and then failed
    // every fetch. Same three routes, same shapes, here too.
    if (pathname === '/api/queue' && req.method === 'GET') {
      const profile = url.searchParams.get('profile') || '*'
      return sendJson(res, 200, {
        asks: store.list({ profile, project: url.searchParams.get('project') || undefined }),
        hidden: store.countHidden(profile),
        profile,
      })
    }
    if (pathname.startsWith('/api/voice/')) {
      requireHumanPath(req)
      if (pathname === '/api/voice/issue' && req.method === 'POST') {
        const issue = await readJson(req)
        if (!issue || typeof issue.title !== 'string' || !issue.title.trim() || issue.title.trim().length > 120 ||
            typeof issue.details !== 'string' || issue.details.length > 4000 ||
            !['unblock', 'dashboard', 'other'].includes(issue.about) ||
            (issue.ticket !== undefined && typeof issue.ticket !== 'string')) {
          return sendJson(res, 400, { error: 'Invalid issue' })
        }
        if (process.env.UNBLOCK_ISSUE_DRY === '1') return sendJson(res, 200, { number: 0, url: '' })
        const repo = process.env.UNBLOCK_ISSUE_REPO || 'shelf-group/agent-rails'
        const title = `[${issue.about === 'dashboard' ? 'dashboard' : 'unblock'}] ${issue.title.trim()}`
        const viewer = proxyIdentity(req)?.login || 'local'
        const body = `Filed by voice from the unblock panel by ${viewer} at ${new Date().toISOString()}.\nAbout: ${issue.about}\nOn screen: ${issue.ticket || 'the list'}\n\n${issue.details}\n\nPick-up: triage like any dogfood issue; comment 'fixed in <version>' when live.\n`
        const gh = process.env.UNBLOCK_GH || (existsSync(join(homedir(), '.local/bin/gh')) ? join(homedir(), '.local/bin/gh') : '/opt/homebrew/bin/gh')
        const argv = ['issue', 'create', '-R', repo, '--title', title, '--body-file', '-', '--label', 'dogfood-unblock']
        try {
          let output
          try { output = await issueRunner(gh, argv, body) } catch (error) {
            if (error.killed || error.signal || !/label/i.test(String(error.stderr || ''))) throw error
            output = await issueRunner(gh, argv.slice(0, -2), body)
          }
          const url = String(output).trim().split(/\r?\n/).at(-1)
          const number = Number(url.match(/^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/issues\/(\d+)$/)?.[1])
          if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid issue URL')
          return sendJson(res, 200, { number, url })
        } catch { return sendJson(res, 502, { error: 'Could not file the issue' }) }
      }
      const settings = {
        live: { id: 'live', label: 'GPT Live', model: process.env.UNBLOCK_LIVE_MODEL || 'gpt-live-1', keyRef: process.env.UNBLOCK_OPENAI_KEY_REF || 'openai-rails-voice-prod', envName: 'OPENAI_API_KEY', voice: process.env.UNBLOCK_LIVE_VOICE || 'marin', delegate: process.env.UNBLOCK_LIVE_DELEGATE_MODEL || 'gpt-6-luna' },
        openai: { id: 'openai', label: 'GPT Realtime', model: process.env.UNBLOCK_OPENAI_MODEL || 'gpt-realtime-2.1', keyRef: process.env.UNBLOCK_OPENAI_KEY_REF || 'openai-rails-voice-prod', envName: 'OPENAI_API_KEY', voice: process.env.UNBLOCK_OPENAI_VOICE || 'marin' },
        gemini: { id: 'gemini', label: 'Gemini', model: process.env.UNBLOCK_VOICE_MODEL || 'gemini-3.8-live', keyRef: process.env.UNBLOCK_VOICE_KEY_REF || 'gemini-api-key', envName: 'GEMINI_API_KEY', voice: process.env.UNBLOCK_VOICE_NAME || 'Kore' },
        xai: { id: 'xai', label: 'Grok', model: process.env.UNBLOCK_XAI_MODEL || 'grok-voice-think-fast-2.0', keyRef: process.env.UNBLOCK_XAI_KEY_REF || 'xai-api-key', envName: 'XAI_API_KEY', voice: process.env.UNBLOCK_XAI_VOICE || 'eve' },
      }
      const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
      const minutes = Number(process.env.UNBLOCK_VOICE_MAX_MINUTES)
      const ledger = createSpendLedger({ file: join(stateDir(), 'voice-spend.json'), capUsd: positive(process.env.UNBLOCK_VOICE_CAP_USD, null), maxMinutes: Number.isSafeInteger(minutes) && minutes > 0 ? minutes : 15 })
      const configured = async (id) => {
        const setting = settings[id]
        const cached = voiceKeyCache.get(id)
        if (cached && cached.ref === setting.keyRef && cached.env === process.env[setting.envName] && Date.now() - cached.at < 60_000) return cached.configured
        const result = Boolean(await defaultReadKey(setting.keyRef, setting.envName))
        voiceKeyCache.set(id, { ref: setting.keyRef, env: process.env[setting.envName], at: Date.now(), configured: result })
        return result
      }
      const providerOrder = ['openai', 'live', 'xai', 'gemini']
      const preferred = providerOrder.includes(process.env.UNBLOCK_VOICE_PROVIDER) ? process.env.UNBLOCK_VOICE_PROVIDER : 'openai'
      const availableProviders = async () => Promise.all(providerOrder.map(configured))
      const defaultProvider = (available) => available[providerOrder.indexOf(preferred)] ? preferred : providerOrder.find((id, index) => available[index]) || preferred
      if (pathname === '/api/voice/providers' && req.method === 'GET') {
        const available = await availableProviders()
        return sendJson(res, 200, { default: defaultProvider(available), providers: providerOrder.map((id, index) => ({ id, label: settings[id].label, model: settings[id].model, configured: available[index], usd_per_minute: rateFor(settings[id].model) })), spend: ledger.status() })
      }
      if (pathname === '/api/voice/end' && req.method === 'POST') {
        const body = await readJson(req)
        const seconds = Number(body.seconds)
        const ok = ledger.settle(body.session_id, Number.isFinite(seconds) ? Math.max(0, seconds) : 0)
        if (ok) {
          try {
            const session = ledger.get(body.session_id)
            const metrics = body.metrics || {}
            const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
            const line = { at: new Date().toISOString(), session_id: session.session_id, provider: session.provider, model: session.model, seconds: number(body.seconds), usd: session.charged_usd, usd_per_minute: session.rate,
              first_audio_ms: number(metrics.first_audio_ms), tool_calls: number(metrics.tool_calls), tool_ok: number(metrics.tool_ok), profile: typeof metrics.profile === 'string' ? metrics.profile.slice(0, 40) : null }
            mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
            appendFileSync(join(stateDir(), 'voice-sessions.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 })
          } catch { /* Metrics never prevent settlement. */ }
        }
        return sendJson(res, 200, { ok, spend: ledger.status() })
      }
      if (pathname === '/api/voice/live/connect' && req.method === 'POST') {
        const body = await readJson(req)
        const reserved = typeof body.session_id === 'string' ? ledger.get(body.session_id) : null
        if (!reserved || reserved.settled || reserved.provider !== 'live' || typeof body.sdp !== 'string' || !body.sdp.trim() || body.sdp.length > 200_000 || typeof body.prompt !== 'string' || body.prompt.length > 20_000 || !Array.isArray(body.tools) || body.tools.length > 64) return sendJson(res, 400, { error: 'Invalid live call' })
        if (connectedLiveSessions.has(body.session_id) || connectingLiveSessions.has(body.session_id)) return sendJson(res, 409, { error: 'Voice session already connected' })
        connectingLiveSessions.add(body.session_id)
        try {
          const { keyRef, voice, delegate } = settings.live
          const session = buildLiveSession({ model: reserved.model, voice, delegate, prompt: body.prompt, tools: body.tools })
          const connected = await connectLiveCall({ keyRef, sdp: body.sdp, session })
          connectedLiveSessions.add(body.session_id)
          return sendJson(res, 200, { sdp: connected.sdp })
        } catch (error) {
          if (error.code === 'VOICE_NOT_CONFIGURED') return sendJson(res, 503, { error: 'Voice is not configured', code: 'VOICE_NOT_CONFIGURED' })
          return sendJson(res, 502, { error: 'Voice token service unavailable' })
        } finally { connectingLiveSessions.delete(body.session_id) }
      }
      if (pathname === '/api/voice/session' && req.method === 'POST') {
        const body = await readJson(req)
        const available = await availableProviders()
        const provider = providerOrder.includes(body.provider) && available[providerOrder.indexOf(body.provider)] ? body.provider : defaultProvider(available)
        if (!available.some(Boolean)) return sendJson(res, 503, { error: 'Voice is not configured', code: 'VOICE_NOT_CONFIGURED' })
        let reservation
        try {
          reservation = ledger.reserve({ provider, model: settings[provider].model })
        } catch (error) {
          if (error.code === 'VOICE_SPEND_CAP') return sendJson(res, 402, { error: 'Voice hit this month’s cap', code: 'VOICE_SPEND_CAP', spend: ledger.status() })
          throw error
        }
        try {
          const { keyRef, model, voice } = settings[provider]
          const scopeVoice = body.profile === 'scope' && provider === 'gemini' ? await import('./scope-voice.js') : null
          const token = provider === 'live' ? { provider, token: '', model, voice, expires_at: new Date(Date.now() + 120_000).toISOString() } : provider === 'gemini' ? await mintVoiceToken({ keyRef, model, voice, speed: body.speed, ...(scopeVoice ? { prompt: scopeVoice.SCOPE_VOICE_PROMPT, tools: scopeVoice.SCOPE_VOICE_TOOLS } : {}) }) : provider === 'openai' ? await mintOpenAiToken({ keyRef, model, voice }) : await mintXaiToken({ keyRef, model, voice })
          return sendJson(res, 200, { ...token, ...reservation, spend: ledger.status() })
        } catch {
          ledger.settle(reservation.session_id, 0)
          return sendJson(res, 502, { error: 'Voice token service unavailable' })
        }
      }
    }
    if (pathname === '/api/answer' && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ticket) return sendJson(res, 400, { error: 'ticket is required' })
      if (rejectRailsWithoutProof(req, res, body)) return
      const answeredVia = proxyIdentity(req) ? `tailnet:${proxyIdentity(req).login}` : body.via === 'rails' ? 'rails' : 'local'
      const result = body.bounce
        ? await withTicket(body.ticket, () => bounceAsk(body.ticket, body.reply, answeredVia, body.revision, body.field_bounce))
        : await answerAsk(body.ticket, body.values || {}, body.reply, body.field_context, body.field_bounce, body.revision, answeredVia)
      emitQueue()
      return sendJson(res, 200, result)
    }
    if (pathname === '/api/client-log' && req.method === 'POST') {
      return sendJson(res, 200, { logged: appendClientLog(req, await readJson(req)) })
    }
    if (pathname === '/api/draft' && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ticket) return sendJson(res, 400, { error: 'ticket is required' })
      if (!store.get(body.ticket)) return notFound(res)
      return sendJson(res, 200, { ask: await withTicket(body.ticket, () => applyDraft(body.ticket, body, proxyIdentity(req) ? `tailnet:${proxyIdentity(req).login}` : 'local')) })
    }

    const tokenMatch = pathname.match(/^\/u\/([^/]+)(.*)$/)
    if (tokenMatch) return handleTokenRoute(req, res, url, decodeURIComponent(tokenMatch[1]), tokenMatch[2])

    if (req.method === 'GET') {
      const asset = staticAsset(pathname)
      if (asset) return sendAsset(res, asset)
    }

    notFound(res)
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.end()
      if (error && error.code === 'SECRET_NOT_REFERENCED') {
      return sendJson(res, 400, { error: error.message, code: error.code })
    }
    if (error instanceof ValidationError) {
        return sendJson(res, 400, { error: error.message, path: error.path })
      }
      if (error.code === 'ALREADY_PARKED' || error.code === 'ALREADY_OPEN') {
        return sendJson(res, 409, { error: error.message, code: error.code, ticket: error.ticket })
      }
      if (['HUMAN_ONLY', 'STALE_REVISION', 'RELAY_NO_SECRETS', 'WHOLE_ASK_ONLY', 'NOTE_MEANS_CHANGE', 'INVALID_VERDICT', 'RECEIPT_NOT_ALLOWED', 'PAY_NOT_ALLOWED'].includes(error.code)) return sendJson(res, error.status || (error.code === 'PAY_NOT_ALLOWED' || error.code === 'RECEIPT_NOT_ALLOWED' ? 409 : 400), { error: error.message, code: error.code, ...(error.details || {}) })
      if (error.code === 'ASK_NOT_OPEN') {
        return sendJson(res, 409, { error: error.message, code: error.code, status: error.askStatus })
      }
      if (error.code === 'DRAFT_STALE') {
        return sendJson(res, 409, { error: error.message, code: error.code, draft_rev: error.draft_rev })
      }
      const status = error.status || 500
      sendJson(res, status, { error: status === 500 ? 'internal server error' : error.message })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, resolve)
  })
  actualPort = server.address().port

  const daemonFile = join(stateDir(), 'daemon.json')
  mkdirSync(dirname(daemonFile), { recursive: true, mode: 0o700 })
  writeFileSync(
    daemonFile,
    `${JSON.stringify({ port: actualPort, pid: process.pid, auth: authSecret, started_at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  )

  const keepalive = setInterval(() => {
    for (const client of clients) client.write(': keepalive\n\n')
    for (const listeners of askClients.values()) {
      for (const client of listeners) client.write(': keepalive\n\n')
    }
    scopeRoutes.keepalive()
  }, 25_000)
  keepalive.unref()
  async function sweep() {
    let changed = false
    const lifecycle = store.list({ profile: '*', status: ['open', 'answered'] })
    const starts = processStarts(lifecycle.map((ask) => ask.origin?.pid))
    for (const candidate of lifecycle) {
      try {
        await withTicket(candidate.ticket, async () => {
          const ask = store.get(candidate.ticket)
          if (ask?.status === 'answered') { await routeFinished(ask, starts); return }
          if (ask?.status !== 'open') return
          const reason = starts !== null && ask.origin?.pid && !sameProcess(ask.origin.pid, ask.origin.pid_start, starts) ? 'origin_finished' : await deadReference(ask)
          if (reason) {
            const closed = store.autoClose(ask.ticket, reason)
            if (closed) { changed = true; emitAsk(closed, closed.status) }
          } else if (!ask.set_aside_at && ask.rechecked_at != null && Date.now() - ask.rechecked_at >= replyMs && (ask.kept_at == null || ask.kept_at < ask.rechecked_at)) {
            const aside = store.setAside(ask.ticket, 'no_reply')
            changed = true; emitAsk(aside, aside.status)
          }
        })
      } catch {
        console.error(`unblock: lifecycle sweep failed for ${candidate.ticket}`)
      }
    }
    for (const ticket of store.sweepCandidates()) {
      const ask = await withTicket(ticket, () => store.sweepOne(ticket))
      if (ask) { changed = true; emitAsk(ask, ask.status) }
    }
    for (const ticket of store.repingCandidates(repingAfterMs)) {
      await withTicket(ticket, async () => {
        const ask = store.get(ticket)
        // The question hook owns first delivery. Never prompt for permission,
        // plugin-detected or ordinary filed asks, even if they carry a pane id.
        if (ask?.status !== 'answered' || ask.repinged_at || ask.reping_unavailable_at ||
            ask.kind !== 'file' || ask.purpose !== 'question' || ask.origin?.detected || !ask.origin?.pane_id) return
        const outcome = await guardedAnswerNotice(ask.origin.pane_id, ask.ticket)
        if (outcome === 'sent') store.markRepinged(ticket)
        if (outcome === 'missing') {
          store.markRepingUnavailable(ticket)
          console.error(`unblock: re-ping skipped for ${ticket}; origin pane no longer exists`)
        }
      })
    }
    for (const ticket of store.recheckCandidates(recheckAfterMs)) {
      await withTicket(ticket, async () => {
        const ask = store.get(ticket)
        if (ask?.status !== 'open' || ask.rechecked_at != null) return
        const sentAt = Date.now()
        if (!ask.origin?.pane_id) store.markRecheckUnreachable(ticket)
        else if (await recheckNotice(ask, recheckAfterMs) === 'sent') store.markRechecked(ticket, sentAt)
        else store.markRecheckFailed(ticket)
        const updated = store.get(ticket)
        if (updated.set_aside_at !== ask.set_aside_at || updated.rechecked_at !== ask.rechecked_at) { changed = true; emitAsk(updated, updated.status) }
      })
    }
    for (const ticket of store.weeklyCandidates(weeklyAfterMs)) {
      await withTicket(ticket, () => {
        const ask = store.get(ticket)
        if (ask?.status !== 'open' || ask.weekly_at != null) return
        store.markWeekly(ticket)
        const updated = store.get(ticket)
        emitAsk(updated, updated.status)
        changed = true
      })
    }
    for (const ticket of store.sweepCleanup()) await withTicket(ticket, () => store.prune(ticket))
    await flushSecretDeletes()
    if (changed) emitQueue()
  }
  const sweeper = setInterval(() => { sweep().catch(() => {}) }, sweepMs)
  sweeper.unref()
  let livedocApprovals = null
  if (process.env.UNBLOCK_LIVEDOC_APPROVALS === '1' ||
      (process.env.UNBLOCK_LIVEDOC_APPROVALS !== '0' && ROOT === daemonRoot())) {
    livedocApprovals = createLivedocApprovals({ stateFile: join(stateDir(), 'livedoc-approvals.json') })
    const pollMs = Number(process.env.UNBLOCK_LIVEDOC_POLL_MS)
    livedocApprovals.start(pollMs > 0 ? pollMs : 60000)
  }

  async function close() {
    if (isClosed) return
    isClosed = true
    clearInterval(keepalive)
    clearInterval(sweeper)
    livedocApprovals?.stop()
    await scopeRoutes.close()
    for (const client of clients) client.end()
    clients.clear()
    for (const listeners of askClients.values()) {
      for (const client of listeners) client.end()
    }
    askClients.clear()
    await new Promise((resolve) => server.close(resolve))
    await Promise.all([...ticketTails.values()])
    store.close()
    try {
      rmSync(daemonFile)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  return { server, port: actualPort, close, sweep }
}

/**
 * Start, tolerating a daemon that is already up.
 *
 * The failure this ends: launchd (KeepAlive) and ad-hoc spawns (MCP, CLI,
 * plugin) both start this file. Whoever loses the port used to crash with
 * EADDRINUSE — and under launchd that meant a respawn every ThrottleInterval,
 * forever, 8600+ crashes in a day of log spam. Now:
 *
 *   - an ad-hoc start that finds a healthy daemon exits 0 and gets out of
 *     the way;
 *   - a SUPERVISED start (launchd sets UNBLOCK_SUPERVISED=1) evicts the
 *     squatter instead, because the launchd copy is the one with the
 *     canonical env (public origin, trusted proxy) and must own the port.
 */
async function startResilient() {
  try {
    return await startDaemon({})
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error
    // startDaemon has applied the config file by now, so the port is final.
    const port = Number(process.env.UNBLOCK_PORT || 4488)

    const healthy = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    })
      .then((res) => res.ok)
      .catch(() => false)

    if (process.env.UNBLOCK_SUPERVISED !== '1') {
      if (healthy) {
        console.log(`unblock daemon already running on ${port}; this start is redundant`)
        process.exit(0)
      }
      throw error // port squatted by something that is not a healthy daemon
    }

    try {
      const { pid } = JSON.parse(readFileSync(join(stateDir(), 'daemon.json'), 'utf8'))
      if (pid && pid !== process.pid) process.kill(pid, 'SIGTERM')
    } catch {
      /* no pid file or already gone; the retry loop decides */
    }
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((r) => setTimeout(r, 200))
      try {
        return await startDaemon({})
      } catch (retryError) {
        if (retryError?.code !== 'EADDRINUSE') throw retryError
      }
    }
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const daemon = await startResilient()
  const shutdown = async () => {
    await daemon.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
