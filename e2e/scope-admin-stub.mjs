// Owner: Opus (rpt_83ad547f59e62008, 2026-10-01; copied from scope-stub.mjs r41, never edit it to pass).
// Alex (07:48 ET): "rails is laggy. cmd + enter on a scoping note doesnt reliably work. fix this". Plus p6 (08:05 ET): Approve
// scope is missing in Admin. This stub stands in for Development area's mirrored scopes the way prod serves them:
//   mode admin: boot events:false (the page polls every 2 s), approve:'host' and comment:'host' on every page, like Admin's boot.js.
//   POST /w/api/live-scopes/demo/threads/T<n>/pick answers by /__pick?mode=missing (404, Admin before this fix) | fail (500) |
//     slow (a sure 'take', 9 s late) | slowno (a sure 'no', 7 s late) | take | unsure; default missing.
//   /__envelope changes only the envelope (generated_at, received_at), the way each scopes push does; the scope is unchanged.
//   /__ask[?id=T6] adds an open lane question (default T5, recommendation 'Yes').
//   GET /frame/demo[?host=1] is a same-origin host page framing /scope/demo; with host=1 its iframe carries data-approve-host="1"
//     (w.mjs after this fix). The host records every postMessage from the frame in window.__msgs.
// Owner: Opus (r41 Reopen, Delete and resolved-hidden, from stub-r40: POST comments/T<n>/reopen and /delete; hooks /__detached_resolved). A stand-in host for the live-update focus scenario (never edit it to pass).
// usage: node stub-r21.mjs <port> <worktree> <bundle-dir> <log-file> <embed|solo>
// Serves the scope bundle (web/dist-scope) under a strict CSP, the way Development area does, with the live-docs routes
// the r14 stub mirrors (agent-rails 14b3d06): view envelope, SSE stream, POST writes that answer with the store
// comment. The stream stays open here (r14 covers planned reconnects), so a hook's change arrives by event at once. Mode embed passes boot.embed true (Admin); solo leaves it off (a standalone page).
//   GET /scope/demo   the doc page (boot: slug demo)          GET /list/   the scope index (boot: no slug)
//   GET /host/demo    the doc page with approve and comment in host mode (the host page draws those buttons)
//   GET /w/api/live-scopes, /w/api/live-scopes/demo, /demo/events, /demo/assets/<id>; POST /demo/threads[/T<n>/<verb>]
// The view carries notes (the unblock daemon's delivery notes) as well as comment.delivery (the Rails relay's field).
// A new comment keeps anchor.general when it is on the title, as the unblock daemon does after r21 (Rails needs the same).
// Test hooks (each answers {seq}, the revision the page will show): /__reset, /__delivery?thread=T2&state=queued,
// /__note?thread=T1&delivery=held, /__lane_edit, /__rename_title; r33: /__grow_title (the title body grows above
// everything), /__edit_later (paragraph 16 of Later changes), /__lane_reply (the lane replies on T1 and asks a new question),
// /__remove_later (the Later section is deleted)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const [port, wt, dist, logFile, mode] = process.argv.slice(2)
const { anchorInSection } = await import(pathToFileURL(path.join(wt, 'src', 'scope-doc.js')).href)
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https:"
const ORIGIN = `http://127.0.0.1:${port}`
const log = (entry) => fs.appendFileSync(logFile, JSON.stringify(entry) + '\n')
const stamp = () => new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z')
const LATER = Array.from({ length: 16 }, (_, i) => `Later paragraph ${i + 1}: settings and themes wait for pass ${i + 1}, after the page ships to phones and the lane has read every note.`).join('\n\n')
const SHOT = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" fill="#8fa9b3"/><rect x="40" y="60" width="520" height="80" rx="12" fill="#e9eef0"/></svg>'

let doc, seq, sections, threads, notes, listeners, pickMode = 'missing', envelopeAt = null
const images = new Map()
function reset() {
  const at = '2026-09-29T20:00:00.000Z'
  seq = 3; listeners?.forEach((l) => l.end()); listeners = new Set(); notes = []
  doc = { slug: 'demo', title: 'Scope page fixes', pane: 'w5H:pT1', created_at: at, updated_at: at }
  sections = {
    title: { heading: 'Scope page fixes', body_md: 'A doc the page keeps live.', updated_at: at },
    plan: { heading: 'The plan', body_md: 'We ship the page first. The runner is Executor. Voice comes last.\n\n![Phone one](asset:shot1)\n![Phone two](asset:shot2)\nFigure: Two phone screens side by side.', updated_at: at },
    later: { heading: 'Later', body_md: LATER, updated_at: at },
  }
  const on = (id, quote) => { const a = anchorInSection({ id, heading: sections[id].heading, body_md: sections[id].body_md }, quote); return { section: id, quote: a.quote, prefix: a.prefix || '', suffix: a.suffix || '' } }
  threads = [
    { id: 'T1', anchor: on('plan', 'The runner is Executor'), kind: 'question', status: 'open', recommendation: 'Executor', messages: [{ from: 'agent', text: 'Which runner?', at }] },
    { id: 'T2', anchor: on('plan', 'Voice comes last'), kind: 'comment', status: 'open', messages: [{ from: 'alex', text: 'Why last?', at, via: 'admin' }] },
    // Anchored in the doc title (the h1), which an embedded page hides.
    { id: 'T3', anchor: on('title', 'Scope page fixes'), kind: 'comment', status: 'open', messages: [{ from: 'alex', text: 'Rename it?', at, via: 'admin' }] },
    // A delivery value the page doesn't know, from the first load.
    { id: 'T4', anchor: on('plan', 'We ship the page first'), kind: 'comment', status: 'open', delivery: 'weird', messages: [{ from: 'alex', text: 'Which page?', at, via: 'admin' }] },
  ]
}

function view() {
  const list = Object.entries(sections).map(([id, s]) => ({ id, heading: s.heading, body_md: s.body_md, updated_at: s.updated_at }))
  const projected = threads.map((t) => {
    const p = { id: t.id, anchor: { ...t.anchor }, author: t.messages[0].from, kind: t.kind, status: t.status, detached: false, created_at: t.messages[0].at, messages: t.messages.map((m) => ({ ...m })) }
    for (const k of ['recommendation', 'delivery', 'reaction']) if (k in t) p[k] = t[k]
    if (t.status === 'resolved') { const rat = t.resolved_at || t.messages.at(-1).at; p.resolution = { decision: t.decision, by: t.by || 'alex', alex_words: (t.by || 'alex') === 'alex' ? t.decision : null, how: t.how || 'resolve', at: rat, confirmed_at: rat, revision: null, ...(t.images?.length ? { images: t.images } : {}) } }
    return p
  })
  const assets = { shot1: { type: 'image', width: 600, height: 800 }, shot2: { type: 'image', width: 600, height: 800 } }
  const scope = { version: 2, slug: doc.slug, title: doc.title, pane: doc.pane, revision: seq, updated_at: doc.updated_at, doc: { sections: list, assets }, threads: projected, presence: [] }
  const at = envelopeAt || doc.updated_at
  return { generated_at: at, source: 'live-docs', received_at: at, data: scope, scope, notes: notes.map((n) => ({ ...n })) }
}

function bump() {
  seq += 1; doc.updated_at = stamp()
  const frame = `id: ${seq}\nevent: scope\ndata: ${JSON.stringify(view())}\n\n`
  for (const l of listeners) l.write(frame)
}

function write(route, body) {
  const now = stamp(), pics = (Array.isArray(body.images) ? body.images : []).map((id) => images.get(id)).filter(Boolean).map(({ id, width, height }) => ({ id, width, height }))
  if (Array.isArray(body.images) && (body.images.length > 6 || pics.length !== body.images.length)) return [400, { error: 'invalid_images' }]
  const msg = (text) => ({ from: 'alex', text, at: now, via: 'admin', ...(pics.length ? { images: pics } : {}) })
  const [, id, verb] = route.match(/^threads(?:\/(T[1-9]\d*)\/(reply|resolve|reject|park|reopen|delete))?$/) || []
  let t
  if (!id) {
    const a = body.anchor || {}
    t = { id: `T${threads.length + 1}`, anchor: { section: a.section, quote: a.quote, prefix: a.prefix || '', suffix: a.suffix || '', ...(a.general === true && a.section === 'title' ? { general: true } : {}) }, kind: 'comment', status: 'open', messages: [msg(body.text)] }
    threads.push(t)
  } else {
    t = threads.find((x) => x.id === id)
    if (!t) return [404, { error: 'no_thread' }]
    if (verb === 'reply' || verb === 'reject') t.messages.push(msg(body.text))
    if (verb === 'resolve') { t.status = 'resolved'; t.decision = body.decision; t.by = 'alex'; t.how = body.how || 'resolve'; t.resolved_at = now; t.images = pics }
    if (verb === 'park') t.status = 'parked'
    if (verb === 'reopen') { if (t.status === 'open') return [400, { error: 'only resolved or parked comments reopen' }]; t.status = 'open'; for (const k of ['decision', 'by', 'how', 'resolved_at', 'images']) delete t[k] }
    if (verb === 'delete') { if (t.messages[0].from !== 'alex') return [403, { error: 'only his own notes' }]; threads = threads.filter((x) => x !== t) }
  }
  bump()
  const store = { id: t.id, anchor: { block: 'B1', quote: t.anchor.quote, prefix: t.anchor.prefix, suffix: t.anchor.suffix }, section: t.anchor.section, kind: t.kind, status: t.status, messages: t.messages, updated_seq: seq }
  return [200, { seq, op: 'thread.' + (verb || 'open'), target: t.id, at: now, actor: 'owner', actor_kind: 'human', via: 'admin', thread: store }]
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' }
const boot = (slug, host) => `window.__csp = [];
addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective + ' ' + (e.blockedURI || '')));
window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));
window.__SCOPE_BOOT__ = ${JSON.stringify({ ...(slug ? { slug } : {}), api: '/w/api/live-scopes', events: mode !== 'admin', embed: mode === 'embed' || mode === 'admin', voice: false, ...(host || mode === 'admin' ? { approve: 'host', comment: 'host' } : {}) })};`

reset()
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const buf = Buffer.concat(chunks), type = String(req.headers['content-type'] || '').split(';')[0].trim()
    let body
    if (type.startsWith('image/')) body = undefined
    else try { body = buf.length ? JSON.parse(buf.toString('utf8')) : undefined } catch { body = undefined }
    log({ method: req.method, path: url.pathname, body, ...(type.startsWith('image/') ? { content_type: type, bytes: buf.length } : {}) })
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' })
      res.end(type === 'application/json' ? JSON.stringify(data) : data)
    }
    const q = url.searchParams
    if (url.pathname === '/__reset') { reset(); images.clear(); pickMode = 'missing'; envelopeAt = null; return send(200, { ok: true }) }
    if (url.pathname === '/__pick') { pickMode = q.get('mode'); return send(200, { ok: true }) }
    if (url.pathname === '/__envelope') { envelopeAt = stamp(); return send(200, { seq }) }
    if (url.pathname === '/__ask') {
      const at = stamp(), on = anchorInSection({ id: 'plan', heading: sections.plan.heading, body_md: sections.plan.body_md }, 'Voice comes last')
      threads.push({ id: q.get('id') || 'T5', anchor: { section: 'plan', quote: on.quote, prefix: on.prefix || '', suffix: on.suffix || '' }, kind: 'question', status: 'open', recommendation: 'Yes', messages: [{ from: 'agent', text: 'Voice after phones?', at }] })
      bump(); return send(200, { seq })
    }
    if (url.pathname === '/frame/demo') return res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': CSP.replace('frame-src https:', "frame-src 'self'"), 'Cache-Control': 'no-store' }), res.end(`<!doctype html><meta charset="utf-8"><title>host</title><link rel="stylesheet" href="/frame.css"><body><iframe id="f" src="/scope/demo"${q.get('host') === '1' ? ' data-approve-host="1"' : ''}></iframe><script src="/frame.js"></script>`)
    if (url.pathname === '/frame.css') return send(200, 'body { margin: 0 } iframe { border: 0; width: 100vw; height: 100vh; display: block }', 'text/css')
    if (url.pathname === '/frame.js') return send(200, "window.__msgs = []; addEventListener('message', (e) => window.__msgs.push(JSON.stringify(e.data)));", 'text/javascript')
    if (url.pathname === '/__delivery') { threads.find((t) => t.id === q.get('thread')).delivery = q.get('state'); bump(); return send(200, { seq }) }
    if (url.pathname === '/__note') {
      const id = `N-${q.get('thread')}`, at = stamp()
      notes = notes.filter((n) => n.id !== id).concat([{ id, thread: q.get('thread'), from: 'alex', event: 'comment', at, delivery: q.get('delivery'), delivered_at: at }])
      bump(); return send(200, { seq })
    }
    if (url.pathname === '/__rename_title') { sections.title.heading = doc.title = 'Phone scope'; sections.title.updated_at = stamp(); bump(); return send(200, { seq }) }
    if (url.pathname === '/__react') { const t = threads.find((x) => x.id === q.get('thread')); if (q.get('clear')) delete t.reaction; else t.reaction = { emoji: '👀', by: 'agent', at: stamp() }; bump(); return send(200, { seq }) }
    if (url.pathname === '/__lane_answer') { const t = threads.find((x) => x.id === q.get('thread')); t.messages.push({ from: 'agent', text: 'Yes, Sol 6.1 medium.', at: stamp() }); delete t.reaction; bump(); return send(200, { seq }) }
    // r37: a Rails relay that still lets a lane close Alex's comment (what pNE did on routing-next); the answer is on the comment.
    if (url.pathname === '/__agent_resolve') { const t = threads.find((x) => x.id === q.get('thread')); t.status = 'resolved'; t.by = 'agent'; t.how = undefined; t.decision = 'Answered in comment'; t.resolved_at = stamp(); delete t.reaction; bump(); return send(200, { seq }) }
    // r37: Alex took the lane's recommendation and the lane confirmed it.
    if (url.pathname === '/__alex_take') { const t = threads.find((x) => x.id === q.get('thread')); t.status = 'resolved'; t.by = 'alex'; t.how = 'take'; t.decision = t.recommendation; t.resolved_at = stamp(); bump(); return send(200, { seq }) }
    // r37: a comment resolved two days ago, on "Voice comes last".
    if (url.pathname === '/__old_resolved') {
      const old = new Date(Date.now() - 2 * 86400_000).toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z'), a = anchorInSection({ id: 'plan', heading: sections.plan.heading, body_md: sections.plan.body_md }, 'Voice comes last')
      threads.push({ id: `T${threads.length + 1}`, anchor: { section: 'plan', quote: a.quote, prefix: a.prefix || '', suffix: a.suffix || '' }, kind: 'comment', status: 'resolved', by: 'alex', how: 'resolve', decision: 'Old news', resolved_at: old, messages: [{ from: 'alex', text: 'An old note.', at: old, via: 'admin' }] })
      bump(); return send(200, { seq })
    }
    // r41: a resolved comment whose text is gone from the doc (it lands in the Detached group).
    if (url.pathname === '/__detached_resolved') { const now = stamp(); threads.push({ id: `T${threads.length + 1}`, anchor: { section: 'plan', quote: 'A sentence the lane deleted', prefix: '', suffix: '' }, kind: 'comment', status: 'resolved', by: 'alex', how: 'resolve', decision: 'Done', resolved_at: now, messages: [{ from: 'alex', text: 'A detached note.', at: now, via: 'admin' }] }); bump(); return send(200, { seq }) }
    if (url.pathname === '/__grow_title') { sections.title.body_md += '\n\nThe lane added a paragraph above everything, long enough to push the rest of the doc down by a few lines on any screen width.'; sections.title.updated_at = stamp(); bump(); return send(200, { seq }) }
    if (url.pathname === '/__edit_later') { const s = sections.later; s.body_md = s.body_md.replace('Later paragraph 16: settings and themes wait for pass 16', 'Later paragraph 16: settings, themes and fonts wait for pass 16'); s.updated_at = stamp(); bump(); return send(200, { seq }) }
    if (url.pathname === '/__remove_later') { delete sections.later; bump(); return send(200, { seq }) }
    if (url.pathname === '/__lane_reply') {
      const at = stamp(), on = anchorInSection({ id: 'plan', heading: sections.plan.heading, body_md: sections.plan.body_md }, 'Voice comes last')
      threads.find((t) => t.id === 'T1').messages.push({ from: 'agent', text: 'Executor it is, unless you say otherwise.', at })
      threads.push({ id: `T${threads.length + 1}`, anchor: { section: 'plan', quote: on.quote, prefix: on.prefix || '', suffix: on.suffix || '' }, kind: 'question', status: 'open', recommendation: 'Yes', messages: [{ from: 'agent', text: 'Voice after phones?', at }] })
      bump(); return send(200, { seq })
    }
    if (url.pathname === '/__lane_edit') { const s = sections.plan; s.body_md = s.body_md.replace('We ship the page first.', 'We ship the page first, on phones.'); s.updated_at = stamp(); bump(); return send(200, { seq }) }
    const page = url.pathname.match(/^\/(scope|list|host)\/(.*)$/)
    if (page) {
      const [, prefix, rest] = page
      if (rest === 'boot.js') return send(200, boot(prefix === 'list' ? null : 'demo', prefix === 'host'), 'text/javascript')
      if ((prefix !== 'list' && rest === 'demo') || (prefix === 'list' && rest === '')) return send(200, fs.readFileSync(path.join(dist, 'index.html')), 'text/html')
      const file = path.join(dist, rest)
      if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(404, { error: 'not found' })
      return send(200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream')
    }
    if (url.pathname === '/w/api/live-scopes' && req.method === 'GET') return send(200, { scopes: [{ slug: 'demo', title: doc.title, pane: doc.pane, revision: seq, updated_at: doc.updated_at }] })
    const m = url.pathname.match(/^\/w\/api\/live-scopes\/demo(?:\/(.*))?$/)
    if (m && req.method === 'GET' && !m[1]) return send(200, view())
    if (m && req.method === 'GET' && /^assets\/shot[12]$/.test(m[1] || '')) return send(200, SHOT, 'image/svg+xml')
    // r40: Alex's pictures. Raster only, 8 MiB, same-origin; sized from the PNG/GIF/JPEG header like the daemon.
    if (m && req.method === 'POST' && m[1] === 'assets') {
      if (req.headers.origin !== ORIGIN) return send(403, { error: 'origin_mismatch' })
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[type]
      if (!ext) return send(415, { error: 'images only: PNG, JPEG, WebP or GIF' })
      if (buf.length > 8 * 1024 * 1024) return send(413, { error: 'asset exceeds 8 MiB' })
      let width = 0, height = 0
      if (ext === 'png' && buf.length > 24) { width = buf.readUInt32BE(16); height = buf.readUInt32BE(20) }
      else if (ext === 'gif' && buf.length > 10) { width = buf.readUInt16LE(6); height = buf.readUInt16LE(8) }
      else if (ext === 'jpg') { for (let p = 2; p + 9 < buf.length;) { const mk = buf[p + 1], len = buf.readUInt16BE(p + 2); if (mk >= 0xc0 && mk <= 0xc3) { height = buf.readUInt16BE(p + 5); width = buf.readUInt16BE(p + 7); break } p += 2 + len } }
      else { width = 1; height = 1 }
      if (!width || !height) return send(400, { error: 'invalid image' })
      const id = `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`, fresh = !images.has(id)
      images.set(id, { id, width, height, type, buf })
      return send(fresh ? 201 : 200, { id, ref: `asset:${id}`, type: 'image', width, height })
    }
    if (m && req.method === 'GET' && images.has((m[1] || '').replace(/^assets\//, ''))) { const im = images.get(m[1].replace(/^assets\//, '')); res.writeHead(200, { 'Content-Type': im.type, 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' }); return res.end(im.buf) }
    if (m && req.method === 'GET' && m[1] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' })
      res.write(`id: ${seq}\nevent: state\ndata: ${JSON.stringify(view())}\n\n`)
      listeners.add(res)
      res.on('close', () => listeners.delete(res))
      return
    }
    const pick = m && req.method === 'POST' && (m[1] || '').match(/^threads\/(T[1-9]\d*)\/pick$/)
    if (pick) {
      if (req.headers.origin !== ORIGIN) return send(403, { error: 'origin_mismatch' })
      const sure = { choice: { action: 'take', label: threads.find((t) => t.id === pick[1])?.recommendation }, confidence: 0.9, sure: true }
      if (pickMode === 'missing') return send(404, { error: 'not found' })
      if (pickMode === 'fail') return send(500, { error: 'boom' })
      if (pickMode === 'unsure') return send(200, { choice: null, confidence: null, sure: false })
      if (pickMode === 'slow') return void setTimeout(() => send(200, sure), 9000)
      if (pickMode === 'slowno') return void setTimeout(() => send(200, { choice: { action: 'no', label: 'No' }, confidence: 0.9, sure: true }), 7000)
      return send(200, sure)
    }
    if (m && req.method === 'POST' && m[1]) {
      if (req.headers.origin !== ORIGIN) return send(403, { error: 'origin_mismatch' })
      if (!body || typeof body.client_id !== 'string') return send(400, { error: 'invalid_write' })
      const [status, data] = write(m[1], body)
      return send(status, data)
    }
    send(404, { error: 'not found' })
  })
}).listen(Number(port), '127.0.0.1')
