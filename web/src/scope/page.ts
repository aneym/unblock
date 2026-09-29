import './scope.css'
import { createComments } from './comments'
import { inViewAnchor } from './dom-anchor'
import { sectionLabel, quoteSnippet } from '../../../src/scope-anchor.js'
import { prepareAudio } from '../lib/voice-audio'

(() => {
  'use strict'
  const boot = (window as any).__SCOPE_BOOT__ || {}
  const slug = boot.slug || (location.pathname.match(/^\/s\/([a-z0-9][a-z0-9-]{0,63})\/?$/) || [])[1] || null
  const $ = (sel: string, root: any = document): any => root.querySelector(sel)
  const el = (tag: string, attrs: any = {}, ...kids: any[]): any => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue
      if (key === 'class') node.className = String(value)
      else if (key === 'html') node.innerHTML = String(value)
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value as EventListener)
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid instanceof Node ? kid : String(kid))
    return node
  }
  const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c: any) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])

  // ---- storage (per-viewer conveniences only; the record lives in unblock) ----
  const store = {
    get(key: string) { try { return localStorage.getItem(key) } catch { return null } },
    set(key: string, value: string) { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key) } catch {} },
  }
  const draftKey = (qid: any) => `scope:${slug}:${qid || 'thought'}`

  // ---- time, always ET for Alex ----
  const fmtTime = (iso: any) => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso || '')
    const now = new Date()
    const opts: Intl.DateTimeFormatOptions = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }
    const sameDay = d.toLocaleDateString('en-US', { timeZone: 'America/New_York' }) === now.toLocaleDateString('en-US', { timeZone: 'America/New_York' })
    if (!sameDay) Object.assign(opts, { month: 'short', day: 'numeric' })
    return `${d.toLocaleString('en-US', opts)} ET`
  }

  // ---- small, safe markdown ----
  function inline(text: any) {
    let out = esc(text)
    const codes: string[] = []
    out = out.replace(/`([^`]+)`/g, (_: any, c: any) => { codes.push(c); return `\u0000${codes.length - 1}\u0000` })
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_: any, t: any, u: any) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_: any, pre: any, u: any) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    return out.replace(/\u0000(\d+)\u0000/g, (_: any, i: any) => `<code>${codes[Number(i)]}</code>`)
  }
  function markdown(src: any) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
    const html = []
    let i = 0
    const isTableSep = (line: any) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
    const cells = (line: any) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c: any) => c.trim())
    while (i < lines.length) {
      const line = lines[i]
      if (/^```/.test(line)) {
        const body = []
        i++
        while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
        i++
        html.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
        continue
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/)
      if (h) { html.push(`<h${h[1].length < 3 ? 3 : 4}>${inline(h[2])}</h${h[1].length < 3 ? 3 : 4}>`); i++; continue }
      if (/\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line)
        i += 2
        const rows = []
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]))
        html.push(`<table><thead><tr>${head.map((c: any) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r: any) => `<tr>${r.map((c: any) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
        continue
      }
      const list = line.match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/)
      if (list) {
        const ordered = /\d/.test(list[2])
        const items = []
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/)
          if (m) { items.push(m[3]); i++; continue }
          if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue }
          break
        }
        const tag = ordered ? 'ol' : 'ul'
        html.push(`<${tag}>${items.map((it: any) => `<li>${inline(it)}</li>`).join('')}</${tag}>`)
        continue
      }
      if (!line.trim()) { i++; continue }
      const para = [line]
      i++
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+[.)])\s)/.test(lines[i]) &&
        !(/\|/.test(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++])
      html.push(`<p>${inline(para.join(' '))}</p>`)
    }
    return html.join('')
  }

  // ---- network ----
  async function api(path: any, body?: any) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    })
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status })
    return data
  }

  const live = $('#live')
  function setLive(state: any) {
    live.className = `live ${state}`
    $('.label', live).textContent = state === 'on' ? 'Live' : state === 'off' ? 'Reconnecting' : 'Connecting'
  }

  // ---- index mode: /s/ ----
  async function renderIndex() {
    document.title = 'Scoping'
    const main = $('#main')
    try {
      const { scopes } = await api('/api/scope')
      main.replaceChildren(
        el('h1', {}, 'Scoping'),
        el('p', { class: 'meta' }, 'Every scoping lane with a live page.'),
        el('section', {}, scopes.length
          ? scopes.map((s: any) => el('a', { class: 'index-row', href: `/s/${s.slug}` },
              el('span', { class: 't' }, s.title || s.slug),
              el('span', { class: 'n' }, s.open ? `${s.open} open` : 'nothing open')))
          : el('p', { class: 'empty' }, 'No scoping lane has published a scope yet.')),
      )
      setLive('on')
    } catch (cause) {
      const error = cause as any
      main.replaceChildren(el('p', { class: 'empty' }, `Could not load: ${error.message}`))
      setLive('off')
    }
  }

  // ---- scope mode: /s/<slug> ----
  let scope: any = null
  let scopeError: any = null
  const notes = new Map() // id -> note (server) ; 'tmp-*' -> optimistic
  const qNodes = new Map<any, any>() // qid -> {root, parts}
  let built = false
  let asksOpen = false

  const deliveryLabel = (n: any) => ({
    sending: 'Sending…', queued: 'Sent, waiting for the lane', retrying: 'Lane busy, retrying',
    delivered: 'Delivered', failed: 'Not delivered', no_pane: 'Lane has no pane', error: 'Failed to send',
  } as Record<string, string>)[n.delivery] || ''

  function noteNode(n: any) {
    const from = n.from === 'agent' ? 'Lane' : 'You'
    const label = n.from === 'alex' ? deliveryLabel(n) : ''
    return el('li', { class: `note ${n.from}` },
      el('div', { class: 'note-meta' },
        el('span', { class: 'note-who' }, from),
        n.qid && !n.inQuestion ? el('span', {}, n.qid) : null,
        el('span', {}, fmtTime(n.at)),
        n.via === 'voice' ? el('span', {}, 'Voice') : null,
        label ? el('span', { class: `state-${n.delivery}` }, label) : null),
      n.inCommentCard ? null : commentMeta(n),
      el('p', { class: 'note-text' }, n.text))
  }

  function sortedNotes() {
    return [...notes.values()].sort((a: any, b: any) => (a.at || '').localeCompare(b.at || '') || String(a.id).localeCompare(String(b.id)))
  }

  function allThread() {
    const extra = Array.isArray(scope && scope.thread) ? scope.thread : []
    const fromFile = extra.filter((t: any) => t && t.text).map((t: any, i: any) => ({ id: `f${i}`, from: t.from === 'alex' ? 'alex' : 'agent', text: String(t.text), at: t.at || '', delivery: 'delivered' }))
    const db = sortedNotes()
    const near = (a: any, b: any) => Math.abs(Date.parse(a) - Date.parse(b)) < 120000
    // Each stored note hides at most one file entry, so repeated identical lines all survive.
    const used = new Set()
    const dup = (t: any) => {
      const match = db.find((n: any) => !used.has(n.id) && n.from === t.from && n.text === t.text && near(n.at, t.at))
      if (match) used.add(match.id)
      return Boolean(match)
    }
    return [...db, ...fromFile.filter((t: any) => !dup(t))]
      .sort((a: any, b: any) => (a.at || '').localeCompare(b.at || ''))
  }

  function autosize(ta: any) {
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 240)}px`
  }

  const inFlight = new Set()
  // `restore` is what goes back in a box if the send fails: the words as typed, never a prefix we added.
  async function send(text: any, qid: any, ta: any,  draftQid = qid,  restore = text) {
    const clean = String(text || '').trim()
    if (!clean) return
    const key = `${qid || ''}|${clean}`
    if (inFlight.has(key)) return
    // A repeat of the note just sent on the same question (a double tap) is not sent again.
    const last = sortedNotes().filter((n: any) => n.from === 'alex' && (n.qid || null) === (qid || null) && n.delivery !== 'error').at(-1)
    if (last && last.text === clean && Date.now() - Date.parse(last.at) < 60000) {
      if (ta) { ta.value = ''; store.set(draftKey(draftQid), ''); autosize(ta) }
      banner('Already sent.')
      return
    }
    inFlight.add(key)
    const tmp = { id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, from: 'alex', qid: qid || null, text: clean, at: new Date().toISOString(), delivery: 'sending' }
    notes.set(tmp.id, tmp)
    if (ta) { ta.value = ''; store.set(draftKey(draftQid), ''); autosize(ta) }
    renderDynamic()
    try {
      const { note } = await api(`/api/scope/${slug}/note`, qid ? { text: clean, qid } : { text: clean })
      notes.delete(tmp.id)
      if (!notes.has(note.id) || notes.get(note.id).delivery === 'queued') notes.set(note.id, note)
    } catch (cause) {
      const error = cause as any
      tmp.delivery = 'error'
      if (ta) {
        // The question may have been removed while this was in flight; then the text goes to the thought box.
        const target = ta.isConnected ? ta : $('#thought')
        const words = String(restore || '').trim()
        const back = target === ta ? words : `(on ${draftQid}) ${words}`
        const typed = target.value.trim()
        target.value = typed ? `${back}\n\n${typed}` : back
        store.set(draftKey(target === ta ? draftQid : null), target.value)
        autosize(target)
        banner(`That note did not send (${error.message}). It is back in the box.`)
      } else {
        banner(`That did not send (${error.message}). Try again.`)
      }
      setTimeout(() => { notes.delete(tmp.id); renderDynamic() }, 6000)
    } finally {
      inFlight.delete(key)
    }
    renderDynamic()
  }

  function replyBox(qid: any, getRec: any) {
    const ta = el('textarea', { rows: 1, placeholder: qid ? 'Your answer, or "r" for the recommendation' : '' })
    ta.value = store.get(draftKey(qid)) || ''
    const go = () => {
      let text = ta.value.trim()
      if (!text) return
      const rec = getRec()
      if (/^r$/i.test(text) && rec) text = `Take the recommendation: ${rec}`
      // A question the lane has since removed can't take an answer; send it as a thought.
      if (qid && !(scope.questions || []).some((x: any) => x && x.id === qid)) send(`(on ${qid}, since removed) ${text}`, null, ta, qid, ta.value)
      else send(text, qid, ta, qid, ta.value)
    }
    ta.addEventListener('input', () => { store.set(draftKey(qid), ta.value); autosize(ta) })
    ta.addEventListener('keydown', (e: any) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.metaKey || e.ctrlKey || !matchMedia('(pointer: coarse)').matches)) {
        e.preventDefault(); go()
      }
    })
    const take = el('button', { class: 'btn', type: 'button', onclick: () => {
      const rec = getRec()
      if (rec) send(`Take the recommendation: ${rec}`, qid, null)
    } }, 'Take recommendation')
    const sendBtn = el('button', { class: 'btn primary', type: 'button', onclick: go }, 'Send')
    requestAnimationFrame(() => autosize(ta))
    return { node: el('div', { class: 'reply', 'data-cm-skip': true }, ta, take, sendBtn), ta, take }
  }

  function questionNode(q: any) {
    const parts: any = {}
    parts.text = el('p', { class: 'q-text' })
    parts.rec = el('div', { class: 'rec' })
    parts.why = el('p', { class: 'why' })
    parts.settled = el('div', { class: 'settled' })
    parts.notes = el('ul', { class: 'notes', 'data-cm-skip': true })
    const box = replyBox(q.id, () => {
      const cur = (scope.questions || []).find((x: any) => x.id === q.id)
      return cur && cur.recommendation
    })
    parts.box = box
    parts.id = el('span', { class: 'q-id' }, q.id)
    const root = el('article', { class: 'q', id: `q-${q.id}` },
      el('div', { class: 'q-head' }, parts.id,
        el('div', { class: 'q-body' }, parts.text, parts.rec, parts.why, parts.settled, parts.notes, box.node)))
    return { root, parts }
  }

  function updateQuestion(entry: any, q: any) {
    const { parts, root } = entry
    const status = q.status === 'answered' || q.status === 'dropped' ? q.status : 'open'
    root.classList.toggle('is-dropped', status === 'dropped')
    parts.text.dataset.last = q.text || ''
    parts.text.replaceChildren(q.text || '', status !== 'open' ? el('span', { class: `tag ${status}`, 'data-cm-skip': true }, status === 'answered' ? 'Answered' : 'Dropped') : '')
    parts.rec.hidden = !q.recommendation || status === 'answered'
    parts.rec.innerHTML = q.recommendation ? `<b>Recommended:</b> ${inline(q.recommendation)}` : ''
    parts.why.hidden = !q.why || status === 'answered'
    parts.why.innerHTML = q.why ? inline(q.why) : ''
    const answer = q.answer || ''
    parts.settled.hidden = !(status === 'answered' && answer)
    parts.settled.innerHTML = answer ? `<b>Decided:</b> ${inline(answer)}` : ''
    parts.box.take.hidden = !q.recommendation || status !== 'open'
    parts.box.ta.placeholder = status === 'open' ? (q.recommendation ? 'Your answer, or "r" for the recommendation' : 'Your answer') : 'Change your answer or add to it'
    const mine = sortedNotes().filter((n: any) => n.qid === q.id)
    parts.notes.hidden = mine.length === 0
    parts.notes.replaceChildren(...mine.map((n: any) => noteNode({ ...n, inQuestion: true })))
  }

  let bannerTimer: any = null
  function banner(text: any) {
    const b = $('#banner')
    if (!b) return
    b.textContent = text
    b.hidden = !text
    clearTimeout(bannerTimer)
    if (text) bannerTimer = setTimeout(() => { if (!scopeError) b.hidden = true }, 8000)
  }

  function buildShell() {
    const main = $('#main')
    main.replaceChildren(
      el('h1', { id: 'title' }),
      el('p', { class: 'meta', id: 'meta' }),
      el('p', { class: 'banner', id: 'banner', hidden: true }),
      el('section', { id: 'askSec' }, el('h2', {}, 'Your ask'), el('div', { id: 'ask' })),
      el('section', { id: 'planSec' }, el('h2', {}, 'Plan'), el('div', { class: 'md', id: 'plan' })),
      el('section', { id: 'qSec' }, el('h2', {}, 'Questions'), el('div', { id: 'questions' })),
      el('section', { id: 'decSec' }, el('h2', {}, 'Decided'), el('div', { id: 'decisions' })),
      el('section', { id: 'threadSec' }, el('h2', {}, 'Thread'), el('ul', { class: 'notes', id: 'thread' })),
    )
    const dock = $('#dock')
    dock.hidden = false
    const ta = $('#thought')
    ta.value = store.get(draftKey(null)) || ''
    const go = () => send(ta.value, null, ta)
    ta.addEventListener('input', () => { store.set(draftKey(null), ta.value); autosize(ta) })
    ta.addEventListener('keydown', (e: any) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.metaKey || e.ctrlKey || !matchMedia('(pointer: coarse)').matches)) {
        e.preventDefault(); go()
      }
    })
    $('#thoughtSend').addEventListener('click', go)
    autosize(ta)
    built = true
  }

  function renderScope() {
    comments?.beforeRender()
    if (!scope) return
    if (!built) buildShell()
    const title = scope.title || slug
    document.title = `${title} · Scoping`
    $('#barName').replaceChildren(el('a', { href: '/s/' }, 'Scoping'), ' / ', title)
    $('#title').textContent = title
    const open = (scope.questions || []).filter((q: any) => !q.status || q.status === 'open').length
    $('#meta').replaceChildren(scope.updated_at ? `Updated ${fmtTime(scope.updated_at)} · ` : '',
      el('a', { href: '#qSec' }, `${open} open question${open === 1 ? '' : 's'}`),
      /^https?:\/\//i.test(scope.doc_url || '') ? el('span', {}, ' · ', el('a', { href: scope.doc_url, target: '_blank', rel: 'noopener' }, 'Full doc')) : '')

    const asks = Array.isArray(scope.ask) ? scope.ask : []
    $('#askSec').hidden = asks.length === 0
    const shown = asksOpen ? asks : asks.slice(0, 2)
    $('#ask').replaceChildren(...shown.map((a: any) => el('div', { class: 'quote' },
      el('p', {}, `“${a.quote || ''}”`),
      el('div', { class: 'src', 'data-cm-skip': true }, [a.date, a.source].filter(Boolean).join(' · ')))),
      asks.length > 2 ? el('button', { class: 'more', type: 'button', onclick: () => { asksOpen = !asksOpen; renderScope() } },
        asksOpen ? 'Show fewer' : `Show ${asks.length - 2} more`) : '')

    $('#planSec').hidden = !scope.plan_md
    $('#plan').innerHTML = markdown(scope.plan_md)

    // Questions are keyed by id so a live rewrite never touches a reply box.
    const qs = (Array.isArray(scope.questions) ? scope.questions : []).filter((q: any) => q && q.id)
    const wrap = $('#questions')
    const wanted = new Set(qs.map((q: any) => q.id))
    pruneOrphans(wanted)
    for (const [qid, entry] of qNodes) {
      if (wanted.has(qid)) continue
      // Keep an unsent draft reachable; its question is gone, so it will go as a thought.
      entry.root.classList.add('is-dropped')
      entry.parts.text.replaceChildren(entry.parts.text.dataset.last || '', el('span', { class: 'tag dropped', 'data-cm-skip': true }, 'Removed by the lane'))
      entry.parts.rec.hidden = true
      entry.parts.why.hidden = true
      entry.parts.box.take.hidden = true
      entry.parts.box.ta.placeholder = 'Sends as a thought'
    }
    let prev = null
    for (const q of qs) {
      let entry = qNodes.get(q.id)
      if (!entry) { entry = questionNode(q); qNodes.set(q.id, entry) }
      if (prev ? prev.nextSibling !== entry.root : wrap.firstChild !== entry.root) {
        prev ? prev.after(entry.root) : wrap.prepend(entry.root)
      }
      updateQuestion(entry, q)
      prev = entry.root
    }
    $('#qSec').hidden = qNodes.size === 0

    const decs = Array.isArray(scope.decisions) ? scope.decisions : []
    $('#decSec').hidden = decs.length === 0
    $('#decisions').replaceChildren(...decs.map((d: any) => el('div', { class: 'decision' },
      el('p', {}, el('span', { class: 'mono', style: 'color:var(--dim);margin-right:8px' }, d.id || ''), d.decision || ''),
      d.alex_words || d.at ? el('p', { class: 'words' }, [d.alex_words ? `“${d.alex_words}”` : '', d.at ? fmtTime(d.at) : ''].filter(Boolean).join(' · ')) : null)))

    const b = $('#banner')
    if (scopeError) { b.textContent = scopeError; b.hidden = false }
    renderThread()
    comments?.refresh()
  }

  function renderThread() {
    const list = allThread()
    $('#threadSec').hidden = list.length === 0
    $('#thread').replaceChildren(...list.map((n: any) => noteNode(n)))
  }

  // A question the lane removed disappears once its box is empty.
  function pruneOrphans(wanted = new Set((scope.questions || []).filter((q: any) => q && q.id).map((q: any) => q.id))) {
    for (const [qid, entry] of qNodes) {
      if (!wanted.has(qid) && !entry.parts.box.ta.value.trim()) { entry.root.remove(); qNodes.delete(qid) }
    }
    const sec = $('#qSec')
    if (sec) sec.hidden = qNodes.size === 0
  }

  function renderDynamic() {
    comments?.beforeRender()
    if (!scope) return
    pruneOrphans()
    for (const q of scope.questions || []) {
      const entry = qNodes.get(q.id)
      if (entry) updateQuestion(entry, q)
    }
    renderThread()
    comments?.refresh()
  }

  function applyState(data: any) {
    if (data.scope) scope = data.scope
    scopeError = data.error || null
    if (Array.isArray(data.notes)) for (const n of data.notes) notes.set(n.id, n)
    renderScope()
  }

  function applyNote(n: any) {
    notes.set(n.id, n)
    for (const [id, tmp] of notes) {
      if (String(id).startsWith('tmp-') && tmp.text === n.text && tmp.qid === (n.qid || null) && n.from === 'alex' && JSON.stringify(tmp.anchor || null) === JSON.stringify(n.anchor || null)) notes.delete(id)
    }
    renderDynamic()
  }

  let poll: any = null
  function startPolling() {
    if (poll) return
    poll = setInterval(async () => {
      try { applyState(await api(`/api/scope/${slug}`)) } catch {}
    }, 5000)
  }
  function stopPolling() { clearInterval(poll); poll = null }

  function connect() {
    const es = new EventSource(`/api/scope/${slug}/events`)
    es.addEventListener('state', (e: any) => { applyState(JSON.parse(e.data)); setLive('on'); stopPolling() })
    es.addEventListener('scope', (e: any) => { applyState(JSON.parse(e.data)) })
    es.addEventListener('note', (e: any) => { applyNote(JSON.parse(e.data)) })
    es.onopen = () => { setLive('on'); stopPolling() }
    es.onerror = () => { setLive('off'); startPolling() }
  }

  async function renderScopePage() {
    try {
      applyState(await api(`/api/scope/${slug}`))
      setLive('connecting')
    } catch (cause) {
      const error = cause as any
      $('#main').replaceChildren(
        el('h1', {}, slug),
        el('p', { class: 'empty' }, error.status === 404 ? 'This lane has not published its scope yet. The page will fill in when it does.' : `Could not load: ${error.message}`))
      setLive('off')
      setTimeout(renderScopePage, 5000)
      return
    }
    connect()
  }

  const comments = slug ? createComments({ slug, notes: sortedNotes, postNote, banner, noteNode, autosize }) : null
  function commentMeta(n: any) {
    const parent = n.reply_to ? [...notes.values()].find((note) => String(note.id) === String(n.reply_to)) : null
    const anchor = n.anchor || parent?.anchor
    if (!anchor) return null
    return el('button', { class: 'cm-thread-link', 'data-cm-skip': true, onclick: () => comments?.open(anchor, true) },
      n.reply_to ? `Reply to your comment on ${sectionLabel(anchor.section)}` : `On ${sectionLabel(anchor.section)}: “${quoteSnippet(anchor.quote)}”`)
  }
  async function postNote(body: any): Promise<any> {
    const clean = String(body.text || '').trim()
    if (!clean) throw new Error('Write a note first.')
    const key = JSON.stringify({ ...body, text: clean })
    if (inFlight.has(key)) throw new Error('This note is already sending.')
    const last = sortedNotes().filter((n) => n.from === 'alex' && (n.qid || null) === (body.qid || null) && JSON.stringify(n.anchor || null) === JSON.stringify(body.anchor || null) && n.delivery !== 'error').at(-1)
    if (last && last.text === clean && Date.now() - Date.parse(last.at) < 60000) { banner('Already sent.'); return { note: last } }
    inFlight.add(key)
    const tmp: any = { ...body, text: clean, id: `tmp-${Date.now()}-${Math.random()}`, from: 'alex', qid: body.qid || null, at: new Date().toISOString(), delivery: 'sending' }
    notes.set(tmp.id, tmp); renderDynamic()
    try {
      const result = await api(`/api/scope/${slug}/note`, { ...body, text: clean })
      notes.delete(tmp.id)
      if (!notes.has(result.note.id) || notes.get(result.note.id).delivery === 'queued') notes.set(result.note.id, result.note)
      renderDynamic(); return result
    } catch (error) {
      tmp.delivery = 'error'; renderDynamic()
      setTimeout(() => { notes.delete(tmp.id); renderDynamic() }, 6000)
      throw error
    } finally { inFlight.delete(key) }
  }
  const mic = $('#thoughtMic')
  mic.addEventListener('click', () => {
    let audio: AudioContext
    try { audio = prepareAudio() } catch (error) { banner(error instanceof Error ? error.message : 'Audio is unavailable.'); return }
    mic.disabled = true
    void import('./voice-mount').then(({ mountVoice }) => mountVoice(audio, {
      getScope: async () => ({ slug: slug!, scope }), postNote,
      getContext: () => ({ selection: comments?.context() || null, inView: inViewAnchor() }),
    }, (ui) => {
      if (ui.do === 'show') document.querySelector(ui.part.startsWith('Q') ? `#q-${ui.part}` : ui.part === 'questions' ? '#qSec' : `#${ui.part}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, (active) => { mic.disabled = active })).catch((error) => { void audio.close(); mic.disabled = false; banner(error.message) })
  })
  new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', `${$('#dock').getBoundingClientRect().height}px`)).observe($('#dock'))
  if (slug) renderScopePage()
  else renderIndex()
})()
