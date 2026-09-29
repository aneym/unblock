import './scope.css'
import { orderThreads, type ScopeV2, type Thread } from '../../../src/scope-doc.js'
import { locateAnchor, type Anchor } from '../../../src/scope-anchor.js'
import { anchorFromRange, sectionText, rangeFromAnchor } from './dom-anchor'
import { esc, markdown, renderMermaid } from './markdown'
import { prepareAudio } from '../lib/voice-audio'
import type { ScopeVoiceUi, ScopeFeedLine } from '../../../src/scope-voice.js'

const $ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)!
const slug = (window as any).__SCOPE_BOOT__?.slug || location.pathname.match(/^\/s\/([^/]+)/)?.[1]
document.body.classList.toggle('embed', new URLSearchParams(location.search).get('embed') === '1')
const doc = $('#doc'), cards = $('#cards'), detached = $('#detached'), sheet = $('#sheet')
const phone = () => matchMedia('(max-width:899px)').matches
const storage = { get(key: string) { try { return localStorage.getItem(key) } catch { return null } }, set(key: string, value: string) { try { localStorage.setItem(key, value) } catch {} } }
const time = (iso: string) => `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`
let scope: ScopeV2 | null = null, focused: string | null = null, initialized = false
let showResolved = storage.get('scope:showResolved') === 'true'
let selection: Anchor | null = null, selectionTop = 0, composing: Anchor | null = null
const pending = new Set<string>()
function disablePending() { document.querySelectorAll<HTMLElement>('.card').forEach(card => { const key = card.classList.contains('composer') ? 'composer' : card.dataset.t; if (key && pending.has(key)) card.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button => button.disabled = true) }) }
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
const endpoint = `/api/scope/${encodeURIComponent(slug)}`
function upsert(thread: Thread) {
  if (!scope) return
  const i = scope.threads.findIndex(t => t.id === thread.id)
  if (i < 0) scope.threads.push(thread); else scope.threads[i] = thread
  render()
}
async function postThread(body: { anchor: Anchor; text: string; via?: 'voice' }) { const result = await api<{ thread: Thread }>(`${endpoint}/threads`, body); upsert(result.thread); return result }
async function postReply(id: string, body: { text: string; via?: 'voice' }) { const result = await api<{ thread: Thread }>(`${endpoint}/threads/${id}/reply`, body); upsert(result.thread); return result }
async function postResolve(id: string, body: { decision: string; alex_words?: string; how?: 'take' | 'own' | 'resolve'; via?: 'voice' }) { const result = await api<{ thread: Thread }>(`${endpoint}/threads/${id}/resolve`, body); upsert(result.thread); return result }
async function postReject(id: string, body: { text: string; via?: 'voice' }) { const result = await api<{ thread: Thread }>(`${endpoint}/threads/${id}/reject`, body); upsert(result.thread); return result }
async function postPark(id: string, body: { via?: 'voice' } = {}) { const result = await api<{ thread: Thread }>(`${endpoint}/threads/${id}/park`, body); upsert(result.thread); return result }
function delivery(id: string) {
  const note = [...notes.values()].filter(n => n.thread === id).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1)
  return note ? ({ delivered: 'Sent to the lane', sending: 'Sent to the lane', queued: 'Sent to the lane', retrying: 'Retrying', no_pane: 'No pane' } as Record<string, string>)[note.delivery] || 'Retrying' : ''
}
function cardHtml(t: Thread) {
  const isOpen = t.status === 'open', label = t.status === 'parked' ? 'Parked' : !isOpen ? 'Resolved' : t.kind === 'question' ? 'Lane asks' : 'You commented'
  const lastAlex = t.messages.map(m => m.from).lastIndexOf('alex')
  const mode = modes.get(t.id) || (t.kind === 'comment' ? 'reply' : null)
  const compose = mode && { no: ["What's wrong with it? (optional)", 'Send No'], else: ['Your answer', 'Send answer'], reply: [t.kind === 'question' ? 'Ask the lane something' : 'Reply', t.kind === 'question' ? 'Send' : 'Reply'] }[mode]
  const menu = isOpen && menus.has(t.id) ? `<div class="menu" role="menu">${t.kind === 'question' ? '<button role="menuitem" data-action="menu-reply">Reply</button>' : ''}<button role="menuitem" data-action="resolve">Resolve</button>${t.kind === 'question' ? '<button role="menuitem" class="tall" data-action="park">Not now<small>Park it without answering</small></button>' : ''}</div>` : ''
  let body = ''
  if (isOpen && compose) body = `<div class="reply only-on"><textarea data-draft="${t.id}" rows="${modes.has(t.id) ? 2 : 1}" placeholder="${esc(compose[0])}">${esc(drafts.get(t.id))}</textarea><p class="error" role="alert">${esc(errors.get(t.id))}</p><div class="actions"><button class="btn primary" data-action="${t.kind === 'comment' ? 'reply' : 'send'}">${compose[1]}</button>${modes.has(t.id) ? '<button class="btn" data-action="cancel">Cancel</button>' : ''}</div></div>`
  else if (isOpen && t.rejected_at) body = '<div class="waiting"><span class="dot"></span>Rejected, waiting for a new option</div>'
  else if (isOpen && t.kind === 'question') body = t.recommendation ? '<div class="choices only-on"><button class="btn" data-action="take">Take it</button><button class="btn" data-action="no">No</button><button class="btn" data-action="else">Something else</button></div>' : '<div class="choices only-on"><button class="btn one" data-action="else">Answer</button></div>'
  const newRec = !t.rejected_at && t.messages.some(m => m.kind === 'option')
  return `<div class="head"><span class="kind"><span class="dot ${isOpen ? t.kind : 'resolved'}"></span><span class="who">${label}</span></span><span class="when">${time(t.created_at)}</span>${isOpen ? '<button class="more" data-action="menu" aria-label="More" aria-haspopup="menu">⋯</button>' : ''}</div>${menu}<div class="q">${esc(t.messages[0]?.text)}</div>
  ${isOpen && t.recommendation ? `<div class="rec${newRec ? ' new' : ''}"><span class="lbl">Recommended</span><span class="txt">${esc(t.recommendation)}</span></div>` : ''}
  ${isOpen && t.kind === 'question' && t.options?.length ? `<div class="other-options only-on"><span class="lbl">Other options</span>${t.options.slice(1).map((option, i) => `<button data-action="option" data-option="${i + 1}">${esc(option)}</button>`).join('')}</div>` : ''}
  ${isOpen && t.why ? `<details class="why only-on"><summary>Why</summary><p>${esc(t.why)}</p></details>` : ''}
  ${t.messages.length > 1 ? `<div class="msgs only-on">${t.messages.slice(1).map((m, i) => `<div class="msg"><div class="from">${m.from === 'alex' ? 'You' : 'Lane'}<span>${time(m.at)}</span></div><div>${m.kind === 'reject' ? 'No' + (m.text ? ': ' : '') : ''}${esc(m.text)}</div>${i + 1 === lastAlex && delivery(t.id) ? `<div class="delivery">${delivery(t.id)}</div>` : ''}</div>`).join('')}</div>` : ''}
  ${t.status === 'parked' ? '<div class="settled"><b>Parked.</b> Not answered; the lane leaves it for later.</div>' : t.status === 'resolved' ? `<div class="settled"><b>Resolved:</b> ${esc(t.resolution?.decision)}${!t.resolution?.confirmed_at ? '<span class="wait">Sent to the lane. It will update the doc to say so.</span>' : ''}</div>` : ''}${body}${!compose && errors.has(t.id) ? `<p class="error" role="alert">${esc(errors.get(t.id))}</p>` : ''}`
}
function card(t: Thread) {
  const node = document.createElement('div'); node.className = `card ${t.kind} ${t.status}${focused === t.id ? ' on' : ''}`; node.dataset.t = t.id; node.innerHTML = cardHtml(t); return node
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
function render() {
  if (!scope) return
  const active = document.activeElement as HTMLTextAreaElement | null, activeKey = active?.dataset.draft, caret = active?.selectionStart
  const scroll = scrollY
  if (!initialized) { focused = phone() ? null : open().find(t => t.anchor.section !== 'ask')?.id || null; initialized = true }
  const askOpen = doc.querySelector<HTMLDetailsElement>('.ask-fold')?.open || false
  doc.innerHTML = scope.doc.sections.map(s => `<section id="${esc(s.id)}" data-section>${s.id === 'ask' ? `<details class="ask-fold"${askOpen ? ' open' : ''}><summary><svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><h2>${esc(s.heading)}</h2></summary><div class="body">${markdown(s.body_md)}</div></details>` : `${s.id === 'title' ? '<p class="eyebrow" data-cm-skip>Scoping</p>' : ''}<${s.id === 'title' ? 'h1' : 'h2'}>${esc(s.heading)}</${s.id === 'title' ? 'h1' : 'h2'}><div class="body ${s.id === 'title' ? 'lede' : ''}">${markdown(s.body_md)}</div>${s.id === 'title' ? `<p class="meta" data-cm-skip>Revision ${scope!.revision} · Updated ${time(scope!.updated_at)}</p>` : ''}`}</section>`).join('')
  doc.querySelector('.ask-fold')?.addEventListener('toggle', layout)
  document.title = scope.title; highlight(); renderCards(); renderFeed(); void renderMermaid(doc, layout)
  scrollTo({ top: scroll, behavior: 'instant' })
  if (activeKey) { const target = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')].find(n => n.dataset.draft === activeKey && n.getClientRects().length); target?.focus({ preventScroll: true }); if (caret != null) target?.setSelectionRange(caret, caret) }
}
function renderCards() {
  const visible = ordered().filter(t => t.status === 'open' || showResolved)
  cards.replaceChildren(...visible.filter(t => !missing.has(t.id)).map(card))
  detached.replaceChildren()
  const gone = visible.filter(t => missing.has(t.id))
  if (gone.length) { detached.append('Detached · the text it was on changed', ...gone.map(card)) }
  if (composing) renderComposer()
  document.body.classList.toggle('show-resolved', showResolved)
  const toggle = $<HTMLInputElement>('#showResolved'); toggle.checked = showResolved; toggle.toggleAttribute('checked', showResolved)
  if (!composing && phone() && document.body.classList.contains('sheet-open')) renderSheet()
  updateCount(); layout(); disablePending()
}
function layout() {
  if (phone()) return
  const base = cards.getBoundingClientRect().top
  const nodes = [...cards.querySelectorAll<HTMLElement>(':scope > .card')]
  const want = nodes.map(n => {
    const mark = marks(n.dataset.t!)[0], anchor = mark && !hidden(mark) && mark.getClientRects().length ? mark : mark?.closest('details:not([open])')?.querySelector('summary')
    return Math.max(8, (n.classList.contains('composer') ? selectionTop : anchor ? anchor.getBoundingClientRect().top + scrollY : base + scrollY) - scrollY - base - 12)
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
function focus(id: string | null, scroll = false, openSheet = true) {
  focused = id
  if (id && scope?.threads.some(t => t.id === id && t.status === 'open' && t.anchor.section === 'ask')) { const fold = doc.querySelector<HTMLDetailsElement>('.ask-fold'); if (fold) fold.open = true }
  document.querySelectorAll<HTMLElement>('.card[data-t],mark[data-t]').forEach(n => n.classList.toggle('on', n.dataset.t === id))
  if (id && scroll) { const mark = marks(id)[0]; if (mark) { if (phone()) scrollTo({ top: scrollY + mark.getBoundingClientRect().top - 96, behavior: 'instant' }); else mark.scrollIntoView({ block: 'center', behavior: 'smooth' }); mark.classList.remove('flash'); void mark.offsetWidth; mark.classList.add('flash') } }
  if (phone() && id && openSheet) { document.body.classList.add('sheet-open'); renderSheet(); const mark = marks(id)[0]; if (mark) scrollTo({ top: scrollY + mark.getBoundingClientRect().top - 96, behavior: 'instant' }) }
  updateCount(); layout()
}
function step(direction: number) { const list = open(); if (!list.length) return; const index = list.findIndex(t => t.id === focused); focus(list[Math.max(0, Math.min(list.length - 1, index < 0 ? 0 : index + direction))].id, true) }
function renderSheet() {
  const t = scope?.threads.find(t => t.id === focused); if (!t) { closeSheet(); return }
  const i = open().findIndex(x => x.id === t.id)
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
  const sel = getSelection(); if (!sel?.rangeCount || sel.isCollapsed) { if (!document.activeElement?.closest('.card,.add')) { selection = null; showSelection() } return }
  const range = sel.getRangeAt(0), anchor = anchorFromRange(range)
  if (anchor) { selection = anchor; selectionTop = range.getBoundingClientRect().top + scrollY; showSelection() }
}
function renderComposer() {
  const node = document.createElement('div'); node.className = 'card composer comment on'; node.innerHTML = `<div class="head"><span class="dot comment"></span><span class="who">You commented</span></div><div class="reply"><textarea rows="2" data-draft="composer" placeholder="Comment on this text">${esc(drafts.get('composer'))}</textarea><p class="error">${esc(errors.get('composer'))}</p><div class="actions"><button class="btn primary" data-action="post">Comment</button><button class="btn" data-action="cancel">Cancel</button></div></div>`
  if (phone()) { sheet.replaceChildren(node); document.body.classList.add('sheet-open') }
  else { const range = composing && rangeFromAnchor(composing)?.range; const after = [...cards.children].find(n => { const mark = marks((n as HTMLElement).dataset.t!)[0]; return range && mark && range.comparePoint(mark.firstChild!, 0) > 0 }); cards.insertBefore(node, after || null) }
}
async function action(name: string, target: HTMLElement) {
  if (name === 'comment') { composing = selection; renderCards(); $('.composer textarea', phone() ? sheet : cards).focus(); return }
  const id = target.closest<HTMLElement>('[data-t]')?.dataset.t, t = scope?.threads.find(t => t.id === id), key = name === 'post' ? 'composer' : id!
  if (pending.has(key)) return
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
    if (name === 'post' && composing && text) { const anchor = composing; const result = await api<{ thread: Thread }>(`${endpoint}/threads`, { anchor, text }); composing = null; selection = null; drafts.delete(key); upsert(result.thread); focus(result.thread.id); return }
    if (!t) return
    if (name === 'reply' || name === 'send' && mode === 'reply') await postReply(t.id, { text })
    else if (name === 'send' && mode === 'no') await postReject(t.id, { text })
    else if (name === 'send' && mode === 'else') await postResolve(t.id, { decision: text, alex_words: text, how: 'own' })
    else if (name === 'take' && t.recommendation) await postResolve(t.id, { decision: t.recommendation, alex_words: 'Take the recommendation', how: 'take' })
    else if (name === 'resolve') await postResolve(t.id, { decision: 'Resolved', alex_words: 'Resolved', how: 'resolve' })
    else if (name === 'park') await postPark(t.id)
    if ((drafts.get(key) || '').trim() === text) drafts.delete(key); errors.delete(key); modes.delete(t.id); menus.delete(t.id)
    if (['take', 'resolve', 'park'].includes(name) || name === 'send' && mode === 'else') { closeSheet(); focused = open()[0]?.id || null }
    renderCards()
  } catch (error) { errors.set(key, error instanceof Error ? error.message : 'Could not send') }
  finally { pending.delete(key); renderCards() }
}
document.addEventListener('click', e => {
  const target = e.target as HTMLElement, button = target.closest<HTMLElement>('[data-action]')
  if (button) { void action(button.dataset.action!, button); return }
  const go = target.closest<HTMLElement>('[data-go]'); if (go) { step(Number(go.dataset.go)); return }
  const mark = target.closest<HTMLElement>('mark[data-t]'); if (mark && (!mark.classList.contains('resolved') || showResolved)) { focus(mark.dataset.t!); return }
  const node = target.closest<HTMLElement>('.card[data-t]'); if (node && !target.closest('textarea,button,details')) focus(node.dataset.t!, true)
})
document.addEventListener('input', e => { const input = e.target as HTMLTextAreaElement; if (!input.dataset.draft) return; drafts.set(input.dataset.draft, input.value); const reply = input.closest('.card')?.querySelector<HTMLButtonElement>('[data-action="reply"]'); if (reply) { reply.hidden = !phone() && !input.value.trim(); reply.disabled = pending.has(input.dataset.draft) || !input.value.trim() }; layout() })
let selectionTimer = 0
for (const event of ['selectionchange', 'pointerup', 'mouseup']) document.addEventListener(event, () => { clearTimeout(selectionTimer); selectionTimer = window.setTimeout(readSelection, 80) })
$('#prev').onclick = $('#chipPrev').onclick = () => step(-1)
$('#next').onclick = $('#chipNext').onclick = () => step(1)
$('#openLabel').onclick = () => focus(open().some(t => t.id === focused) ? focused : open()[0]?.id || null, true)
$('#scrim').onclick = closeSheet
$('#showResolved').onchange = e => { showResolved = (e.target as HTMLInputElement).checked; storage.set('scope:showResolved', String(showResolved)); renderCards() }
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); return }; if ((e.target as HTMLElement).closest('textarea,input,[contenteditable]')) return; if (e.key === 'j') step(1); if (e.key === 'k') step(-1) })
addEventListener('resize', layout); document.fonts.ready.then(layout)
let scrollTimer = 0
addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = window.setTimeout(() => { showSelection(); const current = focused && marks(focused).find(m => !hidden(m))?.getBoundingClientRect(); if (current && current.bottom >= 52 && current.top <= innerHeight) return; const next = open().find(t => marks(t.id).some(m => { if (hidden(m)) return false; const r = m.getBoundingClientRect(); return r.bottom >= 52 && r.top < innerHeight })); if (next) focus(next.id, false, false) }, 180) })
function context() { const sections = [...doc.querySelectorAll<HTMLElement>('section[data-section]')]; const section = sections.filter(n => n.getBoundingClientRect().top <= innerHeight * .3).at(-1) || sections[0]; return { thread: focused, section: section?.id || null, selection } }
function voiceUi(ui: ScopeVoiceUi) { if (ui.do === 'focus_thread') focus(ui.thread, true); if (ui.do === 'focus_section') document.getElementById(ui.section)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); if (ui.do === 'show_resolved') { showResolved = ui.on; storage.set('scope:showResolved', String(showResolved)); renderCards() }; if (ui.do === 'scroll') scrollBy({ top: innerHeight * .8 * (ui.direction === 'up' ? -1 : 1), behavior: 'smooth' }) }
const feedRows: (ScopeFeedLine & { at: Date })[] = []
let feedExpanded = false, feedClosed = false
const feed = document.createElement('div')
feed.className = 'voice-feed'; feed.setAttribute('aria-live', 'polite'); feed.setAttribute('aria-label', 'Voice activity'); feed.hidden = true
if (new URLSearchParams(location.search).get('embed') !== '1') document.body.append(feed)
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
  feed.innerHTML = `<div class="voice-feed-controls"><span class="voice-feed-heading">Voice activity</span>${feedRows.length > limit ? `<button class="voice-feed-toggle">${feedExpanded ? 'Show less' : `Show all (${feedRows.length})`}</button>` : ''}<button class="voice-feed-close" aria-label="Close voice activity">×</button></div><div class="voice-feed-list${feedExpanded ? ' expanded' : ''}">${visible.map(row => `<button class="voice-feed-row" data-ok="${row.ok}"${row.write ? ' data-write' : ''}${row.thread ? ` data-thread="${esc(row.thread)}"` : ''} title="${esc(row.at.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET')}"><span class="voice-feed-dot" aria-hidden="true"></span><span class="voice-feed-label">${esc(row.label)}</span>${row.write && row.thread ? `<span class="voice-feed-delivery">${esc(delivery(row.thread))}</span>` : ''}</button>`).join('')}</div>`
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
$('#talk').onclick = async () => { try { const audio = prepareAudio(); const { mountVoice } = await import('./voice-mount'); mountVoice(audio, { getScope: async () => ({ slug, scope: scope! }), getContext: context, postThread, postReply, postResolve, postReject, postPark, onFeed }, voiceUi, active => { if (active) { feedRows.length = 0; feedExpanded = false; feedClosed = false; renderFeed() }; $('#talk').classList.toggle('active', active) }) } catch (error) { $('#live').textContent = error instanceof Error ? error.message : 'Voice unavailable' } }
function accept(payload: { scope: ScopeV2; notes?: any[]; error?: string }) { if (!payload.scope) { doc.textContent = payload.error || 'The lane has not published a doc yet.'; return }; scope = payload.scope; for (const note of payload.notes || []) notes.set(note.id, note); render() }
async function start() {
  if (!slug) { const { scopes } = await api<{ scopes: any[] }>('/api/scope'); doc.innerHTML = `<h1>Scoping</h1>${scopes.map(s => `<a class="index-row" href="/s/${esc(s.slug)}">${esc(s.title || s.slug)}</a>`).join('')}`; return }
  accept(await api(endpoint)); $('#live').textContent = 'Live'
  const events = new EventSource(`${endpoint}/events`)
  events.addEventListener('state', e => accept(JSON.parse((e as MessageEvent).data)))
  events.addEventListener('scope', e => { const data = JSON.parse((e as MessageEvent).data); accept(data.scope ? data : { scope: data }) })
  events.addEventListener('note', e => { const note = JSON.parse((e as MessageEvent).data); notes.set(note.id, note); render() })
  events.onopen = () => $('#live').textContent = 'Live'; events.onerror = () => $('#live').textContent = 'Reconnecting'
}
void start().catch(error => { doc.textContent = `Could not load: ${error.message}`; $('#live').textContent = 'Reconnecting' })
