import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, renameSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { promptPane, remoteScopeHost, scopePostCommand } from './pane-notice.js'
import { appendApprovalIndex, moveTabToInflight } from './scope-approvals.js'
import { lintDoc, lintText } from './scope-lint.js'
import { buildDocError, buildFences } from './scope-build.js'
import { ASSET_ID, readAsset, readAssetBody, assetLimit, storeAsset, serveAsset, docAssets } from './scope-assets.js'
import { normalizeAnchor, quoteSnippet, locateAnchor, hasEmbedFence } from './scope-anchor.js'
import { kindOf as registeredKindOf, kindSpec as registeredKindSpec } from './doc-kinds.js'
import { migrateV1, validateScope, normalizeKpis, sectionPlain, anchorInSection, headingOf, sectionHash, nextThreadId, THREAD_ID, SECTION_ID, APPS, appOf, DOC_WHERES, MODEL_ALIAS } from './scope-doc.js'
import { createAnswerer } from './explainer-answerer.js'
import { createLiveItems, MAX_TEXT } from './live-items.js'
import { handleScopeTelemetry } from './scope-telemetry.js'

// Writing docs retain the upstream draft kind's comment and approval policy.
const kindOf = (scope) => scope.kind === 'writing' ? 'writing' : registeredKindOf(scope)
const kindSpec = (scope) => registeredKindSpec(scope.kind === 'writing' ? { ...scope, kind: 'draft' } : scope)

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/
const PANE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
const RELAY_PANE = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/
const APPROVAL_MODES = ['approve', 'approve_to_try', 'approve_with_changes', 'not_yet']
const approved = (approval) => ['approve', 'approve_to_try', 'approve_with_changes'].includes(approval?.mode)
const eastern = (at) => `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(at))} ET`
const compact = (text) => text.replace(/\s+/g, ' ').trim()
const delay = (value, fallback) => Number(value) > 0 ? Number(value) : fallback

export function createScopeRoutes({ store, webRoot, sendJson, sendText, readJson, requireHumanPath, proxyIdentity, relayIdentity = () => null }) {
  const root = process.env.UNBLOCK_SCOPING_DIR || join(homedir(), '.agent-rails', 'scoping')
  const cache = new Map()
  const listeners = new Map()
  const liveItems = createLiveItems({ emit })
  const delivering = new Map()
  const writes = new Map()
  const noteWaits = new Map()
  let answerer
  const paneNames = new Map()
  let closed = false
  let readTimer = null
  let scanningReads = false
  let bulletinOffset = 0
  let bulletinSize = -1
  let bulletinScanAt = ''
  let bulletinTail = Buffer.alloc(0)
  const bulletinReads = new Map()

  // A deleted thread frees its id and the next comment can take it, so the note for an id is the newest 'new' one,
  // and none once a delete follows it.
  function currentNewNotes(slug, threadIds) {
    const current = new Map()
    for (const note of store.scopeNotes(slug)) {
      if (!threadIds.includes(note.thread)) continue
      if (note.event === 'new') current.set(note.thread, note)
      else if (note.event === 'delete') current.delete(note.thread)
    }
    return [...current.values()]
  }

  function currentNoteId(slug, threadId) {
    return currentNewNotes(slug, [threadId]).find(note => note.stamps)?.id ?? null
  }

  // With a noteId the stamps are for that incarnation of the thread; if its id has since been reused they are dropped.
  function stampThread(slug, threadId, stamps, noteId) {
    const note = currentNewNotes(slug, [threadId]).find(note => note.stamps)
    if (note && (noteId === undefined || note.id === noteId)) {
      const stamped = store.mergeScopeNoteStamps(note.id, stamps)
      if (stamped) emit(slug, 'note', stamped)
    }
  }

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
      if (scope.approve_default !== undefined && !['try', 'ship'].includes(scope.approve_default)) delete scope.approve_default
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
        pane: scope.pane ?? '', revision: scope.revision, open: threads.filter((t) => t.status === 'open').length,
        kind: kindOf(scope), state: scope.state ?? 'draft' }]
    }).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  }

  function emit(slug, event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of listeners.get(slug)?.clients ?? []) client.write(message)
  }

  function emitNote(note) {
    emit(note.slug, 'note', note)
    for (const settle of noteWaits.get(note.slug)?.get(note.id) ?? []) settle(note.delivery)
  }

  function emitNotes(notes) {
    for (const note of notes) emitNote(note)
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
        if (data) emit(slug, 'scope', { ...data, notes: scopeNotes(slug), ...buildActuals(slug, data.scope) })
        if (store.pendingScopeNotes(slug).length || store.pendingScopeTargets(slug).length) schedule(slug)
      }, delay(process.env.UNBLOCK_SCOPE_POLL_MS, 1000))
      entry.timer.unref()
      listeners.set(slug, entry)
    }
    entry.clients.add(res)
    res.write(`event: state\ndata: ${JSON.stringify({ ...state, notes: scopeNotes(slug), items: liveItems.list(slug), ...buildActuals(slug, state.scope) })}\n\n`)
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
        const shipNotes = notes.filter(note => note.event === 'ship' || note.event === 'publish')
        const comments = notes.filter(note => !['lane_note', 'ship', 'publish'].includes(note.event) && !APPROVAL_MODES.includes(note.event))
        const imagePaths = note => (note.images ?? []).map(path => ` [image: ${path}]`).join('')
        const parts = comments.map((note) => {
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
          if (note.event === 'delete') return `${alex} deleted his note ${note.thread} (§${heading} "${quote}"). No action needed.`
          if (note.event === 'reopen' && !text) return `${alex} reopened ${note.thread} (§${heading} "${quote}").`
          return `${alex}${note.event === 'reopen' ? ' reopened' : ' on'} ${note.thread} (§${heading} "${quote}"): ${text}`
        })
        const joined = parts.map((part, index) => part + imagePaths(comments[index])).join(' | ')
        let line = `[scoping ${slug}] ${joined} (reply: unblock scope reply ${slug} <T#> "<one line>")`
        if (`[scoping ${slug}] ${parts.join(' | ')} (reply: unblock scope reply ${slug} <T#> "<one line>")`.length > 700) line = `[scoping ${slug}] Alex sent ${comments.length} note(s), too long for one line. Read them: unblock scope notes ${slug} --since ${comments[0].id - 1}${comments.map(imagePaths).join('')}`
        let retry = approvalUnavailable, held = false
        async function send(key, targetPane, text, mark, options = {}) {
          const kind = options.kind ?? 'task'
          const wake = options.wake ?? 'auto'
          const ref = options.ref
          const supervised = process.env.UNBLOCK_SUPERVISED === '1'
          const lanePost = process.env.UNBLOCK_LANE_POST_BIN || (supervised && existsSync(join(homedir(), '.local', 'bin', 'lane-post')) ? join(homedir(), '.local', 'bin', 'lane-post') : null)
          const remote = remoteScopeHost(scope?.host)
          const useLanePost = remote || Boolean(lanePost)
          let status
          if (!useLanePost && !supervised) try { status = JSON.parse(await promptPane(['agent', 'get', targetPane])).result?.agent?.agent_status } catch { /* Missing herdr never holds a note. */ }
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
            if (useLanePost) {
              if (ref) {
                const posted = remote ? null : bulletinWithRef(ref, targetPane)
                if (posted) {
                  console.error(`unblock: lane-post skipped slug=${slug} pane=${targetPane} ref=${ref} bulletin=${posted.id} (already posted)`)
                  mark('delivered', { bulletin: posted.id, pane: targetPane })
                  job.holds.delete(key)
                  job.failures.delete(key)
                  return
                }
              }
              const args = ['post', '--to', targetPane, '--from', `scope:${slug}`, '--kind', kind, '--topic', `scope-${slug}`, '--wake', wake]
              if (ref) args.push('--ref', ref)
              args.push('--text', text)
              const bulletin = await new Promise((resolve, reject) => {
                const command = scopePostCommand(lanePost || 'lane-post', args, scope?.host)
                execFile(command.bin, command.args, { timeout: 20_000, encoding: 'utf8' }, (error, stdout, stderr) => {
                  const id = String(stdout ?? '').match(/\bb-\d{14}-[0-9a-f]{4}\b/)?.[0] ?? null
                  const exit = error ? typeof error.code === 'number' ? error.code : error.killed ? 'timeout' : 'error' : 0
                  const errText = String(stderr ?? '').replace(/\r\n|\r|\n/g, ' ').trim().slice(0, 80)
                  const noteText = String(text ?? '').replace(/\r\n|\r|\n/g, ' ').slice(0, 80)
                  console.error(`unblock: lane-post slug=${slug} pane=${targetPane} exit=${exit} bulletin=${id ?? '-'} stderr=${errText} text=${noteText}${ref ? ` ref=${ref}` : ''}`)
                  if (error) reject(error)
                  else resolve(id)
                })
              })
              mark('delivered', { bulletin, pane: targetPane })
            } else if (supervised) {
              throw new Error('lane-post missing')
            } else {
              await promptPane(['agent', 'prompt', targetPane, text])
              mark('delivered')
            }
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
        // An answered scope tells its lane about closes and parks without waking it: nothing there needs the lane.
        const quiet = answererOn(scope) && comments.every((note) => ['take', 'park', 'delete'].includes(note.event))
        if (comments.length) await send('own', pane, line, (status, extra) => {
          // A note already held is not re-marked on every pause tick, so the page isn't redrawn each time.
          const ids = comments.filter((note) => status !== 'held' || note.delivery !== 'held').map((note) => note.id)
          emitNotes(store.markScopeNotes(ids, status, status === 'delivered' ? new Date().toISOString() : null, status === 'delivered' ? extra ?? {} : {}))
        }, quiet ? { kind: 'info', wake: 'never' } : {})
        for (const note of laneNotes) {
          let line = `[scoping ${slug}] Note from Alex's voice call (not a comment): ${compact(note.text)}`
          if (line.length > 700) line = `${cutUnits(line, 699)}…`
          await send(`lane:${note.id}`, pane, line, (status, extra) => {
            if (status !== 'held' || note.delivery !== 'held') emitNotes(store.markScopeNotes([note.id], status, status === 'delivered' ? new Date().toISOString() : null, status === 'delivered' ? extra ?? {} : {}))
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
          const closedLine = count ? ` ${count} open comment${count === 1 ? '' : 's'} closed with your recommendation${count === 1 ? '' : 's'}.` : ''
          const noteLine = !text ? '' : text.length > 600
            ? ` Alex's note (long, in full at ${join(root, slug, 'APPROVAL.md')}): "${cutUnits(text, 300)}…"`
            : ` Alex's note: "${text}"`
          const late = typeof approval.recorded_at === 'string' && Date.parse(approval.recorded_at) - Date.parse(approval.at) > 15 * 60 * 1000
          const line = note.event === 'not_yet'
            ? `[scoping ${slug}] NOT YET from ${alex} (r${revision})${text.length > 600 ? `.${noteLine}` : `: "${text}"`} Keep scoping; answer it on the doc.`
            : note.event === 'approve_to_try'
              ? `[scoping ${slug}] APPROVED TO TRY by ${alex} (r${revision}, ${atEt}).${noteLine} Build it on the project branch, start a try copy, label the PR try-build and don't queue it: it ships only when Alex presses Ship it.${closedLine}`
            : `[scoping ${slug}] ${note.event === 'approve' ? 'APPROVED' : 'APPROVED WITH CHANGES'} by ${alex} (r${revision}, ${atEt}).${noteLine} ${note.event === 'approve' ? (late ? 'Recorded late by a PM relay; no action if you are already building.' : 'Move to build.') : 'Fold his note into the doc first (unblock scope patch), then move to build.'}${closedLine}`
          const ref = note.event === 'not_yet' ? `scope:${slug}:not_yet:n${note.id}` : `scope:${slug}:${note.event}:r${approval.revision}`
          await send(`approval:${note.id}`, pane, line, (status, extra) => {
            if (status !== 'held' || note.delivery !== 'held') emitNotes(store.markScopeNotes([note.id], status, status === 'delivered' ? new Date().toISOString() : null, status === 'delivered' ? extra ?? {} : {}))
          }, { kind: late ? 'info' : 'task', wake: late ? 'never' : 'auto', ref })
          if (held || retry) break
        }
        if (!held && !retry) for (const note of shipNotes) {
          await send(`approval:ship:${note.id}`, pane, note.text, (status, extra) => {
            if (status !== 'held' || note.delivery !== 'held') emitNotes(store.markScopeNotes([note.id], status, status === 'delivered' ? new Date().toISOString() : null, status === 'delivered' ? extra ?? {} : {}))
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
              lines.push(`[scoping ${slug}] ${alex} tagged you on ${target.thread} (§${heading} "${quoteSnippet(target.anchor.quote)}"): ${compact(target.words ?? target.text)}${/[.!?]$/.test(compact(target.words ?? target.text)) ? '' : '.'} Read it: unblock scope comments ${slug}`)
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

  // A comment write waits for its note's delivery to leave 'queued' before answering, so the relay's read-back
  // tells the truth. Capped: a slower lane-post still finishes in the background and marks the note then.
  function waitNotes(slug, ids) {
    const pending = ids.filter((id) => (store.scopeNote(id)?.delivery ?? 'queued') === 'queued')
    if (!pending.length) return Promise.resolve()
    return new Promise((resolve) => {
      let waits = noteWaits.get(slug)
      if (!waits) noteWaits.set(slug, (waits = new Map()))
      const settle = (delivery) => { if (delivery !== 'queued') done() }
      const timer = setTimeout(() => settle('timeout'), delay(process.env.UNBLOCK_SCOPE_DELIVER_WAIT_MS, 1500))
      timer.unref()
      for (const id of pending) {
        let set = waits.get(id)
        if (!set) waits.set(id, (set = new Set()))
        set.add(settle)
      }
      function done() {
        clearTimeout(timer)
        for (const id of pending) {
          const set = waits.get(id)
          if (set?.delete(settle) && !set.size) waits.delete(id)
        }
        if (!waits.size) noteWaits.delete(slug)
        resolve()
      }
    })
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

  // Estimate and actual rows for a doc with a build fence, read-only from the scoping chronicle's ESTIMATES.jsonl.
  function buildActuals(slug, scope) {
    if (!scope?.doc?.sections?.some((section) => buildFences(section.body_md).length)) return {}
    const file = process.env.UNBLOCK_ESTIMATES_FILE || join(root, 'factory-program', 'CONTEXT', 'ESTIMATES.jsonl')
    const rows = []
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line)
          if (row?.scope === slug && typeof row.piece === 'string') rows.push(Object.fromEntries(['piece', 'sub', 'p50_min', 'p90_min', 'actual_min', 'at'].filter((key) => row[key] !== undefined).map((key) => [key, row[key]])))
        } catch { /* A torn line is skipped. */ }
      }
    } catch { /* No estimates file yet. */ }
    return { estimates: rows }
  }

  async function handle(req, res, url) {
    const parts = url.pathname.slice('/api/scope/'.length).split('/')
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/scope/')
    const refused = (status, message) => {
      if (write && status >= 400 && status < 500 && req.method === 'POST' && parts.length === 4 && parts[1] === 'threads' && THREAD_ID.test(parts[2]) && parts[3] === 'reply' && !proxyIdentity(req) && !relayIdentity(req)) {
        const thread = readScope(parts[0])?.scope?.threads.find(t => t.id === parts[2])
        const to = thread?.messages.filter(m => m.from === 'alex').at(-1)?.at
        const item = liveItems.list(parts[0]).find(i => i.id === `${parts[2]}@${to}`)
        if (item && ['thinking', 'streaming'].includes(item.status)) liveItems.upsert(parts[0], { id: item.id, status: 'failed', error: String(message).slice(0, 200), doing: null })
      }
      if (write && status >= 400 && status < 500) console.error(`unblock: scope write refused slug=${parts[0]} comment=${parts[1] === 'threads' && THREAD_ID.test(parts[2]) ? parts[2] : '-'} verb=${parts[3] || parts[1] || '-'} status=${status} error=${String(message).replace(/[\r\n]/g, ' ')}`)
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
    if (req.method === 'POST' && parts.length === 2 && action === 'telemetry') return handleScopeTelemetry({ req, res, slug, proxyIdentity, sendJson })
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
    if (req.method === 'POST' && parts.length === 2 && action === 'stamps') {
      if (!relayIdentity(req)) return sendJson(res, 403, { error: 'relay only' })
      const body = await readJson(req)
      if (typeof body?.pushed_at !== 'string' || !Number.isFinite(Date.parse(body.pushed_at))) return sendJson(res, 400, { error: 'invalid pushed_at' })
      if (!Array.isArray(body.threads) || !body.threads.every(id => typeof id === 'string' && THREAD_ID.test(id))) return sendJson(res, 400, { error: 'invalid threads' })
      let stamped = 0
      for (const note of currentNewNotes(slug, body.threads)) {
        if (!note.stamps?.answered_at || note.stamps.pushed_at) continue
        emit(slug, 'note', store.mergeScopeNoteStamps(note.id, { pushed_at: body.pushed_at }))
        stamped++
      }
      return sendJson(res, 200, { stamped })
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
      emitNote(note)
      schedule(slug)
      return sendJson(res, 200, { note })
    }
    if (req.method === 'GET' && parts.length === 1) return sendJson(res, 200, { ...state, app: appOf(state.scope), notes: scopeNotes(slug), items: liveItems.list(slug), ...buildActuals(slug, state.scope) })
    if (req.method === 'GET' && parts.length === 3 && action === 'published' && /^[1-9]\d*$/.test(threadId)) {
      try { return sendJson(res, 200, JSON.parse(readFileSync(join(root, slug, 'published', `v${threadId}.json`), 'utf8'))) }
      catch { return sendJson(res, 404, { error: 'not found' }) }
    }
    if (req.method === 'GET' && parts.length === 2 && action === 'events') return watch(slug, req, res)
    if (req.method === 'GET' && parts.length === 2 && action === 'notes') {
      const raw = url.searchParams.get('since') ?? '0'
      const author = url.searchParams.get('from')
      if (!/^\d+$/.test(raw) || (author && !['alex', 'agent'].includes(author))) return sendJson(res, 400, { error: 'invalid notes filter' })
      return sendJson(res, 200, { notes: scopeNotes(slug, { since: Number(raw), author: author || undefined }) })
    }
    if (action === 'assets') {
      const dir = join(root, slug, 'assets')
      if (req.method === 'GET' && parts.length === 3) {
        const asset = readAsset(dir, threadId)
        return asset ? serveAsset(req, res, asset) : sendJson(res, 404, { error: 'no such asset' })
      }
      if (req.method === 'POST' && parts.length === 2) {
        const human = proxyIdentity(req) || relayIdentity(req)
        const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (human && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)) bad('images only: PNG, JPEG, WebP or GIF', 415)
        const bytes = await readAssetBody(req, human ? 8 * 1024 * 1024 : assetLimit(contentType))
        const previous = writes.get(slug) ?? Promise.resolve()
        const pending = previous.catch(() => {}).then(() => storeAsset(dir, bytes, contentType, { human: !!human }))
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
      if (!thread) bad('no such comment', 404)
      if (thread.status !== 'open' || !thread.recommendation) bad('only open comments with recommendations')
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
    if (req.method === 'POST' && parts.length === 2 && (action === 'pm-approve' || action === 'unapprove')) {
      if (proxyIdentity(req) || relayIdentity(req)) return sendJson(res, 403, { error: 'lanes relay approvals; Alex approves on the page' })
      const body = await readJson(req)
      const keys = action === 'pm-approve' ? ['by', 'quote', 'at', 'pane'] : ['reason', 'pane']
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !keys.includes(key))) return sendJson(res, 400, { error: 'invalid approval' })
      if (body.pane !== undefined && (typeof body.pane !== 'string' || !RELAY_PANE.test(body.pane))) return sendJson(res, 400, { error: 'invalid pane' })
      if (action === 'pm-approve') {
        if (body.by !== 'alex') return sendJson(res, 400, { error: 'invalid approval' })
        if (typeof body.quote !== 'string') return sendJson(res, 400, { error: 'invalid quote' })
        if (body.at !== undefined && typeof body.at !== 'string') return sendJson(res, 400, { error: 'invalid at' })
      } else if (typeof body.reason !== 'string') return sendJson(res, 400, { error: 'invalid reason' })
      const previous = writes.get(slug) ?? Promise.resolve()
      const pending = previous.catch(() => {}).then(() => action === 'pm-approve' ? relayApproval(slug, body) : unapproveScope(slug, body))
      writes.set(slug, pending)
      try {
        const result = await pending
        if (action === 'pm-approve') res.once('finish', () => { void moveApprovedTab(slug, result.revision, true) })
        return sendJson(res, 200, result)
      } finally { if (writes.get(slug) === pending) writes.delete(slug) }
    }
    if (req.method === 'POST' && parts.length === 4 && action === 'threads' && THREAD_ID.test(threadId) && ['typing', 'stream'].includes(verb)) {
      if (proxyIdentity(req) || relayIdentity(req)) return sendJson(res, 403, { error: 'lanes stream through the CLI' })
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) bad('invalid body')
      if (verb === 'typing') {
        if (body.doing !== undefined && (typeof body.doing !== 'string' || body.doing.trim().length > 120)) bad('invalid doing')
        if (body.link !== undefined) {
          if (typeof body.link !== 'string') bad('invalid link')
          body.link = body.link.trim()
          if (/[\x00-\x1f\x7f]/.test(body.link)) bad('invalid link')
          if (!body.link || body.link.length > 500) bad('invalid link')
          let url
          try { url = new URL(body.link) } catch { bad('invalid link') }
          if (!['http:', 'https:'].includes(url.protocol)) bad('invalid link')
        }
      } else if (typeof body.chunk !== 'string' || body.chunk.length > 4000) bad('invalid chunk')
      const configuredStaleMs = Number(process.env.UNBLOCK_LIVE_STALE_MS)
      const staleMs = Number.isSafeInteger(configuredStaleMs) && configuredStaleMs > 0 ? configuredStaleMs : 90000
      const by = await readerName(state.scope.pane)
      const previous = writes.get(slug) ?? Promise.resolve()
      const pending = previous.catch(() => {}).then(() => {
        const thread = readDisk(slug).scope.threads.find(t => t.id === threadId)
        if (!thread) bad('no such comment', 404)
        const to = [...thread.messages].reverse().find(m => m.from === 'alex')?.at
        if (!to) bad('no Alex message')
        const current = liveItems.list(slug).find(item => item.id === `${threadId}@${to}`)
        const patch = { thread: threadId, to, by }
        if (verb === 'stream' && (current?.text ?? '').length + body.chunk.length > MAX_TEXT) {
          const error = 'The reply is too long to stream (12000 characters max)'
          liveItems.upsert(slug, { ...patch, status: 'failed', error, doing: null })
          bad(error, 413)
        }
        const item = verb === 'typing'
          ? liveItems.upsert(slug, { ...patch, status: current && current.status !== 'seen' ? current.status : 'thinking', doing: body.doing !== undefined || body.link !== undefined ? { text: body.doing?.trim() ?? '', ...(body.link !== undefined ? { link: body.link } : {}) } : null })
          : liveItems.upsert(slug, { ...patch, status: 'streaming', text: (current?.text ?? '') + body.chunk, doing: null }, { staleMs })
        return { item }
      })
      writes.set(slug, pending)
      try { return sendJson(res, 200, await pending) }
      finally { if (writes.get(slug) === pending) writes.delete(slug) }
    }
    const appWrite = req.method === 'PUT' && parts.length === 2 && action === 'app'
    const answererWrite = req.method === 'PUT' && parts.length === 2 && action === 'answerer'
    const kpiWrite = req.method === 'PUT' && parts.length === 2 && action === 'kpis'
    const approvalWrite = req.method === 'POST' && parts.length === 2 && action === 'approve'
    const publishWrite = req.method === 'POST' && parts.length === 2 && action === 'publish'
    const destinationWrite = req.method === 'PUT' && parts.length === 2 && action === 'destination'
    const shipWrite = req.method === 'POST' && parts.length === 2 && action === 'ship'
    const sectionWrite = req.method === 'PUT' && parts.length === 3 && action === 'sections'
    const docWrite = sectionWrite || (req.method === 'PUT' && parts.length === 2 && action === 'doc')
    const newThread = req.method === 'POST' && parts.length === 2 && action === 'threads'
    const batchThread = req.method === 'POST' && parts.length === 3 && action === 'threads' && threadId === 'batch'
    const threadWrite = req.method === 'POST' && parts.length === 4 && action === 'threads' && THREAD_ID.test(threadId) && ['reply', 'resolve', 'reject', 'park', 'edit', 'react', 'reopen', 'unsay', 'delete'].includes(verb)
    if (!appWrite && !answererWrite && !kpiWrite && !approvalWrite && !publishWrite && !destinationWrite && !shipWrite && !docWrite && !newThread && !batchThread && !threadWrite) return sendJson(res, 404, { error: 'not found' })
    const relay = relayIdentity(req)
    const human = proxyIdentity(req) || relay
    if (batchThread && human) return sendJson(res, 403, { error: 'lanes ask through the CLI' })
    if (shipWrite) {
      if (!proxyIdentity(req) || relay) return sendJson(res, 403, { error: 'only Alex ships' })
      requireHumanPath(req)
    }
    if (approvalWrite && !relay) {
      if (!human) return sendJson(res, 403, { error: 'only Alex approves' })
      requireHumanPath(req)
    }
    if (publishWrite && human && !relay) requireHumanPath(req)
    if (destinationWrite && human) return sendJson(res, 403, { error: 'lanes set the destination through the CLI' })
    if ((docWrite || appWrite || answererWrite || kpiWrite) && human) {
      const error = new Error('lanes rewrite the doc through the CLI')
      error.code = 'HUMAN_ONLY'; error.status = 403; throw error
    }
    if (verb === 'edit' && human) {
      const error = new Error('lanes edit comments through the CLI')
      error.code = 'HUMAN_ONLY'; error.status = 403; throw error
    }
    if (verb === 'unsay' && human) return sendJson(res, 403, { error: 'lanes remove their own replies through the CLI' })
    if (verb === 'react' && human) return sendJson(res, 403, { error: 'lanes react through the CLI' })
    if (['reopen', 'delete'].includes(verb)) {
      if (!human && verb === 'delete') return sendJson(res, 403, { error: 'only Alex deletes' })
      if (human && !relay) requireHumanPath(req)
    }
    const body = await readJson(req)
    if (body?.images !== undefined && !human) return sendJson(res, 400, { error: 'invalid images' })
    if (['reject', 'park'].includes(verb) && !relay) requireHumanPath(req)
    if (appWrite && !APPS.includes(body?.app)) return sendJson(res, 400, { error: 'invalid app' })
    if (answererWrite && (!body || typeof body !== 'object' || Object.keys(body).some((key) => key !== 'model') || (body.model !== null && (typeof body.model !== 'string' || !MODEL_ALIAS.test(body.model))))) return sendJson(res, 400, { error: 'invalid answerer model' })
    if (kpiWrite) {
      const normalized = normalizeKpis(body?.kpis)
      if (normalized.error) return sendJson(res, 400, { error: normalized.error })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'invalid body' })
    if (verb === 'react' && body.emoji !== '👀' && body.emoji !== null) return sendJson(res, 400, { error: 'invalid emoji' })
    if (approvalWrite && (Object.keys(body).some((key) => !['mode', 'comment', 'client_id', 'via'].includes(key))
      || !APPROVAL_MODES.includes(body.mode) || (body.comment !== undefined && typeof body.comment !== 'string'))) return sendJson(res, 400, { error: 'invalid approval' })
    if (verb === 'unsay' && (Object.keys(body).some((key) => !['text'].includes(key)) || typeof body.text !== 'string' || !body.text.trim())) return sendJson(res, 400, { error: 'invalid unsay' })
    if (publishWrite && (Object.keys(body).some((key) => !['revision', 'where', 'target', 'client_id', 'via', 'close_open'].includes(key)) || !Number.isInteger(body.revision) || (body.close_open !== undefined && typeof body.close_open !== 'boolean'))) return sendJson(res, 400, { error: 'invalid publish' })
    if (destinationWrite && (Object.keys(body).some((key) => !['where', 'target'].includes(key)) || body.where === undefined)) return sendJson(res, 400, { error: 'invalid destination' })
    if (shipWrite && (Object.keys(body).some((key) => !['pr', 'head', 'build', 'client_id'].includes(key))
      || !Number.isSafeInteger(body.pr) || body.pr <= 0 || !Number.isSafeInteger(body.build) || body.build <= 0
      || typeof body.head !== 'string' || !/^[0-9a-f]{40}$/.test(body.head))) return sendJson(res, 400, { error: 'invalid ship' })
    if (sectionWrite && (Object.keys(body).some((key) => !['body_md', 'heading', 'keep', 'if_section_hash'].includes(key))
      || typeof body.body_md !== 'string' || (body.heading !== undefined && typeof body.heading !== 'string'))) return sendJson(res, 400, { error: 'invalid section patch' })
    if (body.via !== undefined && !(relay ? ['admin', 'voice'] : ['voice']).includes(body.via)) return sendJson(res, 400, { error: 'invalid via' })
    if ((relay || body.client_id !== undefined) && (typeof body.client_id !== 'string' || !CLIENT_ID.test(body.client_id))) return sendJson(res, 400, { error: 'invalid client_id' })
    if (body.keep !== undefined && (!Array.isArray(body.keep) || body.keep.length > 50 || !body.keep.every((term) => typeof term === 'string' && term.length <= 60))) return sendJson(res, 400, { error: 'invalid keep' })
    if (relay && body.via === undefined) body.via = 'admin'
    const stamps = newThread ? { daemon_received_at: new Date().toISOString() } : null
    if (stamps && relay) for (const key of ['rails_queued_at', 'relay_seen_at']) {
      if (typeof body[key] === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(body[key]) && Number.isFinite(Date.parse(body[key]))) stamps[key] = body[key]
    }
    const previous = writes.get(slug) ?? Promise.resolve()
    const wait = []
    const pending = previous.catch(() => {}).then(() => changeScope(slug, { body, human, stamps, appWrite, answererWrite, kpiWrite, approvalWrite, publishWrite, destinationWrite, shipWrite, docWrite, sectionWrite, newThread, batchThread, threadId, verb, wait }))
    writes.set(slug, pending)
    try {
      const result = await pending
      if (wait.length) await waitNotes(slug, wait)
      if (approvalWrite && !result.duplicate && approved(result.approval)) res.once('finish', () => { void moveApprovedTab(slug, result.revision) })
      return sendJson(res, result.error === 'unslop' ? 422 : ((newThread || batchThread) && !result.duplicate) ? 201 : 200, result)
    } catch (error) {
      if (error.code === 'SECTION_CHANGED') return sendJson(res, 409, { error: error.message, code: error.code })
      throw error
    } finally { if (writes.get(slug) === pending) writes.delete(slug) }
  }

  async function moveApprovedTab(slug, revision, onlyFromScoping = false) {
    await moveTabToInflight({ pane: readScope(slug)?.scope?.pane, revision, onlyFromScoping })
  }

  function approveScope(slug, scope, body, human) {
    if (!kindSpec(scope).approve) bad('this doc kind has no approval', 409)
    const comment = (body.comment ?? '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim()
    if (comment.length > 4000 || (!['approve', 'approve_to_try'].includes(body.mode) && !comment)) bad('invalid comment')
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
    emitNote(note)
    const entry = listeners.get(slug)
    if (entry) entry.meta = metadata(slug)
    emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
    schedule(slug)
    return { approval: scope.approval, closed, revision: scope.revision }
  }

  function publishScope(slug, scope, body, human) {
    if (!human && kindSpec(scope).approve) bad('a scope is agreed with approve, not published; push the doc with `unblock scope doc`', 409)
    const duplicate = body.client_id && scope.versions?.find((stamp) => stamp.client_id === body.client_id)
    if (duplicate) return { version: duplicate.version, duplicate: true }
    if (body.revision !== scope.revision) bad(`scope is at revision ${scope.revision}, not ${body.revision}`, 409)
    const open = (scope.threads ?? []).filter((thread) => thread.status === 'open').length
    if (!human && open && body.close_open !== true) bad(`${open} open comments; pass --close-open to close them on publish`, 409)
    const where = body.where ?? scope.destination?.where ?? 'published'
    const target = body.target ?? scope.destination?.target
    if (!DOC_WHERES.includes(where)) bad('invalid where')
    if (target !== undefined && (typeof target !== 'string' || target.length < 1 || target.length > 200)) bad('invalid target')
    const n = (scope.versions?.at(-1)?.version ?? 0) + 1
    const at = new Date().toISOString()
    const by = human ? 'alex' : 'agent'
    const closed = []
    for (const thread of scope.threads ?? []) {
      if (thread.status !== 'open') continue
      delete thread.reaction
      thread.status = 'resolved'
      thread.resolution = { decision: 'Closed when published', alex_words: null, by, at, confirmed_at: at, revision: scope.revision }
      closed.push(thread.id)
    }
    scope.versions = [...(scope.versions ?? []), { version: n, revision: scope.revision, at, by, where, ...(target !== undefined ? { target } : {}), ...(body.client_id !== undefined ? { client_id: body.client_id } : {}) }]
    scope.state = 'published'
    scope.updated_at = at
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    const dir = join(root, slug)
    const copy = { version: n, slug, kind: scope.kind ?? 'scope', title: scope.title, revision: scope.revision, sections: scope.doc.sections, assets: scope.doc.assets ?? {}, published_at: at, by, where, ...(target !== undefined ? { target } : {}) }
    mkdirSync(join(dir, 'published'), { recursive: true })
    try { writeFileSync(join(dir, 'published', `v${n}.json`), JSON.stringify(copy, null, 2), { flag: 'wx' }) }
    catch (error) { if (error.code === 'EEXIST') bad('version exists', 409); throw error }
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    if (human) {
      const note = store.addScopeNote({ slug, author: 'alex', kind: 'thought', event: 'publish', text: `Published v${n}${target ? ` to ${target}` : ''}`, who: human.login, via: body.via })
      emitNote(note)
    }
    const entry = listeners.get(slug)
    if (entry) entry.meta = metadata(slug)
    emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
    if (human) schedule(slug)
    return { version: n, revision: scope.revision, closed }
  }

  function setDestination(slug, scope, body) {
    const target = body.target
    if (!DOC_WHERES.includes(body.where)) bad('invalid where')
    if (target !== undefined && (typeof target !== 'string' || target.length < 1 || target.length > 200)) bad('invalid target')
    scope.destination = { where: body.where, ...(target !== undefined ? { target } : {}) }
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    const dir = join(root, slug)
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    const entry = listeners.get(slug)
    if (entry) entry.meta = metadata(slug)
    emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
    return { destination: scope.destination }
  }

  function readDisk(slug) {
    const dir = join(root, slug)
    let disk
    try { disk = JSON.parse(readFileSync(join(dir, 'scope.json'), 'utf8')) } catch { bad('scope.json is being rewritten') }
    return { dir, scope: disk.version === 2 ? disk : migrateV1(disk, disk.updated_at) }
  }

  function relayApproval(slug, body) {
    const { dir, scope } = readDisk(slug)
    if (!kindSpec(scope).approve) bad('this doc kind has no approval', 409)
    const quote = body.quote.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim()
    if (!quote || quote.length > 4000) bad('invalid quote')
    const now = Date.now()
    let atMs = now
    if (body.at !== undefined) {
      atMs = Date.parse(body.at)
      if (!Number.isFinite(atMs) || atMs > now + 5 * 60 * 1000 || atMs < now - 30 * 24 * 60 * 60 * 1000) bad('invalid at')
    }
    if (approved(scope.approval)) bad('already approved', 409)
    const at = new Date(atMs).toISOString(), recorded_at = new Date(now).toISOString(), at_et = eastern(at)
    const who = `pm-relay${body.pane ? `:${body.pane}` : ''}`
    const open = scope.threads.filter((thread) => thread.status === 'open').length
    scope.approval = { mode: 'approve', by: 'alex', who, at, at_et, revision: scope.revision, comment: quote, quote, via: 'pm-relay', open, recorded_at }
    scope.updated_at = recorded_at
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    writeFileSync(join(dir, 'APPROVAL.md'), `# Scope approval\n\nMode: approve\nWhen: ${at_et}\nRevision: ${scope.revision}\nWho: ${who}\nVia: pm-relay\nOpen comments: ${open} open\n\n${quote}\n`)
    appendApprovalIndex(root, { slug, revision: scope.revision, mode: 'approve', comment: quote, at_et })
    try {
      const note = store.addScopeNote({ slug, author: 'alex', kind: 'thought', event: 'approve', text: quote, who, via: 'pm-relay' })
      emitNote(note)
      const entry = listeners.get(slug)
      if (entry) entry.meta = metadata(slug)
      emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
    } catch { /* The approval is already on disk. */ }
    schedule(slug)
    return { approval: scope.approval, revision: scope.revision }
  }

  function unapproveScope(slug, body) {
    const { dir, scope } = readDisk(slug)
    const reason = body.reason.trim()
    if (!reason || reason.length > 1000) bad('invalid reason')
    if (!approved(scope.approval)) bad('not approved', 409)
    const was = scope.approval
    const now = new Date().toISOString(), at_et = eastern(now)
    const who = `pm-relay${body.pane ? `:${body.pane}` : ''}`
    delete scope.approval
    scope.updated_at = now
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    writeFileSync(join(dir, 'APPROVAL.md'), `# Scope approval\n\nUnapproved: ${at_et}\nRevision: ${scope.revision}\nWho: ${who}\nWas: ${was.at_et} via ${was.via || 'page'}\n\nReason: ${reason}\n`)
    appendApprovalIndex(root, { slug, revision: scope.revision, mode: 'unapproved', comment: reason, at_et })
    try {
      const entry = listeners.get(slug)
      if (entry) entry.meta = metadata(slug)
      emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
    } catch { /* The unapproval is already on disk. */ }
    return { revision: scope.revision }
  }

  function shipScope(slug, scope, body, human) {
    if (scope.approval?.mode !== 'approve_to_try') bad('scope is not approved to try', 409)
    const duplicate = body.client_id && scope.ships?.find((ship) => ship.client_id === body.client_id)
    if (duplicate) return { ok: true, ship: duplicate, duplicate: true }
    const at = new Date().toISOString(), at_et = eastern(at)
    const ship = { pr: body.pr, head: body.head, build: body.build, by: 'alex', who: human.login, at, at_et,
      ...(body.client_id !== undefined ? { client_id: body.client_id } : {}) }
    scope.ships = [...(scope.ships ?? []), ship]
    scope.updated_at = at
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    const dir = join(root, slug)
    writeFileSync(join(dir, `SHIP-${ship.pr}.md`), `# Scope ship approval\n\nPR: ${ship.pr}\nHead: ${ship.head}\nBuild: ${ship.build}\nWhen: ${at_et}\nWho: ${human.login}\nVia: page\n`)
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    const text = `[${slug}] SHIP IT from Alex (${at_et}): build ${ship.build}, PR #${ship.pr} at ${ship.head.slice(0, 7)}. Record it with python3 scripts/queue_pr.py ship ${ship.pr} --by aneym --via button --head ${ship.head} --evidence "unblock scope ${slug} SHIP-${ship.pr}.md", then queue it.`
    const note = store.addScopeNote({ slug, author: 'alex', kind: 'thought', event: 'ship', text, who: human.login })
    emitNote(note)
    const entry = listeners.get(slug)
    if (entry) entry.meta = metadata(slug)
    emit(slug, 'scope', { ...readScope(slug), notes: store.scopeNotes(slug) })
    schedule(slug)
    return { ok: true, ship }
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

  function scopeNotes(slug, filter) { return store.scopeNotes(slug, filter).map(note => ({ ...note, author: note.from })) }

  function answererOn(scope) {
    if (scope.answerer === 'on') return true
    if (scope.answerer === 'off') return false
    return kindSpec(scope).answerer
  }

  function writeAnswer(slug, patch) {
    const previous = writes.get(slug) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => applyAnswer(slug, patch))
    writes.set(slug, pending)
    return pending.finally(() => { if (writes.get(slug) === pending) writes.delete(slug) })
  }

  function applyAnswer(slug, patch) {
    if (closed) return
    const dir = join(root, slug)
    let scope
    try { scope = JSON.parse(readFileSync(join(dir, 'scope.json'), 'utf8')) } catch { return }
    if (!scope || scope.version !== 2) return
    const thread = (scope.threads ?? []).find((item) => item.id === patch.threadId)
    const message = thread?.messages?.find((item) => item.answerer && item.pending && item.at === patch.at)
    if (!message) return
    let text = typeof patch.text === 'string' ? patch.text : ''
    if (text.length > 4000) {
      const unit = text.charCodeAt(3998)
      text = `${text.slice(0, unit >= 0xd800 && unit <= 0xdbff ? 3998 : 3999)}…`
    }
    message.text = text
    if (patch.pending) message.pending = true
    else {
      delete message.pending
      if (patch.needs_owner) message.needs_owner = true
      if (patch.handoff) message.handoff = true
    }
    scope.updated_at = new Date().toISOString()
    const problems = validateScope(scope)
    if (problems.length) { console.error(`unblock: explainer answer rejected slug=${slug} ${problems[0]}`); return }
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    if (!patch.pending && !patch.handoff && text.trim()) stampThread(slug, thread.id, { answered_at: scope.updated_at })
    const entry = listeners.get(slug)
    if (entry) entry.meta = metadata(slug)
    emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
  }

  function recoverAnswerer() {
    let dirs
    try { dirs = readdirSync(root, { withFileTypes: true }) } catch { return }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !SLUG.test(dir.name)) continue
      const path = join(root, dir.name, 'scope.json')
      let scope
      try { scope = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
      if (!scope || scope.version !== 2 || !Array.isArray(scope.threads)) continue
      let changed = false
      const jobs = []
      for (const thread of scope.threads) {
        const last = thread.messages?.at(-1)
        for (const message of thread.messages ?? []) {
          if (message?.answerer !== true || (!message.pending && message.text !== 'Interrupted: ask again')) continue
          // Only the comment's last message is re-asked: anything after it means Alex already moved on.
          const retry = answererOn(scope) && !message.restart_retried && message === last
          if (!retry && !message.pending) continue
          delete message.handoff
          delete message.needs_owner
          if (retry) {
            // Persist the retry before enqueueing so another restart cannot repeat it.
            message.restart_retried = true
            message.pending = true
            message.text = 'Answering…'
            jobs.push({ slug: dir.name, threadId: thread.id, messageAt: message.at, scopeDir: join(root, dir.name) })
          } else {
            message.text = 'Interrupted: ask again'
            delete message.pending
          }
          changed = true
        }
      }
      if (!changed) continue
      scope.updated_at = new Date().toISOString()
      writeFileSync(join(root, dir.name, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
      renameSync(join(root, dir.name, 'scope.json.tmp'), path)
      cache.delete(dir.name)
      for (const job of jobs) answerer.enqueue(job)
    }
  }

  function bad(message, status = 400) { const error = new Error(message); error.status = status; throw error }

  function changeScope(slug, { body, human, stamps, appWrite, answererWrite, kpiWrite, approvalWrite, publishWrite, destinationWrite, shipWrite, docWrite, sectionWrite, newThread, batchThread, threadId, verb, wait }) {
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
      emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
      return { app: scope.app }
    }
    if (answererWrite) {
      if (kindOf(scope) === 'scope') bad('only an explainer takes an answerer model')
      if (body.model === null) delete scope.answerer_model
      else scope.answerer_model = body.model
      const problems = validateScope(scope)
      if (problems.length) bad(problems[0])
      writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
      renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
      const entry = listeners.get(slug)
      if (entry) entry.meta = metadata(slug)
      emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
      return { answerer_model: scope.answerer_model ?? null }
    }
    if (kpiWrite) {
      const normalized = normalizeKpis(body.kpis)
      if (normalized.error) bad(normalized.error)
      scope.kpis = normalized.kpis
      const problems = validateScope(scope)
      if (problems.length) bad(problems[0])
      writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
      renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
      const entry = listeners.get(slug)
      if (entry) entry.meta = metadata(slug)
      emit(slug, 'scope', { ...readScope(slug), notes: scopeNotes(slug) })
      return { kpis: scope.kpis, revision: scope.revision }
    }
    if (approvalWrite) return approveScope(slug, scope, body, human)
    if (publishWrite) return publishScope(slug, scope, body, human)
    if (destinationWrite) return setDestination(slug, scope, body)
    if (shipWrite) return shipScope(slug, scope, body, human)
    const storedSections = scope.doc.sections
    if (sectionWrite) {
      const stored = storedSections.find((section) => section.id === threadId)
      if (!stored) bad('no such section', 404)
      if (body.if_section_hash !== undefined) {
        if (typeof body.if_section_hash !== 'string' || !/^[0-9a-f]{16}$/.test(body.if_section_hash)) bad('invalid if_section_hash')
        // changeScope is synchronous, so this check and the write below are atomic per slug.
        if (body.if_section_hash !== sectionHash(stored)) { const error = new Error('section changed'); error.code = 'SECTION_CHANGED'; error.status = 409; throw error }
      }
      body = { sections: storedSections.map((section) => section.id === threadId
        ? { ...section, body_md: body.body_md, ...(body.heading !== undefined ? { heading: body.heading } : {}) }
        : section), ...(body.keep !== undefined ? { keep: body.keep } : {}) }
    }
    let images = []
    if (body.images !== undefined) {
      if (!human || (!newThread && !['reply', 'reject', 'resolve'].includes(verb)) || !Array.isArray(body.images) || body.images.length > 6) bad('invalid images')
      images = body.images.map(id => {
        if (typeof id !== 'string' || !ASSET_ID.test(id) || !/\.(png|jpg|webp|gif)$/.test(id)) bad('invalid images')
        const asset = readAsset(join(dir, 'assets'), id)
        if (asset?.metadata.type !== 'image') bad('invalid images')
        return { id, width: asset.metadata.width, height: asset.metadata.height }
      })
    }
    if (body.client_id !== undefined) {
      const note = store.scopeNoteByClientId(slug, body.client_id)
      if (note && ['reopen', 'delete'].includes(note.event)) {
        const existing = scope.threads.find(t => t.id === note.thread)
        return { ...(existing ? { thread: existing } : { deleted: note.thread }), duplicate: true }
      }
      const duplicate = scope.threads.find((thread) => thread.messages.some((message) => message.client_id === body.client_id)
        || thread.resolution?.client_id === body.client_id || thread.parked_client_id === body.client_id)
      if (duplicate) return { thread: duplicate, duplicate: true }
    }
    const pictures = images.length ? { images } : {}
    const client = body.client_id === undefined ? {} : { client_id: body.client_id }
    const via = body.via === undefined ? {} : { via: body.via }
    const at = new Date().toISOString()
    const text = (value, limit = human ? 4000 : 600, preserve = false) => {
      const sanitized = typeof value === 'string' ? human ? value.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '') : compact(value) : ''
      const cleaned = preserve ? sanitized : sanitized.trim()
      if (cleaned.length > limit) bad(`your answer is too long (${cleaned.length} of ${limit} characters)`)
      if (!cleaned.trim() && !(images.length && (newThread || verb === 'reply'))) bad('invalid text')
      return cleaned
    }
    const setOptions = (thread, source = body) => {
      if (thread.kind !== 'question') bad('only questions have options')
      let options = source.options
      if (!Array.isArray(options) || !options.every((option) => typeof option === 'string' && option.length >= 1 && option.length <= 200)) bad('invalid options')
      const fresh = source !== body || newThread || batchThread || body.recommendation !== undefined
      if (fresh && options.length && thread.recommendation) options = [thread.recommendation, ...options.filter((option) => option !== thread.recommendation)]
      if (options.length !== 0 && (options.length < 2 || options.length > 5 || options.some((option) => option.length > 200))) bad('invalid options')
      if (!fresh && options.length && (!thread.recommendation || options[0] !== thread.recommendation)) bad('options[0] must equal the recommendation')
      if (options.length) thread.options = options
      else delete thread.options
    }
    const addAgentQuestion = (source) => {
      const section = scope.doc.sections.find((s) => s.id === source.section)
      const anchor = section && typeof source.quote === 'string' ? anchorInSection(section, source.quote) : null
      if (!anchor) bad(`quote not found in §${source.section}`)
      const kind = source.kind ?? 'question'
      if (!['question', 'comment'].includes(kind) || (kind === 'comment' && (source.recommendation !== undefined || source.why !== undefined))) bad('invalid kind')
      const thread = { id: nextThreadId(scope), anchor, author: 'agent', intent: 'ask', kind, status: 'open', messages: [{ from: 'agent', text: text(source.text), at, ...via, ...client, ...pictures }], created_at: at }
      if (source.recommendation !== undefined) thread.recommendation = text(source.recommendation, 600)
      if (source.why !== undefined) thread.why = text(source.why, 600)
      if (source.options !== undefined) {
        if (!thread.recommendation) bad('options require an agent recommendation')
        setOptions(thread, source)
      }
      scope.threads.push(thread)
      return thread
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
      const buildError = buildDocError(sections)
      if (buildError) bad(buildError)
      scope.revision++
      if (scope.state === 'published') scope.state = 'draft'
      result = { revision: scope.revision }
    } else if (newThread) {
      if (human) {
        // Alex's words are never refused for where they point: a lane can rewrite the text he selected while he types.
        // His comment then lands detached, as a later doc write would leave it, and the lane still gets his quote.
        const anchor = normalizeAnchor(body.anchor)
        if (!anchor || !SECTION_ID.test(anchor.section)) bad('invalid anchor')
        const section = scope.doc.sections.find((s) => s.id === anchor.section)
        // A stored embed always names a demo fence in its section; with the fence gone the quote stays on the section.
        if (anchor.embed && !(section && hasEmbedFence(section, anchor.embed.src))) delete anchor.embed
        if (body.recommendation !== undefined || body.why !== undefined) bad('invalid kind')
        thread = { id: nextThreadId(scope), anchor, author: 'alex', intent: text(body.text).includes('?') ? 'question' : 'change', kind: 'comment', status: 'open', messages: [{ from: 'alex', text: text(body.text), at, ...via, ...client, ...pictures }], created_at: at }
        if (body.options !== undefined) bad('options require an agent recommendation')
        scope.threads.push(thread)
        noteData = { event: 'new', text: thread.messages[0].text }
      } else thread = addAgentQuestion(body)
      result = { thread }
    } else if (batchThread) {
      if (!Array.isArray(body.questions) || body.questions.length < 1 || body.questions.length > 20) bad('invalid questions')
      const threads = []
      for (let i = 0; i < body.questions.length; i++) {
        const question = body.questions[i]
        try {
          if (!question || typeof question !== 'object' || Array.isArray(question)) bad('invalid question')
          threads.push(addAgentQuestion({ ...question, kind: 'question' }))
        } catch (error) {
          error.message = `question ${i + 1}: ${error.message}`
          throw error
        }
      }
      result = { threads }
    } else {
      thread = scope.threads.find((t) => t.id === threadId)
      if (!thread) bad('no such comment', 404)
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
        const message = { from: human ? 'alex' : 'agent', text: text(body.text), at, ...via, ...client, ...pictures }
        if (!human && body.recommendation !== undefined) {
          if (thread.kind !== 'question' && thread.status !== 'open') bad('only open comments have recommendations')
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
        if (thread.status !== 'open' || !thread.recommendation) bad('only open comments with recommendations can be rejected')
        const reason = body.text == null || (typeof body.text === 'string' && !body.text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '').trim()) ? '' : text(body.text)
        thread.rejected_at = at
        thread.messages.push({ from: 'alex', kind: 'reject', text: reason, at, ...via, ...client, ...pictures })
        noteData = { event: 'reject', text: reason }
      } else if (verb === 'unsay') {
        const messages = thread.messages.filter((message, index) => index === 0 || message.from !== 'agent' || message.text !== body.text)
        const removed = thread.messages.length - messages.length
        if (!removed) bad('no matching agent reply', 404)
        thread.messages = messages
        result = { removed }
      } else if (verb === 'reopen') {
        if (!['resolved', 'parked'].includes(thread.status)) bad('only resolved or parked comments reopen')
        thread.status = 'open'; delete thread.resolution; delete thread.parked_at
        // Alex, 2026-10-02: lanes resolve and reopen comments themselves; his reopen is still a note to the lane.
        if (human) noteData = { event: 'reopen', text: '' }
        else if (typeof body.text === 'string' && body.text.trim()) thread.messages.push({ from: 'agent', text: text(body.text, 600), at, ...client })
      } else if (verb === 'delete') {
        if ((thread.author ?? thread.messages[0]?.from) !== 'alex') bad('only his own notes', 403)
        scope.threads = scope.threads.filter(t => t.id !== thread.id)
        noteData = { event: 'delete', text: '' }
      } else if (verb === 'park') {
        if (thread.status !== 'open') bad('only open comments can be parked')
        thread.status = 'parked'; thread.parked_at = at
        if (body.client_id !== undefined) thread.parked_client_id = body.client_id
        noteData = { event: 'park', text: '' }
      } else if (human) {
        const how = body.how ?? 'resolve'
        if (!['take', 'own', 'resolve'].includes(how)) bad('invalid how')
        const decision = text(body.decision, 4000, true)
        const words = body.alex_words == null ? decision : text(body.alex_words, 4000, true)
        if (how === 'own' && words.includes('?')) {
          // His own answer is a question (open-factory T7): it stays open as a reply, never a decision.
          thread.messages.push({ from: 'alex', text: words, at, ...via, ...client, ...pictures })
          noteData = { event: 'reply', text: words }
          thread.status = 'open'; delete thread.resolution; delete thread.parked_at
          result = { kept_open: true }
        } else {
          thread.status = 'resolved'
          // On an answered scope the doc already states the recommendation, so taking it needs no lane edit.
          const autoConfirm = how === 'take' && answererOn(scope)
          thread.resolution = { decision, alex_words: words, by: 'alex', how, at, confirmed_at: autoConfirm ? at : null, revision: autoConfirm ? scope.revision : null, ...client, ...pictures }
          noteData = { event: how, text: decision, words: body.alex_words == null ? null : words }
        }
      } else if (thread.status === 'open') {
        let evidence = {}
        if ((thread.author ?? thread.messages[0]?.from) === 'alex') {
          if (typeof body.decision !== 'string' || !body.decision.trim()) bad(`say why it is settled: unblock scope resolve ${slug} ${thread.id} --decision "why"`)
          const refuse = (reason) => {
            try { bad(`${thread.id}: ${reason}. Alex resolves his own comments (his Resolve button). A lane closes one only with his close words from his latest message there (--quote "<his exact words>") or, for a change he asked for, the doc revision that made it (--revision N).`, 403) }
            catch (error) { error.code = 'ALEX_RESOLVES'; throw error }
          }
          const messages = thread.messages.filter(message => message.from === 'alex'), latest = messages.at(-1)
          if ((body.quote !== undefined) === (body.revision !== undefined)) refuse('pass exactly one of his close words or a revision')
          if (body.quote !== undefined) {
            if (typeof body.quote !== 'string') refuse('quote must be his words')
            const normalize = value => value.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
            const quote = normalize(body.quote), words = normalize(latest?.text ?? '')
            if (!quote || !words.includes(quote)) refuse(quote && messages.some(message => normalize(message.text).includes(quote)) ? 'only his latest message counts' : `not his words in ${thread.id}`)
            if (!/\b(?:ok|okay|close|closed|resolve|resolved|approve|approved|take it|lgtm|sounds good|ship it)\b/.test(quote) || /\b(?:not|don't|dont|no|never)\b/.test(quote)) refuse('his words must say close, approve, take it or ok')
            // Map the normalized match back to the exact substring he wrote.
            const original = latest.text, offset = words.indexOf(quote)
            let start = 0, end = original.length
            for (let i = 0; i <= original.length; i++) {
              const length = normalize(original.slice(0, i)).length
              if (length <= offset) start = i
              if (length === offset + quote.length) { end = i; break }
            }
            evidence = { quote: original.slice(start, end).trim() }
          } else {
            const intent = thread.intent ?? (thread.messages[0]?.text.includes('?') ? 'question' : 'change')
            if (intent !== 'change') refuse('a question closes with his words or his own Resolve')
            const n = body.revision
            if (!Number.isInteger(n) || n < 2 || n > scope.revision) refuse(`invalid revision ${n}`)
            let before, after
            try { before = JSON.parse(readFileSync(join(dir, 'revisions', `${n - 1}.json`))); after = JSON.parse(readFileSync(join(dir, 'revisions', `${n}.json`))) }
            catch { refuse(`revision ${n} snapshots are missing or invalid`) }
            if (!(Date.parse(after.at) > Date.parse(latest?.at))) refuse(`revision ${n} was made before he asked`)
            const ids = thread.anchor.general ? new Set([...before.sections, ...after.sections].map(section => section.id)) : [thread.anchor.section]
            const changed = [...ids].some(id => {
              const old = before.sections.find(section => section.id === id), next = after.sections.find(section => section.id === id)
              return !!old !== !!next || old?.heading !== next?.heading || old?.body_md !== next?.body_md
            })
            if (!changed) refuse(`revision ${n} did not change §${headingOf(scope, thread.anchor.section)}`)
            evidence = { revision: n }
          }
          if (thread.messages.at(-1)?.from !== 'agent') thread.messages.push({ from: 'agent', text: text(body.decision, 600), at, ...client })
        }
        thread.status = 'resolved'
        thread.resolution = { decision: text(body.decision, 600), alex_words: null, by: 'agent', at, confirmed_at: at, revision: scope.revision, ...client, ...evidence }
      } else if (thread.resolution?.by === 'alex' && !thread.resolution.confirmed_at) {
        if (thread.resolution.how === 'own' && thread.resolution.alex_words?.includes('?')) bad(`Alex's answer is a question; reopen it and answer: unblock scope reopen ${slug} ${thread.id}`)
        thread.resolution.confirmed_at = at; thread.resolution.revision = scope.revision
      }
      result = verb === 'delete' ? { deleted: thread.id } : { ...result, thread }
    }
    let answerJob = null
    if (human && noteData && (newThread || verb === 'reply') && answererOn(scope)) {
      thread.messages.push({ from: 'agent', answerer: true, pending: true, text: 'Answering…', at })
      answerJob = { slug, threadId: thread.id, messageAt: at, scopeDir: dir }
    }
    const problems = validateScope(scope)
    if (problems.length) bad(problems[0])
    if (!human && !['react', 'unsay'].includes(verb)) {
      const { keep = [] } = body
      const changed = docWrite ? body.sections.filter((section) => {
        const stored = storedSections.find((old) => old.id === section.id)
        return !stored || stored.heading !== section.heading || stored.body_md !== section.body_md
      }) : []
      const lint = docWrite ? lintDoc(changed, { keep }) : { findings: [], warnings: [] }
      const lintSource = (source, name) => {
        for (const field of ['text', 'recommendation', 'why', 'decision']) {
          if (typeof source[field] === 'string') lint.findings.push(...lintText(source[field], { keep }).map((finding) => ({ field: name ? `${name}.${field}` : field, ...finding })))
        }
        for (const [index, option] of (Array.isArray(source.options) ? source.options : []).entries()) {
          if (typeof option === 'string') lint.findings.push(...lintText(option, { keep }).map((finding) => ({ field: `${name ? `${name}.` : ''}options[${index}]`, ...finding })))
        }
      }
      if (batchThread) body.questions.forEach((question, index) => lintSource(question, `questions[${index}]`))
      else if (!docWrite) lintSource(body, '')
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
        return !section || (t.anchor.embed ? !hasEmbedFence(section, t.anchor.embed.src) : !locateAnchor(sectionPlain(section), t.anchor))
      }).map((t) => t.id)
    }
    writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
    renameSync(join(dir, 'scope.json.tmp'), join(dir, 'scope.json'))
    if (!human && verb === 'reply') {
      stampThread(slug, thread.id, { answered_at: at })
      const to = [...thread.messages].reverse().find(message => message.from === 'alex')?.at
      // Never wait on herdr here: the turn's item already names the lane; a reply with no item uses the cached name or the pane.
      if (to) {
        const existing = liveItems.list(slug).find((item) => item.id === `${thread.id}@${to}`)
        liveItems.upsert(slug, { thread: thread.id, to, ...(existing ? {} : { by: paneNames.get(scope.pane)?.name ?? scope.pane }), status: 'done', doing: null, text: thread.messages.at(-1).text })
      }
    }
    if (noteData) {
      let note = store.addScopeNote({ slug, author: 'alex', kind: ['resolve', 'take', 'own'].includes(noteData.event) ? 'answer' : 'thought', who: human.login, thread: thread.id, anchor: thread.anchor, via: body.via ?? null, targets: tagTargets(scope, noteData.words ?? noteData.text), images: images.map(image => join(root, slug, 'assets', image.id)), ...client, ...noteData })
      if (noteData.event === 'new') note = store.mergeScopeNoteStamps(note.id, stamps) ?? note
      if (answerJob) {
        const [marked] = store.markScopeNotes([note.id], 'answerer', new Date().toISOString())
        emitNote(marked ?? note)
      } else emitNote(note)
      if (wait && (newThread || verb === 'reply')) wait.push(note.id)
    }
    const state = readScope(slug)
    const entry = listeners.get(slug)
    if (entry) entry.meta = metadata(slug)
    emit(slug, 'scope', { ...state, notes: scopeNotes(slug) })
    if (answerJob) answerer.enqueue(answerJob)
    else if (noteData) schedule(slug)
    return result
  }

  async function readerName(pane) {
    const cached = paneNames.get(pane)
    if (cached && cached.until > Date.now()) return cached.name
    let name = ''
    try {
      const agent = JSON.parse(await promptPane(['agent', 'get', pane]))?.result?.agent
      name = typeof agent?.name === 'string' ? agent.name.trim() : ''
      if (!name && agent?.tab_id) {
        const tab = JSON.parse(await promptPane(['tab', 'get', agent.tab_id]))?.result?.tab
        name = typeof tab?.label === 'string' ? tab.label.trim() : ''
      }
    } catch { name = '' }
    if (!name) name = pane
    paneNames.set(pane, { name, until: Date.now() + 60_000 })
    return name
  }

  function takeBulletinLine(line) {
    if (!line) return
    let row
    try { row = JSON.parse(line) } catch { return }
    if (!row || typeof row.id !== 'string' || !row.id.startsWith('b-') || typeof row.pane !== 'string' || typeof row.ts !== 'string') return
    const key = `${row.id}\0${row.pane}`
    if (bulletinReads.has(key)) return
    if (bulletinReads.size >= 20_000) bulletinReads.delete(bulletinReads.keys().next().value)
    bulletinReads.set(key, row.ts)
  }

  function ingestBulletin(chunk) {
    const data = bulletinTail.length ? Buffer.concat([bulletinTail, chunk]) : chunk
    const end = data.lastIndexOf(10)
    if (end < 0) {
      bulletinTail = data
      return
    }
    const text = data.subarray(0, end).toString('utf8')
    bulletinTail = data.subarray(end + 1)
    for (const line of text.split('\n')) takeBulletinLine(line)
  }

  function bulletinWithRef(ref, pane) {
    const file = join(process.env.LANE_BULLETIN_HOME || join(homedir(), '.agent-rails', 'lanes'), 'bulletin.jsonl')
    let text
    try { text = readFileSync(file, 'utf8') } catch { return null }
    for (const line of text.split('\n')) {
      if (!line) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (!row || row.ref !== ref || typeof row.id !== 'string') continue
      const to = row.to
      if (to === pane || (Array.isArray(to) && to.includes(pane))) return row
    }
    return null
  }

  async function scanBulletinReads() {
    if (closed || scanningReads) return
    scanningReads = true
    try {
      const scanAt = new Date().toISOString()
      const pending = store.unreadBulletinNotes()
      if (!pending.length) return
      const file = join(process.env.LANE_BULLETIN_HOME || join(homedir(), '.agent-rails', 'lanes'), 'bulletin-delivered.jsonl')
      let size
      try { size = statSync(file).size } catch { return }
      if (size === bulletinSize && !pending.some((note) => (note.delivered_at ?? '') > bulletinScanAt)) return
      if (size < bulletinOffset) {
        bulletinOffset = 0
        bulletinTail = Buffer.alloc(0)
        bulletinReads.clear()
      }
      if (size > bulletinOffset) {
        const length = size - bulletinOffset
        const buf = Buffer.alloc(length)
        const fd = openSync(file, 'r')
        let got = 0
        try {
          while (got < length) {
            const n = readSync(fd, buf, got, length - got, bulletinOffset + got)
            if (n === 0) break
            got += n
          }
        } finally { closeSync(fd) }
        ingestBulletin(buf.subarray(0, got))
        bulletinOffset += got
        if (got < length) size = bulletinOffset
      }
      bulletinSize = size
      bulletinScanAt = scanAt
      const hits = []
      for (const note of pending) {
        const ts = bulletinReads.get(`${note.bulletin}\0${note.bulletin_pane}`)
        if (ts) hits.push({ note, row: { pane: note.bulletin_pane, ts } })
      }
      if (!hits.length || closed) return
      const names = new Map()
      for (const pane of new Set(hits.map((hit) => hit.row.pane))) names.set(pane, await readerName(pane))
      if (closed) return
      const notes = []
      const slugs = new Set()
      for (const { note, row } of hits) {
        notes.push(...store.markScopeNotesRead([note.id], row.ts, names.get(row.pane)))
        slugs.add(note.slug)
      }
      if (notes.length) emitNotes(notes)
      for (const slug of slugs) {
        const data = readScope(slug)
        if (data) emit(slug, 'scope', { ...data, notes: scopeNotes(slug), ...buildActuals(slug, data.scope) })
      }
    } catch (error) {
      console.error(`unblock: bulletin read scan failed: ${error.message}`)
    } finally { scanningReads = false }
  }

  answerer = createAnswerer({ readScope: (slug) => readScope(slug)?.scope ?? null, writeAnswer, liveItems, stampThread, noteOf: currentNoteId })

  readTimer = setInterval(() => { void scanBulletinReads() }, delay(process.env.UNBLOCK_SCOPE_POLL_MS, 1000))
  readTimer.unref()

  // Queued notes survive a daemon restart even if scope.json is mid-write.
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (dir.isDirectory() && SLUG.test(dir.name) && (store.pendingScopeNotes(dir.name).length || store.pendingScopeTargets(dir.name).length)) schedule(dir.name)
    }
  } catch { /* scoping root not created yet */ }

  async function close() {
    closed = true
    answerer?.stop()
    clearInterval(readTimer)
    for (const entry of listeners.values()) {
      clearInterval(entry.timer)
      for (const client of entry.clients) client.end()
    }
    listeners.clear()
    for (const waits of noteWaits.values()) for (const set of waits.values()) for (const settle of set) settle('closed')
    noteWaits.clear()
    for (const job of delivering.values()) {
      clearTimeout(job.timer)
      job.wake?.()
    }
    while (delivering.size) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  function keepalive() {
    for (const entry of listeners.values()) for (const client of entry.clients) client.write(': keepalive\n\n')
  }

  return { handle, close, keepalive, recover: recoverAnswerer }
}
