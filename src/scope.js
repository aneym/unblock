import { readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { promptPane } from './pane-notice.js'
import { appendApprovalIndex, moveTabToInflight } from './scope-approvals.js'
import { lintDoc, lintText } from './scope-lint.js'
import { readAsset, readAssetBody, assetLimit, storeAsset, serveAsset, docAssets } from './scope-assets.js'
import { normalizeAnchor, quoteSnippet, locateAnchor } from './scope-anchor.js'
import { migrateV1, validateScope, sectionPlain, anchorInSection, headingOf, nextThreadId, THREAD_ID, APPS, appOf } from './scope-doc.js'

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const PANE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
const APPROVAL_MODES = ['approve', 'approve_with_changes', 'not_yet']
const approved = (approval) => ['approve', 'approve_with_changes'].includes(approval?.mode)
const eastern = (at) => `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))} ET`
const compact = (text) => text.replace(/\s+/g, ' ').trim()
const delay = (value, fallback) => Number(value) > 0 ? Number(value) : fallback

export function createScopeRoutes({ store, webRoot, sendJson, sendText, readJson, requireHumanPath, proxyIdentity, relayIdentity = () => null }) {
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
      return [{ slug: dir.name, app: appOf(scope), title: scope.title ?? '', updated_at: scope.updated_at ?? '',
        pane: scope.pane ?? '', revision: scope.revision, open: threads.filter((t) => t.status === 'open').length }]
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
    job = { again: false, timer: null, failures: new Map(), holds: new Map() }
    delivering.set(slug, job)
    void deliver(slug, job)
  }

  function cutUnits(text, n) {
    const unit = text.charCodeAt(n - 1)
    return text.slice(0, unit >= 0xd800 && unit <= 0xdbff ? n - 1 : n)
  }

  async function deliver(slug, job) {
    try {
      while (!closed) {
        job.again = false
        let notes = store.pendingScopeNotes(slug)
        const targets = store.pendingScopeTargets(slug)
        if (!notes.length && !targets.length) break
        const scope = readScope(slug)?.scope
        const headingFor = (id) => Array.isArray(scope?.doc?.sections) ? headingOf(scope, id) : id
        const approvalUnavailable = !scope?.approval && notes.some((note) => APPROVAL_MODES.includes(note.event))
        if (approvalUnavailable) notes = notes.filter((note) => !APPROVAL_MODES.includes(note.event))
        const pane = scope?.pane
        if (typeof pane !== 'string' || !PANE.test(pane)) {
          emitNotes(store.markScopeNotes(notes.filter((note) => note.delivery !== 'no_pane').map((note) => note.id), 'no_pane'))
          notes = []
          if (!targets.length && !approvalUnavailable) { job.again = false; break }
        }
        const laneNotes = notes.filter(note => note.event === 'lane_note')
        const approvalNotes = notes.filter((note) => APPROVAL_MODES.includes(note.event))
        const comments = notes.filter(note => note.event !== 'lane_note' && !APPROVAL_MODES.includes(note.event))
        const joined = comments.map((note) => {
          const alex = note.via === 'voice' ? 'Alex (by voice)' : note.via === 'admin' ? 'Alex (in Admin)' : 'Alex'
          const heading = headingFor(note.anchor?.section ?? 'title')
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
        if (line.length > 700) line = `[scoping ${slug}] Alex sent ${comments.length} note(s), too long for one line. Read them: unblock scope notes ${slug} --since ${comments[0].id - 1}`
        let retry = approvalUnavailable, held = false
        async function send(key, targetPane, text, mark) {
          const lanePost = process.env.UNBLOCK_LANE_POST_BIN || (process.env.UNBLOCK_SUPERVISED === '1' && existsSync(join(homedir(), '.local', 'bin', 'lane-post')) ? join(homedir(), '.local', 'bin', 'lane-post') : null)
          const useLanePost = lanePost && !key.startsWith('approval:')
          let status
          if (!useLanePost) try { status = JSON.parse(await promptPane(['agent', 'get', targetPane])).result?.agent?.agent_status } catch { /* Missing herdr never holds a note. */ }
          if (closed) return
          if (status === 'working' || status === 'blocked') {
            const first = job.holds.get(key) ?? Date.now()
            job.holds.set(key, first)
            // A pane blocked on a permission prompt is never typed into; only a working pane hits the cap.
            if (status === 'blocked' || Date.now() - first < delay(process.env.UNBLOCK_SCOPE_HOLD_MAX_MS, 900000)) {
              mark('held')
              held = true
              return
            }
          }
          try {
            if (useLanePost) await new Promise((resolve, reject) => {
              execFile(lanePost, ['post', '--to', targetPane, '--from', `scope:${slug}`, '--kind', 'task', '--topic', `scope-${slug}`, '--wake', 'auto', '--text', text], { timeout: 20_000 }, (error) => error ? reject(error) : resolve())
            })
            else await promptPane(['agent', 'prompt', targetPane, text])
            mark('delivered')
            job.holds.delete(key)
            job.failures.delete(key)
          } catch {
            if (closed) return
            const first = job.failures.get(key) ?? Date.now()
            job.failures.set(key, first)
            if (Date.now() - first >= 30 * 60_000) { mark('failed'); job.failures.delete(key) }
            else { mark('retrying'); retry = true }
          }
        }
        if (comments.length) await send('own', pane, line, (status) => {
          // A note already held is not re-marked on every pause tick, so the page isn't redrawn each time.
          const ids = comments.filter((note) => status !== 'held' || note.delivery !== 'held').map((note) => note.id)
          emitNotes(store.markScopeNotes(ids, status, status === 'delivered' ? new Date().toISOString() : null))
        })
        for (const note of laneNotes) {
          let line = `[scoping ${slug}] Note from Alex's voice call (not a comment): ${compact(note.text)}`
          if (line.length > 700) line = `${cutUnits(line, 699)}…`
          await send(`lane:${note.id}`, pane, line, (status) => {
            if (status !== 'held' || note.delivery !== 'held') emitNotes(store.markScopeNotes([note.id], status, status === 'delivered' ? new Date().toISOString() : null))
          })
        }
        // Approval prompts remain separate, even when other feedback is waiting on the pane.
        if (!held && !retry) for (const note of approvalNotes) {
          const approval = scope.approval
          const alex = `Alex${note.via === 'admin' ? ' in Admin' : note.via === 'voice' ? ' by voice' : ''}`
          const text = compact(note.text)
          const atEt = approval.mode === note.event && approval.comment === note.text ? approval.at_et : eastern(note.at)
          const revision = approval.revision
          const count = scope.threads.filter((thread) => thread.resolution?.how === 'approve' && thread.resolution.at === approval.at).length
          const closedLine = count ? ` ${count} open thread${count === 1 ? '' : 's'} closed with your recommendation${count === 1 ? '' : 's'}.` : ''
          const noteLine = !text ? '' : text.length > 600
            ? ` Alex's note (long, in full at ${join(root, slug, 'APPROVAL.md')}): "${cutUnits(text, 300)}…"`
            : ` Alex's note: "${text}"`
          const line = note.event === 'not_yet'
            ? `[scoping ${slug}] NOT YET from ${alex} (r${revision})${text.length > 600 ? `.${noteLine}` : `: "${text}"`} Keep scoping; answer it on the doc.`
            : `[scoping ${slug}] ${note.event === 'approve' ? 'APPROVED' : 'APPROVED WITH CHANGES'} by ${alex} (r${revision}, ${atEt}).${noteLine} ${note.event === 'approve' ? 'Move to build.' : 'Fold his note into the doc first (unblock scope patch), then move to build.'}${closedLine}`
          await send(`approval:${note.id}`, pane, line, (status) => {
            if (status !== 'held' || note.delivery !== 'held') emitNotes(store.markScopeNotes([note.id], status, status === 'delivered' ? new Date().toISOString() : null))
          })
          if (held || retry) break
        }
        const batches = new Map()
        for (const target of targets) {
          if (!batches.has(target.pane)) batches.set(target.pane, [])
          batches.get(target.pane).push(target)
        }
        for (const [targetPane, batch] of batches) {
          if (closed) break
          const lines = [], valid = []
          for (const target of batch) {
            try {
              const alex = target.via === 'voice' ? 'Alex (by voice)' : target.via === 'admin' ? 'Alex (in Admin)' : 'Alex'
              const heading = headingFor(target.anchor.section)
              lines.push(`[scoping ${slug}] ${alex} tagged you on ${target.thread} (§${heading} "${quoteSnippet(target.anchor.quote)}"): ${compact(target.words ?? target.text)}${/[.!?]$/.test(compact(target.words ?? target.text)) ? '' : '.'} Read it: unblock scope threads ${slug}`)
              valid.push(target)
            } catch { store.markScopeTarget(target.id, target.pane, 'failed') }
          }
          if (!valid.length) continue
          await send(`target:${targetPane}`, targetPane, lines.join(' | '), (status) => {
            for (const target of valid) store.markScopeTarget(target.id, target.pane, status)
          })
        }
        if ((retry || held) && !closed) {
          await new Promise((resolve) => {
            job.wake = resolve
            job.timer = setTimeout(resolve, held ? delay(process.env.UNBLOCK_SCOPE_PAUSE_MS, 1500) : delay(process.env.UNBLOCK_SCOPE_RETRY_MS, 5000))
            job.timer.unref()
          })
          job.wake = null
          job.timer = null
        }
      }
    } catch { /* The next note or file change retries delivery. */ }
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
    const parts = url.pathname.slice('/api/scope/'.length).split('/')
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/scope/')
    const refused = (status, message) => {
      if (write && status >= 400 && status < 500) console.error(`unblock: scope write refused slug=${parts[0]} thread=${parts[1] === 'threads' && THREAD_ID.test(parts[2]) ? parts[2] : '-'} verb=${parts[3] || parts[1] || '-'} status=${status} error=${String(message).replace(/[\r\n]/g, ' ')}`)
    }
    try {
      return await handleRoute(req, res, url, (res, status, body) => { refused(status, body?.error); return sendJson(res, status, body) })
    } catch (error) {
      refused(error.status, error.message)
      throw error
    }
  }

  async function handleRoute(req, res, url, sendJson) {
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
    if (req.method === 'GET' && parts.length === 2 && action === 'context') {
      requireHumanPath(req)
      let brief = ''
      try { brief = readFileSync(join(root, slug, 'BRIEF.md'), 'utf8').slice(0, 6000) } catch { /* No brief yet. */ }
      const words = (url.searchParams.get('q') || '').split(/\s+/).map(word => word.replace(/[^\p{L}\p{N}-]/gu, '')).filter(Boolean).slice(0, 8)
      const said = await new Promise(resolve => {
        execFile(process.env.UNBLOCK_ALEX_SAID || join(homedir(), '.local', 'bin', 'alex-said'), ['--json', '--limit', '3', '--no-refresh', '--', ...words], { timeout: 2000 }, (error, stdout) => {
          if (error) return resolve([])
          try {
            const rows = JSON.parse(stdout)
            resolve(Array.isArray(rows) ? rows.slice(0, 3).map(row => ({ at_et: String(row.at_et || ''), source: String(row.source || ''), text: String(row.text || '').slice(0, 400) })) : [])
          } catch { resolve([]) }
        })
      })
      return sendJson(res, 200, { brief, said })
    }
    if (req.method === 'POST' && parts.length === 2 && action === 'lane-note') {
      const relay = relayIdentity(req)
      if (!relay) requireHumanPath(req)
      const body = await readJson(req)
      if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000 || (body.via !== undefined && body.via !== 'voice')) return sendJson(res, 400, { error: 'invalid lane note' })
      if ((relay || body.client_id !== undefined) && (typeof body.client_id !== 'string' || !CLIENT_ID.test(body.client_id))) return sendJson(res, 400, { error: 'invalid client_id' })
      const duplicate = body.client_id && store.scopeNoteByClientId(slug, body.client_id)
      if (duplicate) return sendJson(res, 200, { note: duplicate, duplicate: true })
      const note = store.addScopeNote({ slug, author: 'alex', kind: 'thought', event: 'lane_note', text: body.text, who: (relay || proxyIdentity(req)).login, via: 'voice', client_id: body.client_id })
      emit(slug, 'note', note)
      schedule(slug)
      return sendJson(res, 200, { note })
    }
    if (req.method === 'GET' && parts.length === 1) return sendJson(res, 200, { ...state, app: appOf(state.scope), notes: store.scopeNotes(slug) })
    if (req.method === 'GET' && parts.length === 2 && action === 'events') return watch(slug, req, res)
    if (req.method === 'GET' && parts.length === 2 && action === 'notes') {
      const raw = url.searchParams.get('since') ?? '0'
      const author = url.searchParams.get('from')
      if (!/^\d+$/.test(raw) || (author && !['alex', 'agent'].includes(author))) return sendJson(res, 400, { error: 'invalid notes filter' })
      return sendJson(res, 200, { notes: store.scopeNotes(slug, { since: Number(raw), author: author || undefined }) })
    }
    if (action === 'assets') {
      const dir = join(root, slug, 'assets')
      if (req.method === 'GET' && parts.length === 3) {
        const asset = readAsset(dir, threadId)
        return asset ? serveAsset(req, res, asset) : sendJson(res, 404, { error: 'no such asset' })
      }
      if (req.method === 'POST' && parts.length === 2) {
        if (proxyIdentity(req) || relayIdentity(req)) return sendJson(res, 403, { error: 'only lanes upload assets' })
        const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        const bytes = await readAssetBody(req, assetLimit(contentType))
        const previous = writes.get(slug) ?? Promise.resolve()
        const pending = previous.catch(() => {}).then(() => storeAsset(dir, bytes, contentType))
        writes.set(slug, pending)
        try {
          const { status, asset } = await pending
          return sendJson(res, status, asset)
        } finally { if (writes.get(slug) === pending) writes.delete(slug) }
      }
      return sendJson(res, 404, { error: 'not found' })
    }
    if (req.method === 'POST' && parts.length === 4 && action === 'threads' && THREAD_ID.test(threadId) && verb === 'pick') {
      if (relayIdentity(req) || !proxyIdentity(req)) return sendJson(res, 403, { error: 'only Alex picks' })
      requireHumanPath(req)
      const thread = state.scope?.threads.find(t => t.id === threadId)
      if (!thread) bad('no such thread', 404)
      if (thread.kind !== 'question' || thread.status !== 'open' || !thread.recommendation) bad('only open lane questions')
      const body = await readJson(req)
      const text = typeof body?.text === 'string' ? body.text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim() : ''
      if (text.length > 4000) bad(`your answer is too long (${text.length} of 4000 characters)`)
      if (!text) bad('invalid text')
      const fallback = { choice: null, confidence: null, sure: false }
      const jev = join(homedir(), '.local', 'bin', 'jev')
      const bin = process.env.UNBLOCK_ASK_PICKER_BIN || (process.env.UNBLOCK_SUPERVISED === '1' && existsSync(jev) ? jev : null)
      if (!bin) return sendJson(res, 200, fallback)
      const choices = new Map([['take', { action: 'take', label: thread.recommendation }]])
      for (const [i, option] of (thread.options || []).entries()) if (i >= 1 && option !== thread.recommendation) choices.set(`option-${i}`, { action: 'option', option: i, label: option })
      choices.set('no', { action: 'no', label: 'No' }); choices.set('else', { action: 'else', label: 'Something else' })
      let dir
      try {
        dir = mkdtempSync(join(tmpdir(), 'unblock-ask-pick-'))
        const file = join(dir, 'elements.json')
        const elements = [...choices].map(([ref, choice]) => ({ ref, role: 'button', name: ref === 'take' ? `Take it: ${choice.label}` : ref === 'no' ? 'No: reject the recommendation' : ref === 'else' ? 'Something else: my own answer, not any option' : choice.label }))
        writeFileSync(file, JSON.stringify({ url: `scope:${slug}#${threadId}`, elements }), { mode: 0o600 })
        const goal = `The lane asked: "${thread.messages[0]?.text}". Alex replied: "${text}". Pick the button that matches what Alex meant.`
        const stdout = await new Promise((resolve, reject) => execFile(bin, ['decide', file, goal], { timeout: 15000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
        const result = JSON.parse(stdout), choice = choices.get(result.target)
        if (!choice || typeof result.confidence !== 'number' || !Number.isFinite(result.confidence)) return sendJson(res, 200, fallback)
        const cut = Number(process.env.UNBLOCK_ASK_PICK_MIN)
        return sendJson(res, 200, { choice, confidence: result.confidence, sure: result.confidence >= (Number.isFinite(cut) ? cut : 0.6) })
      } catch { return sendJson(res, 200, fallback) }
      finally { if (dir) rmSync(dir, { recursive: true, force: true }) }
    }
    const appWrite = req.method === 'PUT' && parts.length === 2 && action === 'app'
    const approvalWrite = req.method === 'POST' && parts.length === 2 && action === 'approve'
    const sectionWrite = req.method === 'PUT' && parts.length === 3 && action === 'sections'
    const docWrite = sectionWrite || (req.method === 'PUT' && parts.length === 2 && action === 'doc')
    const newThread = req.method === 'POST' && parts.length === 2 && action === 'threads'
    const threadWrite = req.method === 'POST' && parts.length === 4 && action === 'threads' && THREAD_ID.test(threadId) && ['reply', 'resolve', 'reject', 'park', 'edit', 'react'].includes(verb)
    if (!appWrite && !approvalWrite && !docWrite && !newThread && !threadWrite) return sendJson(res, 404, { error: 'not found' })
    const relay = relayIdentity(req)
    const human = proxyIdentity(req) || relay
    if (approvalWrite && !relay) {
      if (!human) return sendJson(res, 403, { error: 'only Alex approves' })
      requireHumanPath(req)
    }
    if (['reject', 'park'].includes(verb) && !relay) requireHumanPath(req)
    if ((docWrite || appWrite) && human) {
      const error = new Error('lanes rewrite the doc through the CLI')
      error.code = 'HUMAN_ONLY'; error.status = 403; throw error
    }
    if (verb === 'edit' && human) {
      const error = new Error('lanes edit threads through the CLI')
      error.code = 'HUMAN_ONLY'; error.status = 403; throw error
    }
    if (verb === 'react' && human) return sendJson(res, 403, { error: 'lanes react through the CLI' })
    const body = await readJson(req)
    if (appWrite && !APPS.includes(body?.app)) return sendJson(res, 400, { error: 'invalid app' })
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'invalid body' })
    if (verb === 'react' && body.emoji !== '👀' && body.emoji !== null) return sendJson(res, 400, { error: 'invalid emoji' })
    if (approvalWrite && (Object.keys(body).some((key) => !['mode', 'comment', 'client_id', 'via'].includes(key))
      || !APPROVAL_MODES.includes(body.mode) || (body.comment !== undefined && typeof body.comment !== 'string'))) return sendJson(res, 400, { error: 'invalid approval' })
    if (sectionWrite && (Object.keys(body).some((key) => !['body_md', 'heading', 'keep'].includes(key))
      || typeof body.body_md !== 'string' || (body.heading !== undefined && typeof body.heading !== 'string'))) return sendJson(res, 400, { error: 'invalid section patch' })
    if (body.via !== undefined && !(relay ? ['admin', 'voice'] : ['voice']).includes(body.via)) return sendJson(res, 400, { error: 'invalid via' })
    if ((relay || body.client_id !== undefined) && (typeof body.client_id !== 'string' || !CLIENT_ID.test(body.client_id))) return sendJson(res, 400, { error: 'invalid client_id' })
    if (body.keep !== undefined && (!Array.isArray(body.keep) || body.keep.length > 50 || !body.keep.every((term) => typeof term === 'string' && term.length <= 60))) return sendJson(res, 400, { error: 'invalid keep' })
    if (relay && body.via === undefined) body.via = 'admin'
    const previous = writes.get(slug) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => changeScope(slug, { body, human, appWrite, approvalWrite, docWrite, sectionWrite, newThread, threadId, verb }))
    writes.set(slug, pending)
    try {
      const result = await pending
      if (approvalWrite && !result.duplicate && approved(result.approval)) res.once('finish', () => { void moveApprovedTab(slug, result.revision) })
      return sendJson(res, result.error === 'unslop' ? 422 : newThread && !result.duplicate ? 201 : 200, result)
    } finally { if (writes.get(slug) === pending) writes.delete(slug) }
  }

  async function moveApprovedTab(slug, revision) {
    await moveTabToInflight({ pane: readScope(slug)?.scope?.pane, revision })
  }

  function approveScope(slug, scope, body, human) {
    const comment = (body.comment ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim()
    if (comment.length > 4000 || (body.mode !== 'approve' && !comment)) bad('invalid comment')
    if (body.client_id && body.client_id === scope.approval?.client_id) return { approval: scope.approval, duplicate: true }
    if (approved(scope.approval)) bad('already approved', 409)
    const at = new Date().toISOString(), at_et = eastern(at), closed = []
    scope.approval = { mode: body.mode, by: 'alex', who: human.login, at, at_et, revision: scope.revision, comment,
      ...(body.via !== undefined ? { via: body.via } : {}), ...(body.client_id !== undefined ? { client_id: body.client_id } : {}) }
    if (approved(scope.approval)) for (const thread of scope.threads) {
      if (thread.status !== 'open') continue
      delete thread.reaction
      thread.status = 'resolved'
      thread.resolution = { decision: thread.recommendation ?? 'Approved with the scope', alex_words: null, by: 'alex', how: 'approve', at, confirmed_at: at, revision: scope.revision }
      closed.push(thread.id)
    }
    scope.updated_at = at
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    const dir = join(root, slug)
    writeFileSync(join(dir, 'APPROVAL.md'), `# Scope approval\n\nMode: ${body.mode}\nWhen: ${at_et}\nRevision: ${scope.revision}\nWho: ${human.login}\nVia: ${body.via ?? 'page'}\n\n${comment}\n`)
    appendApprovalIndex(root, { slug, revision: scope.revision, mode: body.mode, comment, at_et })
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    const note = store.addScopeNote({ slug, author: 'alex', kind: 'thought', event: body.mode, text: comment, who: human.login, via: body.via })
    emit(slug, 'note', note)
    const entry = listeners.get(slug)
    if (entry) entry.meta = metadata(slug)
    emit(slug, 'scope', { ...readScope(slug), notes: store.scopeNotes(slug) })
    schedule(slug)
    return { approval: scope.approval, closed, revision: scope.revision }
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

  function changeScope(slug, { body, human, appWrite, approvalWrite, docWrite, sectionWrite, newThread, threadId, verb }) {
    const dir = join(root, slug)
    let raw, disk
    try { raw = readFileSync(join(dir, 'scope.json')); disk = JSON.parse(raw) } catch { bad('scope.json is being rewritten') }
    const scope = disk.version === 2 ? disk : migrateV1(disk, disk.updated_at)
    if (appWrite) {
      scope.app = body.app
      const problems = validateScope(scope)
      if (problems.length) bad(problems[0])
      writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
      renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
      const entry = listeners.get(slug)
      if (entry) entry.meta = metadata(slug)
      emit(slug, 'scope', { ...readScope(slug), notes: store.scopeNotes(slug) })
      return { app: scope.app }
    }
    if (approvalWrite) return approveScope(slug, scope, body, human)
    const storedSections = scope.doc.sections
    if (sectionWrite) {
      if (!storedSections.some((section) => section.id === threadId)) bad('no such section', 404)
      body = { sections: storedSections.map((section) => section.id === threadId
        ? { ...section, body_md: body.body_md, ...(body.heading !== undefined ? { heading: body.heading } : {}) }
        : section), ...(body.keep !== undefined ? { keep: body.keep } : {}) }
    }
    if (body.client_id !== undefined) {
      const duplicate = scope.threads.find((thread) => thread.messages.some((message) => message.client_id === body.client_id)
        || thread.resolution?.client_id === body.client_id || thread.parked_client_id === body.client_id)
      if (duplicate) return { thread: duplicate, duplicate: true }
    }
    const client = body.client_id === undefined ? {} : { client_id: body.client_id }
    const via = body.via === undefined ? {} : { via: body.via }
    const at = new Date().toISOString()
    const text = (value, limit = human ? 4000 : 600, preserve = false) => {
      const sanitized = typeof value === 'string' ? human ? value.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '') : compact(value) : ''
      const cleaned = preserve ? sanitized : sanitized.trim()
      if (cleaned.length > limit) bad(`your answer is too long (${cleaned.length} of ${limit} characters)`)
      if (!cleaned.trim()) bad('invalid text')
      return cleaned
    }
    const setOptions = (thread) => {
      if (thread.kind !== 'question') bad('only questions have options')
      const options = body.options
      if (!Array.isArray(options) || (options.length !== 0 && (options.length < 2 || options.length > 5)) || !options.every((option) => typeof option === 'string' && option.length >= 1 && option.length <= 200)) bad('invalid options')
      if (options.length && (!thread.recommendation || options[0] !== thread.recommendation)) bad('options[0] must equal the recommendation')
      if (options.length) thread.options = options
      else delete thread.options
    }
    let thread, noteData = null, result
    if (docWrite) {
      const sections = Array.isArray(body.sections) ? body.sections.map((section) => {
        if (!section || typeof section !== 'object' || Array.isArray(section)) return section
        const { updated_at, ...next } = section
        const previous = scope.doc.sections.find((stored) => stored.id === next.id)
        if (!previous || previous.heading !== next.heading || previous.body_md !== next.body_md) next.updated_at = at
        else if (previous.updated_at !== undefined) next.updated_at = previous.updated_at
        return next
      }) : body.sections
      scope.doc = { sections, assets: docAssets(join(dir, 'assets'), sections) }
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
      thread = { id: nextThreadId(scope), anchor, author: human ? 'alex' : 'agent', kind, status: 'open', messages: [{ from: human ? 'alex' : 'agent', text: text(body.text), at, ...via, ...client }], created_at: at }
      if (!human && body.recommendation !== undefined) thread.recommendation = text(body.recommendation, 600)
      if (!human && body.why !== undefined) thread.why = text(body.why, 600)
      if (body.options !== undefined) {
        if (human || !thread.recommendation) bad('options require an agent recommendation')
        setOptions(thread)
      }
      scope.threads.push(thread)
      if (human) noteData = { event: 'new', text: thread.messages[0].text }
      result = { thread }
    } else {
      thread = scope.threads.find((t) => t.id === threadId)
      if (!thread) bad('no such thread', 404)
      if (verb !== 'react') delete thread.reaction
      if (verb === 'react') {
        if (body.emoji === null) delete thread.reaction
        else thread.reaction = { emoji: '👀', by: 'agent', at }
      } else if (verb === 'edit') {
        if (body.section === undefined && body.quote === undefined && body.options === undefined && body.text === undefined) bad('edit needs section and quote, options or text')
        if (body.text !== undefined) {
          if (thread.messages[0].from === 'alex') bad("only the lane's own question can be reworded")
          thread.messages[0].text = text(body.text)
          thread.messages[0].edited_at = at
        }
        if (body.section !== undefined || body.quote !== undefined) {
          const section = scope.doc.sections.find((s) => s.id === body.section)
          const anchor = section && typeof body.quote === 'string' ? anchorInSection(section, body.quote) : null
          if (!anchor) bad(`quote not found in §${body.section}`)
          thread.anchor = normalizeAnchor({ ...anchor, t: thread.anchor.t, t_end: thread.anchor.t_end })
        }
        if (body.options !== undefined) setOptions(thread)
      } else if (verb === 'reply') {
        if (body.options !== undefined && (human || body.recommendation === undefined)) bad('options require an agent recommendation')
        const message = { from: human ? 'alex' : 'agent', text: text(body.text), at, ...via, ...client }
        if (!human && body.recommendation !== undefined) {
          if (thread.kind !== 'question') bad('only questions have recommendations')
          thread.recommendation = text(body.recommendation, 600)
          if (body.options !== undefined) setOptions(thread)
          else delete thread.options
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
        thread.messages.push({ from: 'alex', kind: 'reject', text: reason, at, ...via, ...client })
        noteData = { event: 'reject', text: reason }
      } else if (verb === 'park') {
        if (thread.status !== 'open') bad('only open threads can be parked')
        thread.status = 'parked'; thread.parked_at = at
        if (body.client_id !== undefined) thread.parked_client_id = body.client_id
        noteData = { event: 'park', text: '' }
      } else if (human) {
        const how = body.how ?? 'resolve'
        if (!['take', 'own', 'resolve'].includes(how)) bad('invalid how')
        const decision = text(body.decision, 4000, true)
        const words = body.alex_words == null ? decision : text(body.alex_words, 4000, true)
        thread.status = 'resolved'
        thread.resolution = { decision, alex_words: words, by: 'alex', how, at, confirmed_at: null, revision: null, ...client }
        noteData = { event: how, text: decision, words: body.alex_words == null ? null : words }
      } else if (thread.status === 'open') {
        if ((thread.author ?? thread.messages[0]?.from) === 'alex') {
          if (thread.messages.at(-1)?.from !== 'agent') {
            if (typeof body.decision !== 'string' || !body.decision.trim()) bad(`reply to Alex's comment first: unblock scope reply ${slug} ${thread.id}`)
            thread.messages.push({ from: 'agent', text: text(body.decision, 600), at, ...client })
          }
          delete thread.resolution
          result = { kept_open: true }
        } else {
          thread.status = 'resolved'
          thread.resolution = { decision: text(body.decision, 600), alex_words: null, by: 'agent', at, confirmed_at: at, revision: scope.revision, ...client }
        }
      } else if (thread.resolution?.by === 'alex' && !thread.resolution.confirmed_at) {
        thread.resolution.confirmed_at = at; thread.resolution.revision = scope.revision
      }
      result = { ...result, thread }
    }
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    if (!human && verb !== 'react') {
      const { keep = [] } = body
      const changed = docWrite ? body.sections.filter((section) => {
        const stored = storedSections.find((old) => old.id === section.id)
        return !stored || stored.heading !== section.heading || stored.body_md !== section.body_md
      }) : []
      const lint = docWrite ? lintDoc(changed, { keep }) : { findings: [], warnings: [] }
      if (!docWrite) {
        for (const field of ['text', 'recommendation', 'why', 'decision']) {
          if (typeof body[field] === 'string') lint.findings.push(...lintText(body[field], { keep }).map((finding) => ({ field, ...finding })))
        }
        for (const [index, option] of (Array.isArray(body.options) ? body.options : []).entries()) {
          lint.findings.push(...lintText(option, { keep }).map((finding) => ({ field: `options[${index}]`, ...finding })))
        }
      }
      if (lint.findings.length) return { error: 'unslop', findings: lint.findings }
      if (docWrite) result.warnings = lint.warnings
    }
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
        if (t.anchor.general) return false
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
