import { readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { promptPane } from './pane-notice.js'
import { normalizeAnchor, quoteSnippet, locateAnchor } from './scope-anchor.js'
import { migrateV1, validateScope, sectionPlain, anchorInSection, headingOf, nextThreadId, THREAD_ID } from './scope-doc.js'

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const PANE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
const compact = (text) => text.replace(/\s+/g, ' ').trim()
const delay = (value, fallback) => Number(value) > 0 ? Number(value) : fallback

export function createScopeRoutes({ store, webRoot, sendJson, sendText, readJson, requireHumanPath, proxyIdentity }) {
  const root = process.env.UNBLOCK_SCOPING_DIR || join(homedir(), '.agent-rails', 'scoping')
  const cache = new Map()
  const listeners = new Map()
  const delivering = new Map()
  const writes = new Map()
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
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid scope')
      const scope = parsed.version === 2 ? parsed : migrateV1(parsed, parsed.updated_at)
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
      const threads = Array.isArray(scope.threads) ? scope.threads : []
      return [{ slug: dir.name, title: scope.title ?? '', updated_at: scope.updated_at ?? '',
        pane: scope.pane ?? '', open: threads.filter((t) => t.status === 'open').length }]
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
        if (data) emit(slug, 'scope', { ...data, notes: store.scopeNotes(slug) })
        if (store.pendingScopeNotes(slug).length || store.pendingScopeTargets(slug).length) schedule(slug)
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
    job = { again: false, timer: null, failures: new Map() }
    delivering.set(slug, job)
    void deliver(slug, job)
  }

  async function deliver(slug, job) {
    while (!closed) {
      job.again = false
      let notes = store.pendingScopeNotes(slug)
      const targets = store.pendingScopeTargets(slug)
      if (!notes.length && !targets.length) break
      const pane = readScope(slug)?.scope?.pane
      if (typeof pane !== 'string' || !PANE.test(pane)) {
        emitNotes(store.markScopeNotes(notes.map((note) => note.id), 'no_pane'))
        notes = []
        if (!targets.length) { job.again = false; break }
      }
      const scope = readScope(slug)?.scope
      const joined = notes.map((note) => {
        const alex = note.via === 'voice' ? 'Alex (by voice)' : 'Alex'
        const heading = headingOf(scope, note.anchor?.section ?? 'title')
        const quote = quoteSnippet(note.anchor?.quote ?? '')
        const text = compact(note.text)
        if (note.event === 'new') return note.anchor.section === 'title'
          ? `${alex} (general): ${text} (new ${note.thread})`
          : `${alex} on §${heading} "${quote}": ${text} (new ${note.thread})`
        if (note.event === 'reject') return `${alex} rejected the recommendation on ${note.thread} (§${heading} "${quote}")${text ? `: ${text.replace(/\.$/, '')}.` : ', no reason given.'} Offer a new option: unblock scope reply ${slug} ${note.thread} --rec "<new recommendation>" "<one line>"`
        if (note.event === 'park') return `${alex} parked ${note.thread} (§${heading} "${quote}") for later. No action needed.`
        if (note.event === 'take' || note.event === 'own') return `${alex}${note.event === 'take' ? ` took the recommendation on ${note.thread}` : ` answered ${note.thread} his own way`} (§${heading} "${quote}"): ${text.replace(/\.$/, '')}. Edit §${heading} to say so, then run: unblock scope resolve ${slug} ${note.thread}`
        if (note.event === 'resolve') {
          const words = note.words && note.words !== note.text && note.words !== 'Take the recommendation' ? ` His words: "${compact(note.words)}".` : ''
          return `${alex} resolved ${note.thread} (§${heading} "${quote}") as: ${text.replace(/\.$/, '')}.${words} Edit §${heading} to say so, then run: unblock scope resolve ${slug} ${note.thread}`
        }
        return `${alex}${note.event === 'reopen' ? ' reopened' : ' on'} ${note.thread} (§${heading} "${quote}"): ${text}`
      }).join(' | ')
      let line = `[scoping ${slug}] ${joined} (reply: unblock scope reply ${slug} <T#> "<one line>")`
      if (line.length > 700) line = `[scoping ${slug}] Alex sent ${notes.length} note(s), too long for one line. Read them: unblock scope notes ${slug} --since ${notes[0].id - 1}`
      let retry = false
      async function send(key, targetPane, text, mark) {
        try {
          await promptPane(['agent', 'prompt', targetPane, text])
          mark('delivered')
          job.failures.delete(key)
        } catch {
          if (closed) return
          const first = job.failures.get(key) ?? Date.now()
          job.failures.set(key, first)
          if (Date.now() - first >= 30 * 60_000) { mark('failed'); job.failures.delete(key) }
          else { mark('retrying'); retry = true }
        }
      }
      if (notes.length) await send('own', pane, line, (status) => {
        emitNotes(store.markScopeNotes(notes.map((note) => note.id), status, status === 'delivered' ? new Date().toISOString() : null))
      })
      for (const target of targets) {
        if (closed) break
        const alex = target.via === 'voice' ? 'Alex (by voice)' : 'Alex'
        const heading = headingOf(scope, target.anchor.section)
        const pointer = `[scoping ${slug}] ${alex} tagged you on ${target.thread} (§${heading} "${quoteSnippet(target.anchor.quote)}"): ${compact(target.words ?? target.text)}${/[.!?]$/.test(compact(target.words ?? target.text)) ? '' : '.'} Read it: unblock scope threads ${slug}`
        await send(`${target.id}:${target.pane}`, target.pane, pointer, (status) => store.markScopeTarget(target.id, target.pane, status))
      }
      if (retry && !closed) {
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
      html = readFileSync(join(webRoot(), 'scope.html'), 'utf8')
        .replace(/(["'])\.\/assets\//g, '$1/assets/')
        .replace(/(["'])\.\/favicon\.svg/g, '$1/favicon.svg')
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
    const [slug, action, threadId, verb] = parts
    if (!SLUG.test(slug)) return sendJson(res, 404, { error: 'no such scope' })
    const state = readScope(slug)
    if (!state) return sendJson(res, 404, { error: 'no such scope' })
    if (req.method === 'GET' && parts.length === 1) return sendJson(res, 200, { ...state, notes: store.scopeNotes(slug) })
    if (req.method === 'GET' && parts.length === 2 && action === 'events') return watch(slug, req, res)
    if (req.method === 'GET' && parts.length === 2 && action === 'notes') {
      const raw = url.searchParams.get('since') ?? '0'
      const author = url.searchParams.get('from')
      if (!/^\d+$/.test(raw) || (author && !['alex', 'agent'].includes(author))) return sendJson(res, 400, { error: 'invalid notes filter' })
      return sendJson(res, 200, { notes: store.scopeNotes(slug, { since: Number(raw), author: author || undefined }) })
    }
    const docWrite = req.method === 'PUT' && parts.length === 2 && action === 'doc'
    const newThread = req.method === 'POST' && parts.length === 2 && action === 'threads'
    const threadWrite = req.method === 'POST' && parts.length === 4 && action === 'threads' && THREAD_ID.test(threadId) && ['reply', 'resolve', 'reject', 'park'].includes(verb)
    if (!docWrite && !newThread && !threadWrite) return sendJson(res, 404, { error: 'not found' })
    const human = proxyIdentity(req)
    if (['reject', 'park'].includes(verb)) requireHumanPath(req)
    if (docWrite && human) {
      const error = new Error('lanes rewrite the doc through the CLI')
      error.code = 'HUMAN_ONLY'; error.status = 403; throw error
    }
    const body = await readJson(req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'invalid body' })
    if (body.via !== undefined && body.via !== 'voice') return sendJson(res, 400, { error: 'invalid via' })
    const previous = writes.get(slug) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => changeScope(slug, { body, human, docWrite, newThread, threadId, verb }))
    writes.set(slug, pending)
    try {
      const result = await pending
      return sendJson(res, newThread ? 201 : 200, result)
    } finally { if (writes.get(slug) === pending) writes.delete(slug) }
  }

  function tagTargets(scope, text) {
    const targets = new Set()
    const workspace = scope.pane.split(':')[0]
    for (const match of text.matchAll(/(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9-]+)\b/g)) {
      const tag = match[1]
      const taggedScope = SLUG.test(tag) ? readScope(tag)?.scope : null
      const pane = taggedScope ? taggedScope.pane : /^p[a-zA-Z0-9]{1,8}$/.test(tag) && workspace ? `${workspace}:${tag}` : null
      if (pane && PANE.test(pane) && pane !== scope.pane) targets.add(pane)
    }
    return [...targets]
  }

  function bad(message, status = 400) { const error = new Error(message); error.status = status; throw error }

  function changeScope(slug, { body, human, docWrite, newThread, threadId, verb }) {
    const dir = join(root, slug)
    let raw, disk
    try { raw = readFileSync(join(dir, 'scope.json')); disk = JSON.parse(raw) } catch { bad('scope.json is being rewritten') }
    const scope = disk.version === 2 ? disk : migrateV1(disk, disk.updated_at)
    const at = new Date().toISOString()
    const text = (value, limit = human ? 4000 : 600) => {
      const cleaned = typeof value === 'string' ? human ? value.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim() : compact(value) : ''
      if (!cleaned || cleaned.length > limit) bad('invalid text')
      return cleaned
    }
    let thread, noteData = null, result
    if (docWrite) {
      scope.doc = { sections: body.sections }
      scope.revision++
      result = { revision: scope.revision }
    } else if (newThread) {
      let anchor
      if (human) {
        anchor = normalizeAnchor(body.anchor)
        const section = scope.doc.sections.find((s) => s.id === anchor?.section)
        if (!section || !locateAnchor(sectionPlain(section), anchor)) bad('invalid anchor')
      } else {
        const section = scope.doc.sections.find((s) => s.id === body.section)
        anchor = section && typeof body.quote === 'string' ? anchorInSection(section, body.quote) : null
        if (!anchor) bad(`quote not found in §${body.section}`)
      }
      const kind = human ? 'comment' : body.kind ?? 'question'
      if (!['question', 'comment'].includes(kind) || (kind === 'comment' && (body.recommendation !== undefined || body.why !== undefined))) bad('invalid kind')
      thread = { id: nextThreadId(scope), anchor, author: human ? 'alex' : 'agent', kind, status: 'open', messages: [{ from: human ? 'alex' : 'agent', text: text(body.text), at, ...(body.via === 'voice' ? { via: 'voice' } : {}) }], created_at: at }
      if (!human && body.recommendation !== undefined) thread.recommendation = text(body.recommendation, 600)
      if (!human && body.why !== undefined) thread.why = text(body.why, 600)
      scope.threads.push(thread)
      if (human) noteData = { event: 'new', text: thread.messages[0].text }
      result = { thread }
    } else {
      thread = scope.threads.find((t) => t.id === threadId)
      if (!thread) bad('no such thread', 404)
      if (verb === 'reply') {
        const message = { from: human ? 'alex' : 'agent', text: text(body.text), at, ...(body.via === 'voice' ? { via: 'voice' } : {}) }
        if (!human && body.recommendation !== undefined) {
          if (thread.kind !== 'question') bad('only questions have recommendations')
          thread.recommendation = text(body.recommendation, 600)
          if (body.why !== undefined) thread.why = text(body.why, 600)
          else delete thread.why
          delete thread.rejected_at
          message.kind = 'option'; message.recommendation = thread.recommendation
        }
        thread.messages.push(message)
        if (human) {
          noteData = { event: thread.status !== 'open' ? 'reopen' : 'reply', text: message.text }
          thread.status = 'open'; delete thread.resolution; delete thread.parked_at
        }
      } else if (verb === 'reject') {
        if (thread.status !== 'open' || thread.kind !== 'question' || !thread.recommendation) bad('only open questions with recommendations can be rejected')
        const reason = body.text == null || (typeof body.text === 'string' && !body.text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim()) ? '' : text(body.text)
        thread.rejected_at = at
        thread.messages.push({ from: 'alex', kind: 'reject', text: reason, at, ...(body.via === 'voice' ? { via: 'voice' } : {}) })
        noteData = { event: 'reject', text: reason }
      } else if (verb === 'park') {
        if (thread.status !== 'open') bad('only open threads can be parked')
        thread.status = 'parked'; thread.parked_at = at
        noteData = { event: 'park', text: '' }
      } else if (human) {
        const how = body.how ?? 'resolve'
        if (!['take', 'own', 'resolve'].includes(how)) bad('invalid how')
        const decision = text(body.decision, 600)
        const words = body.alex_words == null ? decision : text(body.alex_words)
        thread.status = 'resolved'
        thread.resolution = { decision, alex_words: words, by: 'alex', how, at, confirmed_at: null, revision: null }
        noteData = { event: how, text: decision, words: body.alex_words == null ? null : words }
      } else if (thread.status === 'open') {
        thread.status = 'resolved'
        thread.resolution = { decision: text(body.decision, 600), alex_words: null, by: 'agent', at, confirmed_at: at, revision: scope.revision }
      } else if (thread.resolution?.by === 'alex' && !thread.resolution.confirmed_at) {
        thread.resolution.confirmed_at = at; thread.resolution.revision = scope.revision
      } else return { thread }
      result = { thread }
    }
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    scope.updated_at = at
    if (disk.version !== 2) {
      let backup = join(dir, 'scope.v1.json'), n = 2
      while (existsSync(backup)) backup = join(dir, `scope.v1-${n++}.json`)
      writeFileSync(backup, raw)
      mkdirSync(join(dir, 'revisions'), { recursive: true })
      const original = migrateV1(disk, disk.updated_at)
      writeFileSync(join(dir, 'revisions', '1.json'), JSON.stringify({ revision: 1, at: original.updated_at, sections: original.doc.sections }))
    }
    if (docWrite) {
      mkdirSync(join(dir, 'revisions'), { recursive: true })
      writeFileSync(join(dir, 'revisions', `${scope.revision}.json`), JSON.stringify({ revision: scope.revision, at, sections: scope.doc.sections }))
      result.detached = scope.threads.filter((t) => {
        const section = scope.doc.sections.find((s) => s.id === t.anchor.section)
        return !section || !locateAnchor(sectionPlain(section), t.anchor)
      }).map((t) => t.id)
    }
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    if (noteData) {
      const note = store.addScopeNote({ slug, author: 'alex', kind: ['resolve', 'take', 'own'].includes(noteData.event) ? 'answer' : 'thought', who: human.login, thread: thread.id, anchor: thread.anchor, via: body.via ?? null, targets: tagTargets(scope, noteData.words ?? noteData.text), ...noteData })
      emit(slug, 'note', note)
    }
    const state = readScope(slug)
    const entry = listeners.get(slug)
    if (entry) entry.meta = metadata(slug)
    emit(slug, 'scope', { ...state, notes: store.scopeNotes(slug) })
    if (noteData) schedule(slug)
    return result
  }

  // Queued notes survive a daemon restart even if scope.json is mid-write.
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (dir.isDirectory() && SLUG.test(dir.name) && (store.pendingScopeNotes(dir.name).length || store.pendingScopeTargets(dir.name).length)) schedule(dir.name)
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
