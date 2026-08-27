import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { normalizeOrigin, optionalScrub, validateAsk, ValidationError } from './schema.js'
import { SecretStore } from './secrets.js'
import { Store } from './store.js'

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
  if (allowed && !allowed.split(',').map((u) => u.trim()).includes(login)) return null

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

export async function startDaemon({ port = Number(process.env.UNBLOCK_PORT || 4488) } = {}) {
  const authSecret = loadOrCreateSecret()
const store = new Store()
  const secretStore = new SecretStore({ backend: process.env.UNBLOCK_SECRET_BACKEND || 'auto' })
  const clients = new Set()
  let actualPort = port
  let isClosed = false

  const queueState = () => {
    const asks = store.list({ profile: '*', status: ['open', 'answered'] })
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

  async function bounceAsk(ticket, reply) {
  // The note is optional. Requiring one greyed out the send-back button until
  // the human wrote an essay, which made rejecting a bad ask harder than
  // rubber-stamping it. A bounce with no note still tells the agent the ask
  // itself was wrong.
  return { ask: store.bounce(ticket, optionalScrub(reply, 1000)), complete: true, bounced: true }
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

async function answerAsk(ticket, values, reply, fieldContext, fieldBounce) {
    const ask = store.get(ticket)
    if (!ask) return null
    const records = []
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
    return store.answer(ticket, safe, {
      refs,
      reply: optionalScrub(reply, 1000),
      fieldContext: scrubFieldContext(fieldContext),
      fieldBounce: scrubFieldBounce(fieldBounce),
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

    if ((tail === '/api/answer' || tail === '/api/draft') && req.method === 'POST') {
      const body = await readJson(req)
      const ticket = scopedAsk?.ticket || body.ticket
      if (!ticket) return sendJson(res, 400, { error: 'ticket is required' })
      if (scopedAsk && ticket !== scopedAsk.ticket) return sendJson(res, 403, { error: 'link is scoped to another ask' })
      const ask = store.get(ticket)
      if (!ask) return notFound(res)
      if (tail === '/api/draft') {
        const updated = store.saveDraft(ticket, body.values || {}, scrubFieldContext(body.field_context), draftReply(body))
        emitQueue()
        return sendJson(res, 200, { ask: updated })
      }
      const result = body.bounce
        ? await bounceAsk(ticket, body.reply)
        : await answerAsk(ticket, body.values || {}, body.reply, body.field_context, body.field_bounce)
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
    if (!validateHostHeader(req)) {
      return sendJson(res, 403, { error: 'invalid host' })
    }
    if (!validateOriginHeader(req, actualPort)) {
      return sendJson(res, 403, { error: 'invalid origin' })
    }
    const url = new URL(req.url, `http://${HOST}:${actualPort}`)
    const pathname = url.pathname

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        backend: await secretStore.backend(),
        // Clients use this to build ONE stable answer URL instead of minting a
        // throwaway token for every ask.
        public_origin: process.env.UNBLOCK_PUBLIC_ORIGIN ?? null,
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
      // Built panel assets carry nothing secret; the page itself is gated by
      // its link token, which is checked in handleTokenRoute.
      staticAsset(pathname) !== null ||
      pathname.startsWith('/u/')
    if (!isPublic && !isAuthorized(req, authSecret)) {
      return sendJson(res, 401, { error: 'unauthorized' })
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
      const ask = store.create(validateAsk(body.ask), normalizeOrigin(body.origin))
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

    let ticket = routeTicket(pathname)
    if (ticket && req.method === 'GET') {
      const ask = store.get(ticket)
      return ask ? sendJson(res, 200, ask) : notFound(res)
    }

    ticket = routeTicket(pathname, '/answer')
    if (ticket && req.method === 'POST') {
      const body = await readJson(req)
      const result = body.bounce
        ? await bounceAsk(ticket, body.reply)
        : await answerAsk(ticket, body.values || {}, body.reply, body.field_context, body.field_bounce)
      if (!result) return notFound(res)
      emitQueue()
      return sendJson(res, 200, result)
    }

    ticket = routeTicket(pathname, '/draft')
    if (ticket && req.method === 'POST') {
      if (!store.get(ticket)) return notFound(res)
      const body = await readJson(req)
      const ask = store.saveDraft(ticket, body.values || {}, scrubFieldContext(body.field_context), draftReply(body))
      emitQueue()
      return sendJson(res, 200, { ask })
    }

    ticket = routeTicket(pathname, '/collect')
    if (ticket && req.method === 'POST') {
      const ask = store.collect(ticket)
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
      const ask = store.cancel(ticket, note)
      if (!ask) return notFound(res)
      emitQueue()
      return sendJson(res, 200, { ask })
    }

    if (req.method === 'GET' && pathname === '/api/pending') {
      const origin = normalizeOrigin(Object.fromEntries(url.searchParams))
      return sendJson(res, 200, { asks: store.pending(origin) })
    }

    if (req.method === 'POST' && pathname === '/api/links') {
      const body = await readJson(req)
      const ask = body.ticket ? store.get(body.ticket) : null
      if (body.ticket && !ask) return notFound(res)
      const link = store.mintLink({
        askId: ask?.id || null,
        scope: ask ? 'ask' : 'queue',
        ttlSeconds: body.ttl_seconds || 900,
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
    if (pathname === '/api/answer' && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ticket) return sendJson(res, 400, { error: 'ticket is required' })
      const result = body.bounce
        ? await bounceAsk(body.ticket, body.reply)
        : await answerAsk(body.ticket, body.values || {}, body.reply, body.field_context, body.field_bounce)
      emitQueue()
      return sendJson(res, 200, result)
    }
    if (pathname === '/api/draft' && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.ticket) return sendJson(res, 400, { error: 'ticket is required' })
      const ask = store.saveDraft(body.ticket, body.values || {}, scrubFieldContext(body.field_context), draftReply(body))
      return sendJson(res, 200, { ask })
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
      if (error.code === 'ALREADY_PARKED') {
        return sendJson(res, 409, { error: error.message, ticket: error.ticket })
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
  }, 25_000)
  keepalive.unref()
  const sweeper = setInterval(() => {
    if (store.sweep().length > 0) emitQueue()
  }, 60_000)
  sweeper.unref()

  async function close() {
    if (isClosed) return
    isClosed = true
    clearInterval(keepalive)
    clearInterval(sweeper)
    for (const client of clients) client.end()
    clients.clear()
    await new Promise((resolve) => server.close(resolve))
    store.close()
    try {
      rmSync(daemonFile)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  return { server, port: actualPort, close }
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
  const port = Number(process.env.UNBLOCK_PORT || 4488)
  try {
    return await startDaemon({})
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error

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
