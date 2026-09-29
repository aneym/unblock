import './scope.css'
import { orderThreads, type ScopeV2, type Thread, type DocSection } from '../../../src/scope-doc.js'
import { locateAnchor, type Anchor } from '../../../src/scope-anchor.js'
const moment = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
import { anchorFromRange, sectionText, rangeFromAnchor } from './dom-anchor'
import { esc, markdown, renderMermaid } from './markdown'
import { prepareAudio } from '../lib/voice-audio'
import type { ScopeVoiceUi, ScopeFeedLine } from '../../../src/scope-voice.js'

const $ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)!
const boot = (window as any).__SCOPE_BOOT__ || {}
const slug = boot.slug || location.pathname.match(/^\/s\/([^/]+)/)?.[1]
const apiBase = (boot.api || '/api/scope').replace(/\/$/, '')
const embed = boot.embed === true || new URLSearchParams(location.search).get('embed') === '1'
document.body.classList.toggle('embed', embed)
const doc = $('#doc'), cards = $('#cards'), detached = $('#detached'), sheet = $('#sheet')
const phone = () => matchMedia('(max-width:899px)').matches
const storage = { get(key: string) { try { return localStorage.getItem(key) } catch { return null } }, set(key: string, value: string) { try { localStorage.setItem(key, value) } catch {} } }
const time = (iso: string) => `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`
let scope: ScopeV2 | null = null, focused: string | null = null, initialized = false
let showResolved = storage.get('scope:showResolved') === 'true'
let selection: Anchor | null = null, selectionTop = 0, composing: Anchor | null = null
type Sending = { clientId: string; id?: string; anchor?: Anchor; text: string; at: number }
const sending = new Map<string, Sending>()
const pending = new Set<string>()
function disablePending() { document.querySelectorAll<HTMLElement>('.card').forEach(card => { const key = card.classList.contains('composer') ? 'composer' : card.dataset.t; if (key && (pending.has(key) || sending.has(key))) card.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button => button.disabled = true) }) }
const modes = new Map<string, 'no' | 'else' | 'reply'>(), menus = new Set<string>()
const drafts = new Map<string, string>(), errors = new Map<string, string>(), notes = new Map<string, any>(), missing = new Set<string>()
const marks = (id: string) => [...doc.querySelectorAll<HTMLElement>(`mark[data-t="${id}"]`)]
const hidden = (mark: HTMLElement) => !!mark.closest('details:not([open])')
const ordered = () => scope ? orderThreads(scope) : []
const open = () => ordered().filter(t => t.status === 'open')
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
  const result = await res.json(); if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`); return result
}
const endpoint = `${apiBase}/${encodeURIComponent(slug)}`
function upsert(thread: Thread) {
  if (!scope) return
  const i = scope.threads.findIndex(t => t.id === thread.id)
  if (i < 0) scope.threads.push(thread); else scope.threads[i] = thread
  render()
}
function clientId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
async function write(route: string, body: Record<string, unknown>, id?: string) {
  const client_id = clientId()
  const res = await fetch(`${endpoint}/threads${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, client_id }) })
  const result = await res.json(); if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`)
  if (res.status === 202 || result.queued === true) {
    const key = id || client_id
    if (!hasClientId(client_id)) sending.set(key, { clientId: client_id, id, anchor: body.anchor as Anchor | undefined, text: String(body.text ?? body.alex_words ?? body.decision ?? ''), at: Date.now() })
    if (id) drafts.delete(id)
    renderCards()
  } else if (result.thread) upsert(result.thread)
  return result
}
async function postThread(body: { anchor: Anchor; text: string; via?: 'voice' }) { return write('', body) }
async function postReply(id: string, body: { text: string; via?: 'voice' }) { return write(`/${id}/reply`, body, id) }
async function postResolve(id: string, body: { decision: string; alex_words?: string; how?: 'take' | 'own' | 'resolve'; via?: 'voice' }) { return write(`/${id}/resolve`, body, id) }
async function postReject(id: string, body: { text: string; via?: 'voice' }) { return write(`/${id}/reject`, body, id) }
async function postPark(id: string, body: { via?: 'voice' } = {}) { return write(`/${id}/park`, body, id) }
function hasClientId(clientId: string) { return scope?.threads.some(t => t.messages.some(m => (m as any).client_id === clientId) || (t.resolution as any)?.client_id === clientId || (t as any).parked_client_id === clientId) || false }
function sendingLine(item: Sending) { return `<div class="waiting sending" data-client="${esc(item.clientId)}" role="status">${Date.now() - item.at >= 120_000 ? 'Still sending. Admin will keep trying.' : 'Sending…'}${item.text ? ` &quot;${esc(item.text)}&quot;` : ''}</div>` }
setInterval(() => {
  document.querySelectorAll<HTMLElement>('.sending[data-client]').forEach(line => {
    const item = [...sending.values()].find(item => item.clientId === line.dataset.client)
    if (item && Date.now() - item.at >= 120_000) line.textContent = `Still sending. Admin will keep trying.${item.id && item.text ? ` "${item.text}"` : ''}`
  })
}, 10_000)
type CommentState = 'In the doc' | 'Waiting for the lane to pause' | 'With the lane' | 'Retrying' | 'Not sent' | 'No lane pane'
const commentStates = new Map<string, { state: CommentState; takenAt?: number; timer?: number }>()
function delivery(id: string): CommentState | '' {
  const note = [...notes.values()].filter(n => n.thread === id && n.from === 'alex').sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1)
  if (!note) return ''
  const thread = scope?.threads.find(t => t.id === id), section = scope?.doc.sections.find(s => s.id === thread?.anchor.section)
  if (note.delivery === 'delivered' && (thread?.messages.some(m => m.from !== 'alex' && m.at > note.delivered_at) || (section as DocSection & { updated_at?: string })?.updated_at! > note.delivered_at || thread?.status === 'resolved' && thread.resolution?.confirmed_at)) return 'In the doc'
  return ({ held: 'Waiting for the lane to pause', delivered: 'With the lane', queued: 'With the lane', retrying: 'Retrying', failed: 'Not sent', no_pane: 'No lane pane' } as Record<string, CommentState>)[note.delivery] || ''
}
function updateCommentStates() {
  for (const t of scope?.threads || []) {
    const state = delivery(t.id), previous = commentStates.get(t.id)
    if (!state || previous?.state === state) continue
    if (previous?.timer) clearTimeout(previous.timer)
    const entry: { state: CommentState; takenAt?: number; timer?: number } = { state }
    if (state === 'In the doc') {
      entry.takenAt = previous ? Date.now() : 0
      if (previous) entry.timer = window.setTimeout(render, 30_000)
    }
    commentStates.set(t.id, entry)
  }
}
function deliveryChip(id: string) {
  const entry = commentStates.get(id)
  return entry && (entry.state !== 'In the doc' || entry.takenAt && Date.now() - entry.takenAt < 30_000) ? `<span class="delivery-chip">${entry.state}</span>` : ''
}
function inflight() {
  const count = (state: CommentState) => scope!.threads.filter(t => delivery(t.id) === state).length
  const waiting = count('Waiting for the lane to pause'), withLane = count('With the lane'), taken = count('In the doc')
  if (!waiting && !withLane) return ''
  const total = waiting + withLane + taken
  return `${total} comment${total === 1 ? '' : 's'} · ` + [[taken, 'taken'], [waiting, 'waiting for the lane to pause'], [withLane, 'with the lane']].filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ')
}
function cardHtml(t: Thread) {
  const isOpen = t.status === 'open', label = t.status === 'parked' ? 'Parked' : !isOpen ? 'Resolved' : t.kind === 'question' ? 'Lane asks' : 'You commented'
  const mode = !sending.has(t.id) && (modes.get(t.id) || (t.kind === 'comment' ? 'reply' : null))
  const compose = mode && { no: ["What's wrong with it? (optional)", 'Send No'], else: ['Your answer', 'Send answer'], reply: [t.kind === 'question' ? 'Ask the lane something' : 'Reply', t.kind === 'question' ? 'Send' : 'Reply'] }[mode]
  const menu = isOpen && menus.has(t.id) ? `<div class="menu" role="menu">${t.kind === 'question' ? '<button role="menuitem" data-action="menu-reply">Reply</button>' : ''}<button role="menuitem" data-action="resolve">Resolve</button>${t.kind === 'question' ? '<button role="menuitem" class="tall" data-action="park">Not now<small>Park it without answering</small></button>' : ''}</div>` : ''
  let body = ''
  if (isOpen && compose) body = `<div class="reply only-on"><textarea data-draft="${t.id}" rows="${modes.has(t.id) ? 2 : 1}" placeholder="${esc(compose[0])}">${esc(drafts.get(t.id))}</textarea><p class="error" role="alert">${esc(errors.get(t.id))}</p><div class="actions"><button class="btn primary" data-action="${t.kind === 'comment' ? 'reply' : 'send'}">${compose[1]}</button>${modes.has(t.id) ? '<button class="btn" data-action="cancel">Cancel</button>' : ''}</div></div>`
  else if (isOpen && t.rejected_at) body = '<div class="waiting"><span class="dot"></span>Rejected, waiting for a new option</div>'
  else if (isOpen && t.kind === 'question') body = t.recommendation ? '<div class="choices only-on"><button class="btn" data-action="take">Take it</button><button class="btn" data-action="no">No</button><button class="btn" data-action="else">Something else</button></div>' : '<div class="choices only-on"><button class="btn one" data-action="else">Answer</button></div>'
  const newRec = !t.rejected_at && t.messages.some(m => m.kind === 'option')
  const state = [deliveryChip(t.id), t.anchor.t != null ? `<span class="moment">at ${moment(t.anchor.t)}</span>` : ''].filter(Boolean).join(' · ')
  return `<div class="head"><span class="kind"><span class="dot ${isOpen ? t.kind : 'resolved'}"></span><span class="who">${label}</span></span><span class="when">${time(t.created_at)}</span>${isOpen ? '<button class="more" data-action="menu" aria-label="More" aria-haspopup="menu">⋯</button>' : ''}</div>${menu}<div class="q">${esc(t.messages[0]?.text)}</div>${state ? `<p class="card-state">${state}</p>` : ''}
  ${isOpen && t.recommendation ? `<div class="rec${newRec ? ' new' : ''}"><span class="lbl">Recommended</span><span class="txt">${esc(t.recommendation)}</span></div>` : ''}
  ${isOpen && t.kind === 'question' && t.options?.length ? `<div class="other-options only-on"><span class="lbl">Other options</span>${t.options.slice(1).map((option, i) => `<button data-action="option" data-option="${i + 1}">${esc(option)}</button>`).join('')}</div>` : ''}
  ${isOpen && t.why ? `<details class="why only-on"><summary>Why</summary><p>${esc(t.why)}</p></details>` : ''}
  ${t.messages.length > 1 ? `<div class="msgs only-on">${t.messages.slice(1).map((m, i) => `<div class="msg"><div class="from">${m.from === 'alex' ? 'You' : 'Lane'}<span>${time(m.at)}</span></div><div>${m.kind === 'reject' ? 'No' + (m.text ? ': ' : '') : ''}${esc(m.text)}</div></div>`).join('')}</div>` : ''}
  ${t.status === 'parked' ? '<div class="settled"><b>Parked.</b> Not answered; the lane leaves it for later.</div>' : t.status === 'resolved' ? `<div class="settled"><b>Resolved:</b> ${esc(t.resolution?.decision)}${!t.resolution?.confirmed_at ? '<span class="wait">Sent to the lane. It will update the doc to say so.</span>' : ''}</div>` : ''}${sending.has(t.id) ? sendingLine(sending.get(t.id)!) : body}${!compose && errors.has(t.id) ? `<p class="error" role="alert">${esc(errors.get(t.id))}</p>` : ''}`
}
function card(t: Thread) {
  const node = document.createElement('div'); node.className = `card ${t.kind} ${t.status}${focused === t.id ? ' on' : ''}`; node.dataset.t = t.id; if (sending.has(t.id)) node.dataset.sending = 'true'; node.innerHTML = cardHtml(t); return node
}
function highlight() {
  missing.clear()
  for (const t of ordered()) {
    const root = document.getElementById(t.anchor.section)
    if (!root?.matches('section[data-section]')) { missing.add(t.id); continue }
    const { text, map } = sectionText(root), found = locateAnchor(text, t.anchor)
    if (!found) { missing.add(t.id); continue }
    const pieces = new Map<Text, { start: number; end: number }>()
    for (const pos of map.slice(found.start, found.end)) if (pos) { const piece = pieces.get(pos.node); if (piece) piece.end = pos.offset + 1; else pieces.set(pos.node, { start: pos.offset, end: pos.offset + 1 }) }
    for (const [node, piece] of pieces) {
      const range = document.createRange(); range.setStart(node, piece.start); range.setEnd(node, piece.end)
      const mark = document.createElement('mark'); mark.className = `hl ${t.kind} ${t.status}${t.status === 'parked' ? ' resolved' : ''}${t.id === focused ? ' on' : ''}`; mark.dataset.t = t.id; range.surroundContents(mark)
    }
  }
}
const sectionSignatures = new Map<string, string>(), sectionContents = new Map<string, string>(), changeTimers = new Map<string, number>()
function contentSignature(s: DocSection) {
  const assets = [...s.body_md.matchAll(/asset:([^\s)]+)/g)].map(m => {
    const asset = scope!.doc.assets?.[m[1]]
    return [m[1], asset, asset?.type === 'mock' ? [asset.light, asset.dark, asset.html].map(id => id && scope!.doc.assets?.[id]) : null]
  })
  return JSON.stringify([s.heading, s.body_md, (s as DocSection & { updated_at?: string }).updated_at, assets])
}
function signature(s: DocSection, line: string) {
  return JSON.stringify([contentSignature(s), s.id === 'title' ? [scope!.revision, scope!.updated_at, line] : null])
}
function render() {
  if (!scope) return
  const active = document.activeElement as HTMLTextAreaElement | null, activeKey = active?.dataset.draft, caret = active?.selectionStart, caretEnd = active?.selectionEnd, direction = active?.selectionDirection
  const first = !initialized
  if (first) { focused = phone() ? null : open().find(t => t.anchor.section !== 'ask')?.id || null; initialized = true }
  updateCommentStates()
  const line = inflight(), signatures = new Map(scope.doc.sections.map(s => [s.id, signature(s, line)]))
  const unchanged = (id: string) => signatures.get(id) === sectionSignatures.get(id)
  const candidates = [...doc.querySelectorAll<HTMLElement>('h1,h2,p,li,figure,pre,table')].filter(n => n.closest('section[data-section]') && n.getClientRects().length && n.getBoundingClientRect().top >= 0)
  const reading = candidates.find(n => unchanged(n.closest('section')!.id)) || candidates[0]
  const readingTop = reading?.getBoundingClientRect().top, readingSection = reading?.closest('section')?.id
  const sel = getSelection(), selected = sel?.rangeCount && !sel.isCollapsed ? anchorFromRange(sel.getRangeAt(0)) : null
  const keepSelection = selected && unchanged(selected.section) ? selected : null
  const backward = !!sel?.rangeCount && sel.anchorNode === sel.getRangeAt(0).endContainer && sel.anchorOffset === sel?.getRangeAt(0)?.endOffset
  const askOpen = doc.querySelector<HTMLDetailsElement>('.ask-fold')?.open || false
  const redrawn: HTMLElement[] = []
  let position = 0
  for (const s of scope.doc.sections) {
    let node = [...doc.children].find(n => n.id === s.id) as HTMLElement | undefined
    if (!node || !unchanged(s.id)) {
      const replacement = document.createElement('div'); replacement.innerHTML = `<section id="${esc(s.id)}" data-section>${s.id === 'ask' ? `<details class="ask-fold"${askOpen ? ' open' : ''}><summary><svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><h2>${esc(s.heading)}</h2></summary><div class="body">${markdown(s.body_md, scope!.doc.assets, `${endpoint}/assets`)}</div></details>` : `${s.id === 'title' ? '<p class="eyebrow" data-cm-skip>Scoping</p>' : ''}<${s.id === 'title' ? 'h1' : 'h2'}>${esc(s.heading)}</${s.id === 'title' ? 'h1' : 'h2'}><div class="body ${s.id === 'title' ? 'lede' : ''}">${markdown(s.body_md, scope!.doc.assets, `${endpoint}/assets`)}</div>${s.id === 'title' ? `<p class="meta" data-cm-skip>Revision ${scope!.revision} · Updated ${time(scope!.updated_at)}${boot.voice === false && boot.voiceUrl && /^https?:\/\//i.test(boot.voiceUrl) ? ` · <a href="${esc(boot.voiceUrl)}" target="_blank" rel="noopener">Open with voice</a>` : ''}</p><p class="inflight" data-cm-skip${line ? '' : ' hidden'}>${esc(line)}</p>` : ''}`}</section>`
      const next = replacement.firstElementChild as HTMLElement
      if (node) node.replaceWith(next)
      node = next; redrawn.push(node)
      if (!first && (s.id !== 'title' || contentSignature(s) !== sectionContents.get(s.id))) {
        node.classList.add('changed')
        clearTimeout(changeTimers.get(s.id))
        changeTimers.set(s.id, window.setTimeout(() => { node!.classList.remove('changed'); changeTimers.delete(s.id) }, 4000))
      }
      node.querySelectorAll<HTMLElement>('.demo-stage').forEach(stage => { stage.style.height = `${stage.dataset.height}px`; stage.dataset.title = stage.closest('figure')?.querySelector('figcaption')?.textContent || 'Demo' })
      node.querySelectorAll<HTMLVideoElement>('figure.video video').forEach(video => {
        const update = () => { const button = video.closest('figure')?.querySelector('button.fig-comment'); if (button) button.textContent = video.currentTime >= .5 ? `Comment at ${moment(video.currentTime)}` : 'Comment on this recording' }
        for (const event of ['timeupdate', 'seeked', 'pause']) video.addEventListener(event, update)
      })
      node.querySelector('.ask-fold')?.addEventListener('toggle', layout)
      node.querySelectorAll<HTMLButtonElement>('button.shot').forEach(button => {
        const image = button.querySelector('img')!
        const size = () => { const ratio = (Number(image.getAttribute('width')) || image.naturalWidth || 1) / (Number(image.getAttribute('height')) || image.naturalHeight || 1); button.style.flexGrow = String(ratio); button.style.width = `calc(var(--shot-height) * ${ratio})`; layout() }
        image.addEventListener('load', size); size()
      })
    }
    if (doc.children[position] !== node) doc.insertBefore(node, doc.children[position] || null)
    position++
  }
  for (const node of [...doc.childNodes] as Element[]) if (!signatures.has(node.id)) { node.remove(); clearTimeout(changeTimers.get(node.id)); changeTimers.delete(node.id) }
  sectionSignatures.clear(); for (const [id, value] of signatures) sectionSignatures.set(id, value)
  sectionContents.clear(); for (const s of scope.doc.sections) sectionContents.set(s.id, contentSignature(s))
  doc.querySelectorAll('mark.hl').forEach(mark => { const parent = mark.parentNode!; mark.replaceWith(...mark.childNodes); parent.normalize() })
  document.title = scope.title; highlight(); syncFigureFocus(); renderCards(); renderFeed()
  const restoreReading = () => {
    const anchor = reading?.isConnected ? reading : readingSection ? document.getElementById(readingSection)?.querySelector('h1,h2') : null
    if (anchor && readingTop != null) scrollTo({ top: scrollY + anchor.getBoundingClientRect().top - readingTop, behavior: 'instant' })
  }
  restoreReading()
  for (const node of redrawn) void renderMermaid(node, () => { layout(); restoreReading() })
  if (keepSelection) {
    const range = rangeFromAnchor(keepSelection)?.range
    if (range && sel) sel.setBaseAndExtent(backward ? range.endContainer : range.startContainer, backward ? range.endOffset : range.startOffset, backward ? range.startContainer : range.endContainer, backward ? range.startOffset : range.endOffset)
  }
  if (activeKey) { const target = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')].find(n => n.dataset.draft === activeKey && n.getClientRects().length); target?.focus({ preventScroll: true }); if (caret != null) target?.setSelectionRange(caret, caretEnd ?? caret, direction || undefined) }
}
function renderCards() {
  syncFigureFocus()
  const visible = ordered().filter(t => t.status === 'open' || showResolved)
  cards.replaceChildren(...visible.filter(t => !missing.has(t.id)).map(card))
  detached.replaceChildren()
  const gone = visible.filter(t => missing.has(t.id))
  if (gone.length) { detached.append('Detached · the text it was on changed', ...gone.map(card)) }
  for (const item of sending.values()) if (!item.id && item.anchor) {
    const node = document.createElement('div'); node.className = 'card comment on'; node.dataset.sending = 'true'; node.dataset.client = item.clientId
    node.innerHTML = `<div class="head"><span class="who">You commented</span></div><div class="q">${esc(item.text)}</div>${sendingLine({ ...item, text: '' })}`
    cards.append(node)
  }
  if (composing) renderComposer()
  document.body.classList.toggle('show-resolved', showResolved)
  const toggle = $<HTMLInputElement>('#showResolved'); toggle.checked = showResolved; toggle.toggleAttribute('checked', showResolved)
  if (!composing && phone() && document.body.classList.contains('sheet-open')) renderSheet()
  updateCount(); layout(); disablePending()
}
function figureFor(mark: HTMLElement | undefined) { return mark?.closest('figcaption')?.closest<HTMLElement>('figure.fig') }
function syncFigureFocus() { const figure = focused ? figureFor(marks(focused)[0]) : null; doc.querySelectorAll('figure.fig').forEach(node => node.classList.toggle('on', node === figure)) }
function layoutShots() {
  doc.querySelectorAll<HTMLElement>('.shots:not(.storyboard) .shots-row').forEach(row => {
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('button.shot')]
    if (phone()) {
      buttons.forEach(button => { button.style.width = ''; button.style.height = ''; button.style.flexGrow = ''; button.style.marginLeft = ''; button.style.marginRight = '' })
      return
    }
    const width = row.getBoundingClientRect().width, gap = parseFloat(getComputedStyle(row).gap) || 0
    if (!width) return
    const aspect = (button: HTMLButtonElement) => {
      const image = button.querySelector('img')!
      return (Number(image.getAttribute('width')) || image.naturalWidth || 1) / (Number(image.getAttribute('height')) || image.naturalHeight || 1)
    }
    const lines: HTMLButtonElement[][] = []
    let line: HTMLButtonElement[] = [], sum = 0
    for (const button of buttons) {
      const ratio = aspect(button)
      if (line.length && (width - gap * line.length) / (sum + ratio) < 320) { lines.push(line); line = []; sum = 0 }
      line.push(button); sum += ratio
    }
    if (line.length) lines.push(line)
    for (const shots of lines) {
      const sum = shots.reduce((sum, button) => sum + aspect(button), 0)
      const height = Math.min((width - gap * (shots.length - 1)) / sum, 560)
      const margin = Math.max(0, (width - gap * (shots.length - 1) - sum * height) / 2)
      shots.forEach((button, i) => {
        button.style.flexGrow = '0'; button.style.width = `${aspect(button) * height}px`; button.style.height = `${height}px`
        button.style.marginLeft = i === 0 ? `${margin}px` : '0'; button.style.marginRight = i === shots.length - 1 ? `${margin}px` : '0'
      })
    }
  })
}
function layout() {
  layoutShots()
  if (phone()) return
  const base = cards.getBoundingClientRect().top
  const nodes = [...cards.querySelectorAll<HTMLElement>(':scope > .card')]
  const want = nodes.map(n => {
    const queued = [...sending.values()].find(item => !item.id && item.clientId === n.dataset.client), range = queued?.anchor && rangeFromAnchor(queued.anchor)?.range
    const mark = marks(n.dataset.t!)[0], anchor = mark && !hidden(mark) && mark.getClientRects().length ? figureFor(mark) || mark : mark?.closest('details:not([open])')?.querySelector('summary')
    return Math.max(8, (n.classList.contains('composer') ? selectionTop : range ? range.getBoundingClientRect().top + scrollY : anchor ? anchor.getBoundingClientRect().top + scrollY : base + scrollY) - scrollY - base - 12)
  })
  const heights = nodes.map(n => n.offsetHeight), top = [...want]
  let pivot = nodes.findIndex(n => composing ? n.classList.contains('composer') : n.dataset.t === focused); if (pivot < 0) pivot = 0
  for (let i = pivot + 1; i < nodes.length; i++) top[i] = Math.max(want[i], top[i - 1] + heights[i - 1] + 10)
  for (let i = pivot - 1; i >= 0; i--) top[i] = Math.min(want[i], top[i + 1] - heights[i] - 10)
  if (top[0] < 8) { const shift = 8 - top[0]; top.forEach((_, i) => top[i] += shift) }
  nodes.forEach((n, i) => n.style.top = `${top[i]}px`)
  const height = nodes.length ? Math.max(...top.map((t, i) => t + heights[i])) + 20 : 0
  cards.style.height = `${height}px`; showSelection()
}
function updateCount() {
  const list = open(), i = list.findIndex(t => t.id === focused)
  $('#openCount').innerHTML = `${list.length} open${i >= 0 ? `<small>${i + 1} of ${list.length}</small>` : ''}`
  $('#openLabel').textContent = `${list.length} open`
}
// Only a click on a thread seeks its recording; scroll-follow, posting and redraws leave it where it is.
function seekMoment(id: string) {
  const anchor = scope?.threads.find(t => t.id === id)?.anchor as Anchor | undefined
  const video = figureFor(marks(id)[0])?.querySelector<HTMLVideoElement>('video')
  if (video && anchor?.t != null) video.currentTime = anchor.t
}
function focus(id: string | null, scroll = false, openSheet = true) {
  focused = id
  if (id && scope?.threads.some(t => t.id === id && t.status === 'open' && t.anchor.section === 'ask')) { const fold = doc.querySelector<HTMLDetailsElement>('.ask-fold'); if (fold) fold.open = true }
  document.querySelectorAll<HTMLElement>('.card[data-t],mark[data-t]').forEach(n => n.classList.toggle('on', n.dataset.t === id))
  syncFigureFocus()
  if (id && scroll) { const mark = figureFor(marks(id)[0]) || marks(id)[0]; if (mark) { if (phone()) scrollTo({ top: scrollY + mark.getBoundingClientRect().top - 96, behavior: 'instant' }); else mark.scrollIntoView({ block: 'center', behavior: 'smooth' }); mark.classList.remove('flash'); void mark.offsetWidth; mark.classList.add('flash') } }
  if (phone() && id && openSheet) { document.body.classList.add('sheet-open'); renderSheet(); const mark = figureFor(marks(id)[0]) || marks(id)[0]; if (mark) scrollTo({ top: scrollY + mark.getBoundingClientRect().top - 96, behavior: 'instant' }) }
  updateCount(); layout()
}
function step(direction: number) { const list = open(); if (!list.length) return; const index = list.findIndex(t => t.id === focused); focus(list[Math.max(0, Math.min(list.length - 1, index < 0 ? 0 : index + direction))].id, true) }
function renderSheet() {
  const t = scope?.threads.find(t => t.id === focused); if (!t) { closeSheet(); return }
  const i = open().findIndex(x => x.id === t.id)
  sheet.toggleAttribute('data-sending', sending.has(t.id)); if (sending.has(t.id)) sheet.dataset.sending = 'true'
  sheet.innerHTML = `<div class="grab"></div><div class="quote">On <q>${esc(t.anchor.quote)}</q></div><div class="card on ${t.kind} ${t.status}" data-t="${t.id}">${cardHtml(t)}</div>${i >= 0 ? `<div class="nav"><span>${i + 1} of ${open().length} open</span><span class="spacer"></span><button class="icon-btn" data-go="-1" aria-label="Previous">↑</button><button class="icon-btn" data-go="1" aria-label="Next">↓</button></div>` : ''}`
}
function closeSheet() { document.body.classList.remove('sheet-open') }
function showSelection() {
  document.querySelector('[data-action="comment"]')?.remove()
  if (!selection || composing) return
  const button = document.createElement('button'); button.className = 'add'; button.dataset.action = 'comment'; button.textContent = 'Comment'
  if (phone()) { button.style.top = `${Math.max(56, selectionTop - scrollY - 40)}px`; button.style.left = '16px'; document.body.append(button) }
  else { button.style.top = `${selectionTop - scrollY - cards.getBoundingClientRect().top - 4}px`; cards.append(button) }
}
function readSelection() {
  if (!zoom.hidden) return
  const sel = getSelection(); if (!sel?.rangeCount || sel.isCollapsed) { if (!document.activeElement?.closest('.card,.add')) { selection = null; showSelection() } return }
  const range = sel.getRangeAt(0), anchor = anchorFromRange(range)
  if (anchor) { selection = anchor; selectionTop = range.getBoundingClientRect().top + scrollY; showSelection() }
}
function renderComposer() {
  const node = document.createElement('div'); node.className = 'card composer comment on'; node.innerHTML = `<div class="head"><span class="dot comment"></span><span class="who">You commented</span></div><div class="reply">${composing?.t != null ? `<div class="moment">At ${moment(composing.t)}</div>` : ''}<textarea rows="2" data-draft="composer" placeholder="${composing?.t != null ? 'Comment on this moment' : 'Comment on this text'}">${esc(drafts.get('composer'))}</textarea><p class="error">${esc(errors.get('composer'))}</p><div class="actions"><button class="btn primary" data-action="post">Comment</button><button class="btn" data-action="cancel">Cancel</button></div></div>`
  if (phone()) { sheet.replaceChildren(node); document.body.classList.add('sheet-open') }
  else { const range = composing && rangeFromAnchor(composing)?.range; const after = [...cards.children].find(n => { const mark = marks((n as HTMLElement).dataset.t!)[0]; return range && mark && range.comparePoint(mark.firstChild!, 0) > 0 }); cards.insertBefore(node, after || null) }
}
async function action(name: string, target: HTMLElement) {
  if (name === 'comment') { composing = selection; renderCards(); $('.composer textarea', phone() ? sheet : cards).focus(); return }
  const id = target.closest<HTMLElement>('[data-t]')?.dataset.t, t = scope?.threads.find(t => t.id === id), key = name === 'post' ? 'composer' : id!
  if (pending.has(key) || sending.has(key)) return
  const text = (drafts.get(key) || '').trim()
  if (name === 'cancel') { if (t) { modes.delete(t.id); menus.delete(t.id); renderCards() } else { composing = null; drafts.delete('composer'); closeSheet(); renderCards() }; return }
  if (t && name === 'option') {
    const option = t.options?.[Number(target.dataset.option)]
    if (option == null || t.kind !== 'question' || t.status !== 'open') return
    menus.delete(t.id); modes.set(t.id, 'else'); drafts.set(t.id, option); focus(t.id, false, false); renderCards()
    const input = $<HTMLTextAreaElement>(`.card[data-t="${t.id}"] textarea`, phone() ? sheet : cards)
    input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); return
  }
  if (t && ['menu', 'no', 'else', 'menu-reply'].includes(name)) {
    if (name === 'menu') { if (menus.has(t.id)) menus.delete(t.id); else menus.add(t.id) }
    else { menus.delete(t.id); modes.set(t.id, name === 'menu-reply' ? 'reply' : name as 'no' | 'else') }
    renderCards(); if (name !== 'menu') $<HTMLTextAreaElement>(`.card[data-t="${t.id}"] textarea`, phone() ? sheet : cards).focus({ preventScroll: true }); return
  }
  const mode = t && modes.get(t.id)
  if ((name === 'send' && mode !== 'no' || name === 'reply' || name === 'post') && !text) { target.closest('.card')?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); return }
  pending.add(key); disablePending()
  try {
    if (name === 'post' && composing && text) { const anchor = composing; const result = await postThread({ anchor, text }); composing = null; selection = null; drafts.delete(key); errors.delete(key); if (result.thread) focus(result.thread.id); else closeSheet(); return }
    if (!t) return
    if (name === 'reply' || name === 'send' && mode === 'reply') await postReply(t.id, { text })
    else if (name === 'send' && mode === 'no') await postReject(t.id, { text })
    else if (name === 'send' && mode === 'else') await postResolve(t.id, { decision: text, alex_words: text, how: 'own' })
    else if (name === 'take' && t.recommendation) await postResolve(t.id, { decision: t.recommendation, alex_words: 'Take the recommendation', how: 'take' })
    else if (name === 'resolve') await postResolve(t.id, { decision: 'Resolved', alex_words: 'Resolved', how: 'resolve' })
    else if (name === 'park') await postPark(t.id)
    if ((drafts.get(key) || '').trim() === text) drafts.delete(key); errors.delete(key); modes.delete(t.id); menus.delete(t.id)
    if (!sending.has(t.id) && (['take', 'resolve', 'park'].includes(name) || name === 'send' && mode === 'else')) { closeSheet(); focused = open()[0]?.id || null }
    renderCards()
  } catch (error) { errors.set(key, error instanceof Error ? error.message : 'Could not send') }
  finally { pending.delete(key); renderCards() }
}
const zoom = document.createElement('div')
zoom.className = 'zoom'; zoom.hidden = true; zoom.setAttribute('role', 'dialog'); zoom.setAttribute('aria-modal', 'true')
zoom.innerHTML = '<div class="zoom-view"><img alt=""></div><div class="zoom-bar"><span class="zoom-caption"></span><span class="zoom-count"></span><a target="_blank" rel="noopener">Open live mock</a><button type="button" aria-label="Close">Close</button></div>'
document.body.append(zoom)
const zoomImage = $<HTMLImageElement>('img', zoom), zoomView = $('.zoom-view', zoom)
let zoomShots: HTMLButtonElement[] = [], zoomIndex = 0, zoomScroll = 0, zoomFigureIndex = 0
function showZoomShot() {
  const button = zoomShots[zoomIndex], image = button.querySelector('img')!, asset = scope?.doc.assets?.[button.dataset.asset!]
  const caption = button.closest('figure')?.querySelector('figcaption')?.textContent || image.alt
  zoom.setAttribute('aria-label', caption); $('.zoom-caption', zoom).textContent = caption
  $('.zoom-count', zoom).textContent = zoomShots.length > 1 ? ` ${zoomIndex + 1} of ${zoomShots.length} ` : ''
  const link = $<HTMLAnchorElement>('a', zoom); link.hidden = asset?.type !== 'mock'; link.textContent = asset?.type === 'mock' ? 'Open live mock' : ''
  if (asset?.type === 'mock') link.href = `${endpoint}/assets/${encodeURIComponent(asset.html)}`
  zoom.classList.remove('actual'); zoomImage.style.width = ''; zoomView.scrollTo(0, 0)
  zoomImage.alt = image.alt
  zoomImage.src = asset?.type === 'mock' ? `${endpoint}/assets/${encodeURIComponent(matchMedia('(prefers-color-scheme: dark)').matches && asset.dark ? asset.dark : asset.light)}` : image.src
}
function openZoom(button: HTMLButtonElement) {
  zoomFigureIndex = [...doc.querySelectorAll('figure.fig.shots')].indexOf(button.closest('figure')!)
  zoomShots = [...button.closest('figure')!.querySelectorAll<HTMLButtonElement>('button.shot')]; zoomIndex = zoomShots.indexOf(button); zoomScroll = scrollY
  zoom.hidden = false; document.body.classList.add('zoom-open'); showZoomShot(); $('button', zoom).focus({ preventScroll: true })
}
function closeZoom() {
  zoom.hidden = true; document.body.classList.remove('zoom-open'); scrollTo({ top: zoomScroll, behavior: 'instant' })
  const stored = zoomShots[zoomIndex]
  const figure = doc.querySelectorAll('figure.fig.shots')[zoomFigureIndex]
  const current = figure && [...figure.querySelectorAll<HTMLButtonElement>('button.shot')]
  const target = stored?.isConnected ? stored : current && (current.find(button => button.dataset.asset === stored?.dataset.asset) || current[zoomIndex])
  target?.focus({ preventScroll: true })
}
function moveZoom(direction: number) { const next = zoomIndex + direction; if (next >= 0 && next < zoomShots.length) { zoomIndex = next; showZoomShot() } }
$('button', zoom).onclick = closeZoom
zoom.onclick = e => { if (e.target === zoom || e.target === zoomView) closeZoom() }
zoomImage.onclick = () => { const actual = zoom.classList.toggle('actual'); zoomImage.style.width = actual ? `${zoomImage.naturalWidth / devicePixelRatio}px` : '' }
let swipeStart: { x: number; y: number } | null = null
zoom.addEventListener('touchstart', e => { const t = e.touches[0]; swipeStart = { x: t.clientX, y: t.clientY } }, { passive: true })
zoom.addEventListener('touchend', e => { const t = e.changedTouches[0]; if (!zoom.classList.contains('actual') && swipeStart && Math.abs(t.clientX - swipeStart.x) >= 40 && Math.abs(t.clientX - swipeStart.x) > Math.abs(t.clientY - swipeStart.y)) moveZoom(t.clientX < swipeStart.x ? 1 : -1); swipeStart = null }, { passive: true })
document.addEventListener('keydown', e => {
  if (zoom.hidden) return
  e.stopImmediatePropagation()
  if (['Escape', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) e.preventDefault()
  if (e.key === 'Escape') closeZoom()
  else if (e.key === 'ArrowLeft') moveZoom(-1)
  else if (e.key === 'ArrowRight') moveZoom(1)
  else if (e.key === 'Tab') { const controls = [...zoom.querySelectorAll<HTMLElement>('a:not([hidden]),button')]; const i = controls.indexOf(document.activeElement as HTMLElement); controls[(i + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus() }
})
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return
  const target = e.target
  if (!(target instanceof HTMLTextAreaElement) || !target.matches('textarea[data-draft]')) return
  e.preventDefault()
  const button = target.closest('.reply')?.querySelector<HTMLElement>('.btn.primary[data-action]')
  if (button) void action(button.dataset.action!, button)
})
document.addEventListener('click', e => {
  const target = e.target as HTMLElement
  const shot = target.closest<HTMLButtonElement>('button.shot'); if (shot) { openZoom(shot); return }
  if (!zoom.hidden) return
  const demo = target.closest<HTMLButtonElement>('button.demo-try')
  if (demo) {
    const stage = demo.closest<HTMLElement>('.demo-stage')!, frame = document.createElement('iframe')
    frame.src = stage.dataset.src!; frame.setAttribute('sandbox', stage.dataset.sandbox!); if (stage.dataset.allow) frame.setAttribute('allow', stage.dataset.allow)
    frame.referrerPolicy = 'no-referrer'; frame.title = stage.dataset.title || 'Demo'; frame.loading = 'lazy'
    stage.replaceChildren(frame); layout(); return
  }
  const figureButton = target.closest<HTMLButtonElement>('button.fig-comment')
  if (figureButton) {
    const figure = figureButton.closest('figure')!, caption = figure.querySelector('figcaption')!
    const range = document.createRange(); range.selectNodeContents(caption)
    const anchor = anchorFromRange(range) as Anchor | null
    if (!anchor) return
    const video = figure.querySelector('video')
    if (video && video.currentTime >= .5) anchor.t = Math.round(video.currentTime * 10) / 10
    composing = anchor; selection = null; selectionTop = figure.getBoundingClientRect().top + scrollY
    renderCards(); $('.composer textarea', phone() ? sheet : cards).focus(); return
  }
  const button = target.closest<HTMLElement>('[data-action]')
  if (button) { void action(button.dataset.action!, button); return }
  const go = target.closest<HTMLElement>('[data-go]'); if (go) { step(Number(go.dataset.go)); return }
  const mark = target.closest<HTMLElement>('mark[data-t]'); if (mark && (!mark.classList.contains('resolved') || showResolved)) { focus(mark.dataset.t!); seekMoment(mark.dataset.t!); return }
  const node = target.closest<HTMLElement>('.card[data-t]'); if (node && !target.closest('textarea,button,details')) { focus(node.dataset.t!, true); seekMoment(node.dataset.t!) }
})
document.addEventListener('input', e => { const input = e.target as HTMLTextAreaElement; if (!input.dataset.draft) return; drafts.set(input.dataset.draft, input.value); const reply = input.closest('.card')?.querySelector<HTMLButtonElement>('[data-action="reply"]'); if (reply) { reply.hidden = !phone() && !input.value.trim(); reply.disabled = pending.has(input.dataset.draft) || !input.value.trim() }; layout() })
let selectionTimer = 0
for (const event of ['selectionchange', 'pointerup', 'mouseup']) document.addEventListener(event, () => { clearTimeout(selectionTimer); selectionTimer = window.setTimeout(readSelection, 80) })
$('#prev').onclick = $('#chipPrev').onclick = () => step(-1)
$('#next').onclick = $('#chipNext').onclick = () => step(1)
$('#openLabel').onclick = () => focus(open().some(t => t.id === focused) ? focused : open()[0]?.id || null, true)
$('#scrim').onclick = closeSheet
$('#showResolved').onchange = e => { showResolved = (e.target as HTMLInputElement).checked; storage.set('scope:showResolved', String(showResolved)); renderCards() }
document.addEventListener('keydown', e => { if (!zoom.hidden) return; if (e.key === 'Escape') { closeSheet(); return }; if ((e.target as HTMLElement).closest('textarea,input,[contenteditable]')) return; if (e.key === 'j') step(1); if (e.key === 'k') step(-1) })
addEventListener('resize', layout); document.fonts.ready.then(layout)
let scrollTimer = 0
addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = window.setTimeout(() => { if (!zoom.hidden) return; showSelection(); const current = focused && marks(focused).find(m => !hidden(m))?.getBoundingClientRect(); if (current && current.bottom >= 52 && current.top <= innerHeight) return; const next = open().find(t => marks(t.id).some(m => { if (hidden(m)) return false; const r = m.getBoundingClientRect(); return r.bottom >= 52 && r.top < innerHeight })); if (next) focus(next.id, false, false) }, 180) })
function context() { const sections = [...doc.querySelectorAll<HTMLElement>('section[data-section]')]; const section = sections.filter(n => n.getBoundingClientRect().top <= innerHeight * .3).at(-1) || sections[0]; return { thread: focused, section: section?.id || null, selection } }
function voiceUi(ui: ScopeVoiceUi) { if (ui.do === 'focus_thread') focus(ui.thread, true); if (ui.do === 'focus_section') document.getElementById(ui.section)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); if (ui.do === 'show_resolved') { showResolved = ui.on; storage.set('scope:showResolved', String(showResolved)); renderCards() }; if (ui.do === 'scroll') scrollBy({ top: innerHeight * .8 * (ui.direction === 'up' ? -1 : 1), behavior: 'smooth' }) }
const feedRows: (ScopeFeedLine & { at: Date })[] = []
let feedExpanded = false, feedClosed = false
const feed = document.createElement('div')
feed.className = 'voice-feed'; feed.setAttribute('aria-live', 'polite'); feed.setAttribute('aria-label', 'Voice activity'); feed.hidden = true
if (!embed) document.body.append(feed)
function positionFeed() {
  const capsule = document.querySelector<HTMLElement>('.voice-capsule')
  const bottom = capsule ? innerHeight - capsule.getBoundingClientRect().top + 8 : phone() ? 84 : 24
  feed.style.bottom = `${bottom}px`
}
const capsuleObserver = new ResizeObserver(positionFeed)
new MutationObserver(() => { const capsule = document.querySelector('.voice-capsule'); capsuleObserver.disconnect(); if (capsule) capsuleObserver.observe(capsule); positionFeed() }).observe($('#voiceRoot'), { childList: true, subtree: true })
addEventListener('resize', () => { renderFeed(); positionFeed() })
function renderFeed() {
  feed.hidden = feedClosed || !feedRows.length
  if (feed.hidden) return
  const limit = phone() ? 2 : 6
  const visible = feedExpanded ? feedRows : feedRows.slice(-limit)
  feed.innerHTML = `<div class="voice-feed-controls"><span class="voice-feed-heading">Voice activity</span>${feedRows.length > limit ? `<button class="voice-feed-toggle">${feedExpanded ? 'Show less' : `Show all (${feedRows.length})`}</button>` : ''}<button class="voice-feed-close" aria-label="Close voice activity">×</button></div><div class="voice-feed-list${feedExpanded ? ' expanded' : ''}">${visible.map(row => `<button class="voice-feed-row" data-ok="${row.ok}"${row.write ? ' data-write' : ''}${row.thread ? ` data-thread="${esc(row.thread)}"` : ''} title="${esc(row.at.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET')}"><span class="voice-feed-dot" aria-hidden="true"></span><span class="voice-feed-label">${esc(row.label)}</span>${row.write && row.thread ? `<span class="voice-feed-delivery">${esc(delivery(row.thread) === 'With the lane' || delivery(row.thread) === 'In the doc' ? 'Sent to the lane' : delivery(row.thread))}</span>` : ''}</button>`).join('')}</div>`
  feed.querySelector<HTMLButtonElement>('.voice-feed-toggle')?.addEventListener('click', () => { feedExpanded = !feedExpanded; renderFeed() })
  feed.querySelector<HTMLButtonElement>('.voice-feed-close')!.onclick = () => { feedClosed = true; renderFeed() }
  feed.querySelectorAll<HTMLButtonElement>('.voice-feed-row[data-thread]').forEach(row => row.onclick = () => {
    const id = row.dataset.thread!, thread = scope?.threads.find(t => t.id === id)
    if (thread && thread.status !== 'open') { showResolved = true; storage.set('scope:showResolved', 'true'); renderCards() }
    focus(id, true)
  })
  positionFeed()
}
function onFeed(line: ScopeFeedLine) { feedRows.push({ ...line, at: new Date() }); if (feedRows.length > 50) feedRows.shift(); renderFeed() }
$('#talk').hidden = boot.voice === false
$('#talk').onclick = async () => { if (boot.voice === false) return; try { const audio = prepareAudio(); const { mountVoice } = await import('./voice-mount'); mountVoice(audio, { getScope: async () => ({ slug, scope: scope! }), getContext: context, postThread, postReply, postResolve, postReject, postPark, onFeed }, voiceUi, active => { if (active) { feedRows.length = 0; feedExpanded = false; feedClosed = false; renderFeed() }; $('#talk').classList.toggle('active', active) }) } catch (error) { $('#live').textContent = error instanceof Error ? error.message : 'Voice unavailable' } }
let lastPayload = ''
function accept(payload: { scope: ScopeV2; notes?: any[]; error?: string }) { if (!payload.scope) { lastPayload = ''; doc.textContent = payload.error || 'The lane has not published a doc yet.'; return }; const fingerprint = JSON.stringify(payload); if (fingerprint === lastPayload) return; lastPayload = fingerprint
  scope = payload.scope
  const settled = new Set(scope.threads.flatMap(t => [...t.messages.map(m => (m as any).client_id), (t.resolution as any)?.client_id, (t as any).parked_client_id]))
  for (const [key, item] of sending) if (settled.has(item.clientId)) sending.delete(key)
  for (const note of payload.notes || []) notes.set(note.id, note); render() }
async function start() {
  if (!slug) { const { scopes } = await api<{ scopes: any[] }>(apiBase); doc.innerHTML = `<h1>Scoping</h1>${scopes.map(s => `<a class="index-row" href="/s/${esc(s.slug)}">${esc(s.title || s.slug)}</a>`).join('')}`; return }
  const poll = async () => { try { accept(await api(endpoint)); $('#live').textContent = 'Live' } catch { $('#live').textContent = 'Reconnecting' } }
  if (boot.events === false) { await poll(); setInterval(() => void poll(), 2000); return }
  accept(await api(endpoint)); $('#live').textContent = 'Live'
  const events = new EventSource(`${endpoint}/events`)
  events.addEventListener('state', e => accept(JSON.parse((e as MessageEvent).data)))
  events.addEventListener('scope', e => { const data = JSON.parse((e as MessageEvent).data); accept(data.scope ? data : { scope: data }) })
  events.addEventListener('note', e => { const note = JSON.parse((e as MessageEvent).data); notes.set(note.id, note); render() })
  events.onopen = () => $('#live').textContent = 'Live'; events.onerror = () => $('#live').textContent = 'Reconnecting'
}
void start().catch(error => { doc.textContent = `Could not load: ${error.message}`; $('#live').textContent = 'Reconnecting' })
