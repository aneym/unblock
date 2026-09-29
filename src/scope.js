import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { promptPane } from './pane-notice.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const PANE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
const QID = /^Q\d{1,3}$/
const compact = (text) => text.replace(/\s+/g, ' ').trim()
const delay = (value, fallback) => Number(value) > 0 ? Number(value) : fallback

export function createScopeRoutes({ store, webRoot, sendJson, sendText, readJson, requireHumanPath, proxyIdentity }) {
  const root = process.env.UNBLOCK_SCOPING_DIR || join(homedir(), '.agent-rails', 'scoping')
  const cache = new Map()
  const listeners = new Map()
  const delivering = new Map()
  let closed = false

  function metadata(slug) {
    try {
      const { ino, mtimeMs, size } = statSync(join(root, slug, 'scope.json'))
      return { ino, mtime_ms: mtimeMs, size }
    } catch { return { ino: null, mtime_ms: null, size: null } }
  }

  function readScope(slug) {
    const file = join(root, slug, 'scope.json')
    const meta = metadata(slug)
    try {
      const scope = JSON.parse(readFileSync(file, 'utf8'))
      if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('invalid scope')
      cache.set(slug, scope)
      return { slug, scope, error: null, mtime_ms: meta.mtime_ms }
    } catch (error) {
      if (error.code === 'ENOENT' && !cache.has(slug)) return null
      if (!cache.has(slug)) return { slug, scope: null, error: 'scope.json is being rewritten', mtime_ms: meta.mtime_ms }
      return { slug, scope: cache.get(slug), error: 'scope.json is being rewritten', mtime_ms: meta.mtime_ms }
    }
  }

  function listing() {
    let dirs
    try { dirs = readdirSync(root, { withFileTypes: true }) } catch { return [] }
    return dirs.filter((dir) => dir.isDirectory() && SLUG.test(dir.name)).flatMap((dir) => {
      const data = readScope(dir.name)
      if (!data?.scope || data.error) return []
      const scope = data.scope
      const questions = Array.isArray(scope.questions) ? scope.questions : []
      return [{ slug: dir.name, title: scope.title ?? '', updated_at: scope.updated_at ?? '',
        pane: scope.pane ?? '', open: questions.filter((q) => q && (q.status === 'open' || !q.status)).length }]
    }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  }

  function emit(slug, event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of listeners.get(slug)?.clients ?? []) client.write(message)
  }

  function emitNotes(notes) {
    for (const note of notes) emit(note.slug, 'note', note)
  }

  function watch(slug, req, res) {
    const state = readScope(slug)
    if (!state) return sendJson(res, 404, { error: 'no such scope' })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    let entry = listeners.get(slug)
    if (!entry) {
      entry = { clients: new Set(), meta: metadata(slug), timer: null }
      entry.timer = setInterval(() => {
        const next = metadata(slug)
        if (next.ino === entry.meta.ino && next.mtime_ms === entry.meta.mtime_ms && next.size === entry.meta.size) return
        entry.meta = next
        const data = readScope(slug)
        if (data) emit(slug, 'scope', data)
        if (store.pendingScopeNotes(slug).length) schedule(slug)
      }, delay(process.env.UNBLOCK_SCOPE_POLL_MS, 1000))
      entry.timer.unref()
      listeners.set(slug, entry)
    }
    entry.clients.add(res)
    res.write(`event: state\ndata: ${JSON.stringify({ ...state, notes: store.scopeNotes(slug) })}\n\n`)
    req.on('close', () => {
      entry.clients.delete(res)
      if (!entry.clients.size) {
        clearInterval(entry.timer)
        listeners.delete(slug)
      }
    })
  }

  function schedule(slug) {
    let job = delivering.get(slug)
    if (job) { job.again = true; return }
    job = { again: false, timer: null, firstFailure: null }
    delivering.set(slug, job)
    void deliver(slug, job)
  }

  async function deliver(slug, job) {
    while (!closed) {
      job.again = false
      const notes = store.pendingScopeNotes(slug)
      if (!notes.length) break
      const pane = readScope(slug)?.scope?.pane
      if (typeof pane !== 'string' || !PANE.test(pane)) {
        emitNotes(store.markScopeNotes(notes.map((note) => note.id), 'no_pane'))
        job.again = false
        break
      }
      const joined = notes.map((note) => `${note.qid ? `Alex on ${note.qid}` : 'Alex'}: ${compact(note.text)}`).join(' | ')
      let line = `[scoping ${slug}] ${joined} (reply: unblock scope reply ${slug} "<one line>")`
      if (line.length > 700) line = `[scoping ${slug}] Alex sent ${notes.length} note(s), too long for one line. Read them: unblock scope notes ${slug} --since ${notes[0].id - 1}`
      try {
        await promptPane(['agent', 'prompt', pane, line])
        emitNotes(store.markScopeNotes(notes.map((note) => note.id), 'delivered', new Date().toISOString()))
        job.firstFailure = null
      } catch {
        if (closed) break
        if (!job.firstFailure) job.firstFailure = Date.now()
        if (Date.now() - job.firstFailure >= 30 * 60_000) {
          emitNotes(store.markScopeNotes(notes.map((note) => note.id), 'failed'))
          break
        }
        emitNotes(store.markScopeNotes(notes.map((note) => note.id), 'retrying'))
        await new Promise((resolve) => {
          job.wake = resolve
          job.timer = setTimeout(resolve, delay(process.env.UNBLOCK_SCOPE_RETRY_MS, 5000))
          job.timer.unref()
        })
        job.wake = null
        job.timer = null
      }
    }
    delivering.delete(slug)
    if (job.again && !closed) schedule(slug)
  }

  function page(res, slug) {
    let html
    try {
      const built = join(webRoot(), 'scope.html')
      html = readFileSync(existsSync(built) ? built : join(ROOT, 'web', 'public', 'scope.html'), 'utf8')
    } catch {
      html = '<!doctype html><html><head><meta charset="utf-8"></head><body>Scoping page is not built.</body></html>'
    }
    const boot = `<script>window.__SCOPE_BOOT__=${JSON.stringify({ slug })};</script>`
    return sendText(res, 200, html.includes('</head>') ? html.replace('</head>', `${boot}</head>`) : `${boot}${html}`, 'text/html; charset=utf-8')
  }

  async function handle(req, res, url) {
    const pathname = url.pathname
    if (pathname === '/s' || pathname === '/s/') {
      if (req.method === 'GET') return page(res, null)
      return sendJson(res, 404, { error: 'not found' })
    }
    if (pathname.startsWith('/s/')) {
      const slug = pathname.slice(3)
      if (!SLUG.test(slug)) return sendJson(res, 404, { error: 'not found' })
      if (req.method === 'GET') return page(res, slug)
      return sendJson(res, 404, { error: 'not found' })
    }
    if (pathname === '/api/scope') {
      if (req.method === 'GET') return sendJson(res, 200, { scopes: listing() })
      return sendJson(res, 404, { error: 'not found' })
    }
    if (!pathname.startsWith('/api/scope/')) return sendJson(res, 404, { error: 'not found' })
    const parts = pathname.slice('/api/scope/'.length).split('/')
    const [slug, action] = parts
    if (parts.length > 2 || !SLUG.test(slug)) return sendJson(res, 404, { error: 'no such scope' })
    const state = readScope(slug)
    if (!state) return sendJson(res, 404, { error: 'no such scope' })
    if (req.method === 'GET' && !action) return sendJson(res, 200, { ...state, notes: store.scopeNotes(slug) })
    if (req.method === 'GET' && action === 'events') return watch(slug, req, res)
    if (req.method === 'GET' && action === 'notes') {
      const raw = url.searchParams.get('since') ?? '0'
      const author = url.searchParams.get('from')
      if (!/^\d+$/.test(raw) || (author && !['alex', 'agent'].includes(author))) return sendJson(res, 400, { error: 'invalid notes filter' })
      return sendJson(res, 200, { notes: store.scopeNotes(slug, { since: Number(raw), author: author || undefined }) })
    }
    if (req.method === 'POST' && (action === 'note' || action === 'reply')) {
      if (action === 'note') requireHumanPath(req)
      if (!state.scope) return sendJson(res, 404, { error: 'no such scope' })
      const body = await readJson(req)
      const text = action === 'note'
        ? typeof body.text === 'string' ? body.text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim() : ''
        : typeof body.text === 'string' ? compact(body.text) : ''
      if (!text || text.length > (action === 'note' ? 4000 : 600)) return sendJson(res, 400, { error: 'invalid text' })
      const qid = body.qid
      if (action === 'note' && qid !== undefined && (!QID.test(qid) || !Array.isArray(state.scope?.questions) || !state.scope.questions.some((q) => q?.id === qid))) {
        return sendJson(res, 400, { error: 'invalid qid' })
      }
      const note = store.addScopeNote({ slug, author: action === 'note' ? 'alex' : 'agent', kind: action === 'reply' ? 'reply' : qid ? 'answer' : 'thought', qid: action === 'note' ? qid : null, text, who: action === 'note' ? proxyIdentity(req).login : null })
      emit(slug, 'note', note)
      if (action === 'note') schedule(slug)
      return sendJson(res, 201, { note })
    }
    return sendJson(res, 404, { error: 'not found' })
  }

  // Queued notes survive a daemon restart even if scope.json is mid-write.
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (dir.isDirectory() && SLUG.test(dir.name) && store.pendingScopeNotes(dir.name).length) schedule(dir.name)
    }
  } catch { /* scoping root not created yet */ }

  async function close() {
    closed = true
    for (const entry of listeners.values()) {
      clearInterval(entry.timer)
      for (const client of entry.clients) client.end()
    }
    listeners.clear()
    for (const job of delivering.values()) {
      clearTimeout(job.timer)
      job.wake?.()
    }
    while (delivering.size) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  function keepalive() {
    for (const entry of listeners.values()) for (const client of entry.clients) client.write(': keepalive\n\n')
  }

  return { handle, close, keepalive }
}
