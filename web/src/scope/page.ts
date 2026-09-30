import './scope.css'
import { orderThreads, type ScopeV2, type Thread, type DocSection, type ScopeApproval, type CommentImage } from '../../../src/scope-doc.js'
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
const storage = { get(key: string) { try { return localStorage.getItem(key) } catch { return null } }, set(key: string, value: string) { try { localStorage.setItem(key, value) } catch {} }, remove(key: string) { try { localStorage.removeItem(key) } catch {} } }
const time = (iso: string) => `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`
let scope: ScopeV2 | null = null, focused: string | null = null, initialized = false
let showResolved = storage.get('scope:showResolved') === 'true'
let selection: Anchor | null = null, selectionTop = 0, composing: Anchor | null = null
let selectionRange: Range | null = null, selectionScrolling = false
type Sending = { clientId: string; id?: string; anchor?: Anchor; text: string; at: number }
const sending = new Map<string, Sending>()
const pending = new Set<string>()
function disablePending() { document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]').forEach(box => { if (uploading.get(box.dataset.draft!)) { const button = box.closest('.reply')?.querySelector<HTMLButtonElement>('.btn.primary'); if (button) button.disabled = true; box.closest('.reply')?.querySelectorAll<HTMLButtonElement>('[data-action="take"],[data-action="no"],[data-action="else"]').forEach(button => button.disabled = true) } }); document.querySelectorAll<HTMLElement>('.card').forEach(card => { const key = card.classList.contains('composer') ? card.querySelector<HTMLElement>('[data-draft]')?.dataset.draft : card.dataset.t; if (key && (pending.has(key) || sending.has(key))) card.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button => button.disabled = true) }) }
type AskChoice = { action: 'take' | 'option' | 'no' | 'else'; label: string; option?: number }
const askDecisions = new Map<string, { choice: AskChoice; note: string; timer: number }>(), askSuggestions = new Map<string, AskChoice | null>(), picking = new Set<string>()
const modes = new Map<string, 'no' | 'else' | 'reply'>(), menus = new Set<string>()
function focusBox(id: string) {
  const input = (phone() ? sheet : document).querySelector<HTMLTextAreaElement>(`.card[data-t="${id}"] textarea`)
  if (input && document.activeElement !== input) input.focus({ preventScroll: true })
}
const drafts = new Map<string, string>(), errors = new Map<string, string>(), notes = new Map<string, any>(), missing = new Set<string>()
function draftStorageKey(key: string) { return `scope:draft:${slug}:${key}` }
function getDraft(key: string) { return drafts.get(key) ?? storage.get(draftStorageKey(key)) ?? '' }
function setDraft(key: string, value: string) { drafts.set(key, value); storage.set(draftStorageKey(key), value) }
function deleteDraft(key: string) { drafts.delete(key); storage.remove(draftStorageKey(key)); saveImages(key, []); updateImageBox(key); document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]').forEach(input => { if (input.dataset.draft === key) input.value = '' }) }
const draftImages = new Map<string, CommentImage[]>()
const uploading = new Map<string, number>()
function imageStorageKey(key: string) { return `scope:draft-images:${slug}:${key}` }
function getImages(key: string): CommentImage[] {
  if (!draftImages.has(key)) {
    try { const value = JSON.parse(storage.get(imageStorageKey(key)) || '[]'); draftImages.set(key, Array.isArray(value) ? value.filter(image => /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/.test(image?.id) && image.width > 0 && image.height > 0).slice(0, 6) : []) } catch { draftImages.set(key, []) }
  }
  return draftImages.get(key)!
}
function saveImages(key: string, images: CommentImage[]) { draftImages.set(key, images); if (images.length) storage.set(imageStorageKey(key), JSON.stringify(images)); else storage.remove(imageStorageKey(key)) }
function imageStrip(images: CommentImage[] | undefined, draft = false, key = '') {
  if (!images?.length && !(draft && uploading.get(key))) return draft ? '<div class="thumbs draft"></div>' : ''
  return `<div class="thumbs${draft ? ' draft' : ''}">${(images || []).map((image, i) => draft
    ? `<figure class="thumb"><img src="${endpoint}/assets/${image.id}" alt="Picture ${i + 1}" width="${image.width}" height="${image.height}"><button type="button" data-action="remove-image" data-image="${i}" aria-label="Remove picture">×</button></figure>`
    : `<button type="button" class="thumb" data-action="view-image"><img src="${endpoint}/assets/${image.id}" loading="lazy" alt="Picture ${i + 1} of ${images!.length}" width="${image.width}" height="${image.height}"></button>`).join('')}${draft ? Array.from({ length: uploading.get(key) || 0 }, () => '<figure class="thumb uploading">Uploading…</figure>').join('') : ''}</div>`
}
const attachControl = '<button type="button" class="btn icon" data-action="attach" aria-label="Add image"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 5 5 3-3 4 4"/></svg></button><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-images>'
function updateImageBox(key: string) {
  document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]').forEach(box => {
    if (box.dataset.draft !== key) return
    const reply = box.closest<HTMLElement>('.reply')!
    const strip = reply.querySelector('.thumbs.draft'), holder = document.createElement('div')
    holder.innerHTML = imageStrip(getImages(key), true, key)
    if (strip) strip.replaceWith(holder.firstElementChild!); else box.after(holder.firstElementChild!)
    reply.querySelectorAll<HTMLButtonElement>('[data-action="take"],[data-action="no"],[data-action="else"]').forEach(button => button.disabled = !!uploading.get(key) || pending.has(key) || sending.has(key))
    const error = reply.querySelector('.error'); if (error) error.textContent = errors.get(key) || ''
    const send = reply.querySelector<HTMLButtonElement>('.btn.primary'); if (send) { send.disabled = !!uploading.get(key) || pending.has(key) || sending.has(key); if (send.dataset.action === 'reply' && getImages(key).length) send.hidden = false }
  })
}
async function addImages(box: HTMLTextAreaElement, files: File[]) {
  const key = box.dataset.draft!
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { errors.set(key, 'PNG, JPEG, WebP or GIF only.'); updateImageBox(key); continue }
    if (file.size > 8 * 1024 * 1024) { errors.set(key, 'That picture is over 8 MB.'); updateImageBox(key); continue }
    if (getImages(key).length + (uploading.get(key) || 0) >= 6) { errors.set(key, 'Up to 6 pictures per message.'); updateImageBox(key); continue }
    uploading.set(key, (uploading.get(key) || 0) + 1); errors.delete(key); updateImageBox(key)
    try {
      let bytes: Blob = file
      if (file.type === 'image/jpeg') {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
        const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close()
        bytes = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not read that image')), 'image/jpeg', 0.9))
      }
      const response = await fetch(`${endpoint}/assets`, { method: 'POST', headers: { 'Content-Type': file.type }, body: bytes })
      if (response.status === 404 || response.status === 405) throw new Error('Pictures need the newer Admin.')
      const image = await response.json(); if (!response.ok) throw new Error(image.error || `HTTP ${response.status}`)
      saveImages(key, [...getImages(key), { id: image.id, width: image.width, height: image.height }])
    } catch (error) { errors.set(key, error instanceof Error ? error.message : 'Could not upload picture') }
    finally { uploading.set(key, Math.max(0, (uploading.get(key) || 1) - 1)); updateImageBox(key) }
  }
}
function imageBox(target: EventTarget | null) { return target instanceof Element ? (target.closest('textarea[data-draft]') || target.closest('.card')?.querySelector('textarea[data-draft]')) as HTMLTextAreaElement | null : null }
document.addEventListener('paste', e => { const box = imageBox(e.target), files = [...(e.clipboardData?.files || [])]; if (box && files.some(file => file.type.startsWith('image/'))) { e.preventDefault(); void addImages(box, files) } })
document.addEventListener('dragover', e => { const box = imageBox(e.target); if (box && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); box.closest('.card')?.classList.add('drop-target') } })
document.addEventListener('dragleave', e => { const card = (e.target as Element)?.closest('.card'); if (card && !card.contains(e.relatedTarget as Node)) card.classList.remove('drop-target') })
document.addEventListener('drop', e => { const box = imageBox(e.target); if (box && e.dataTransfer?.files.length) { e.preventDefault(); box.closest('.card')?.classList.remove('drop-target'); void addImages(box, [...e.dataTransfer.files]) } })
document.addEventListener('change', e => { const input = e.target; if (input instanceof HTMLInputElement && input.matches('[data-images]')) { const box = imageBox(input); if (box) void addImages(box, [...(input.files || [])]); input.value = '' } })
const lightbox = document.createElement('dialog'); lightbox.className = 'lightbox'
lightbox.innerHTML = '<button type="button" data-action="close-lightbox" aria-label="Close">×</button><button type="button" data-action="prev-image" aria-label="Previous picture">←</button><img alt=""><button type="button" data-action="next-image" aria-label="Next picture">→</button>'
document.body.append(lightbox)
let lightboxItems: HTMLButtonElement[] = [], lightboxIndex = 0, lightboxOpener: HTMLButtonElement | null = null
function showLightboxImage() { const image = lightboxItems[lightboxIndex].querySelector('img')!; $<HTMLImageElement>('img', lightbox).src = image.src; $<HTMLImageElement>('img', lightbox).alt = image.alt; lightbox.querySelectorAll<HTMLButtonElement>('[data-action="prev-image"],[data-action="next-image"]').forEach(button => button.hidden = lightboxItems.length < 2) }
function closeLightbox() { lightbox.close(); lightboxOpener?.focus({ preventScroll: true }) }
function moveLightbox(delta: number) { lightboxIndex = (lightboxIndex + delta + lightboxItems.length) % lightboxItems.length; showLightboxImage() }
lightbox.addEventListener('click', e => { if (e.target === lightbox || (e.target as Element).closest('[data-action="close-lightbox"]')) closeLightbox(); else if ((e.target as Element).closest('[data-action="prev-image"]')) moveLightbox(-1); else if ((e.target as Element).closest('[data-action="next-image"]')) moveLightbox(1) })
lightbox.addEventListener('cancel', e => { e.preventDefault(); closeLightbox() })
document.addEventListener('keydown', e => { if (!lightbox.open) return; if (['Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); if (e.key === 'Escape') closeLightbox(); else moveLightbox(e.key === 'ArrowLeft' ? -1 : 1) } })
function composerKey() {
  if (composing?.general) return 'general'
  const key = `composer:${composing?.section}:${composing?.quote}`
  if (draftStorageKey(key).length < 200) return key
  let hash = 2166136261
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `composer:${(hash >>> 0).toString(16)}`
}
let changedComposer: Anchor | null = null
// Keep live controls connected: replace their siblings, never move the kept node.
function replaceAround(root: HTMLElement, nodes: Node[], kept?: HTMLElement | null) {
  if (!kept || kept.parentElement !== root || !nodes.includes(kept)) { root.replaceChildren(...nodes); return }
  for (const node of [...root.childNodes]) if (!nodes.includes(node)) node.remove()
  let cursor = root.firstChild
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling
    else root.insertBefore(node, cursor)
  }
}
function refreshCard(kept: HTMLElement, fresh: HTMLElement) {
  const reply = kept.querySelector<HTMLElement>('.reply'), textarea = reply?.querySelector<HTMLTextAreaElement>('textarea')
  let nextReply = fresh.querySelector<HTMLElement>('.reply')
  if (kept.dataset.t && reply && textarea && (document.activeElement === textarea || textarea.value.trim() || getImages(kept.dataset.t).length || uploading.get(kept.dataset.t)) && (!fresh.classList.contains('open') || !nextReply)) {
    nextReply = document.createElement('div'); nextReply.className = 'reply'; nextReply.dataset.retainedReply = 'true'
    nextReply.innerHTML = `<p class="composer-note">${fresh.classList.contains('parked') ? 'Parked' : 'Resolved'} while you were typing. Sending reopens it.</p><textarea></textarea>${imageStrip(getImages(kept.dataset.t), true, kept.dataset.t)}<p class="error" role="alert">${esc(errors.get(kept.dataset.t))}</p><div class="actions">${attachControl}<button class="btn primary" data-action="reply">${fresh.classList.contains('comment') ? 'Reply' : 'Send'}</button></div>`
    fresh.append(nextReply)
  }
  const nextTextarea = nextReply?.querySelector('textarea'), note = reply?.querySelector<HTMLElement>('.composer-note')
  if (reply && nextReply && textarea && nextTextarea) {
    const nextNote = nextReply.querySelector('.composer-note')
    const strip = reply.querySelector('.thumbs.draft')
    const nodes = [...nextReply.childNodes].flatMap(node => node === nextTextarea ? note && !nextNote && !reply.hasAttribute('data-retained-reply') ? [note, textarea] : [textarea] : node instanceof Element && node.matches('.thumbs.draft') && strip ? [strip] : [node])
    reply.className = nextReply.className
    reply.toggleAttribute('data-retained-reply', nextReply.hasAttribute('data-retained-reply'))
    replaceAround(reply, nodes, textarea)
  }
  kept.className = fresh.className
  kept.toggleAttribute('data-sending', fresh.hasAttribute('data-sending'))
  const nodes = [...fresh.childNodes].map(node => node === nextReply && reply ? reply : node)
  replaceAround(kept, nodes, reply)
  return kept
}
const marks = (id: string) => [...doc.querySelectorAll<HTMLElement>(`mark[data-t="${id}"]`)]
const hidden = (mark: HTMLElement) => !!mark.closest('details:not([open])')
const ordered = () => scope ? orderThreads(scope) : []
const open = () => ordered().filter(t => t.status === 'open')
function recent(t: Thread) { const at = Date.parse(t.resolution?.at || ''); return t.status === 'resolved' && at <= Date.now() && at > Date.now() - 86_400_000 }
function unread(t: Thread) {
  const last = t.messages.at(-1), alex = t.messages.filter(m => m.from === 'alex').at(-1)
  return t.status === 'open' && !!alex && last?.from === 'agent' && Date.parse(last.at) > Date.parse(alex.at) && Date.parse(last.at) > Date.parse(storage.get(`scope:seen:${slug}:${t.id}`) || '1970-01-01')
}
function markSeen(id: string) { const t = scope?.threads.find(t => t.id === id); if (t && unread(t)) storage.set(`scope:seen:${slug}:${id}`, t.messages.at(-1)!.at) }
function syncThreadClasses() {
  for (const t of ordered()) for (const mark of marks(t.id)) { mark.classList.toggle('recent', recent(t)); mark.classList.toggle('unread', unread(t)) }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
  const result = await res.json(); if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`); return result
}
const endpoint = `${apiBase}/${encodeURIComponent(slug)}`
type QueuedApproval = { clientId: string; comment: string; mode: string; failed: boolean; timer?: number }
let queuedApproval: QueuedApproval | null = null
function isApproved() { return scope?.approval?.mode === 'approve' || scope?.approval?.mode === 'approve_with_changes' }
function approvalBanner() {
  if (queuedApproval) return `<div class="approval" data-cm-skip role="status"><strong>${queuedApproval.failed ? "Couldn't approve. Try again." : 'Sending…'}</strong>${queuedApproval.comment ? `<div class="approval-note">${esc(queuedApproval.comment)}</div>` : ''}</div>`
  const a = scope?.approval
  if (!a) return ''
  const label = a.mode === 'approve' ? 'Approved, building' : a.mode === 'approve_with_changes' ? 'Approved with changes, building after the lane folds your note in' : 'Not yet'
  return `<div class="approval" data-cm-skip><strong>${label}</strong> · ${esc(a.at_et)}${a.comment ? `<div class="approval-note">${esc(a.comment)}</div>` : ''}</div>`
}
const approveDialog = document.createElement('dialog')
approveDialog.className = 'approve'
approveDialog.innerHTML = `<h2>Approve this scope</h2><p class="approve-count"></p><fieldset><legend>What happens next?</legend><label><input type="radio" name="approve-mode" value="approve" checked>Approve</label><label><input type="radio" name="approve-mode" value="approve_with_changes">Approve with changes: the lane folds your note in first</label><label><input type="radio" name="approve-mode" value="not_yet">Not yet: just send the note</label></fieldset><label class="approve-note-label" for="approve-note">Final note</label><textarea id="approve-note" placeholder="Anything the builder should know?" maxlength="4000" rows="5"></textarea><p class="error" role="alert"></p><div class="actions"><button type="button" class="btn" data-action="approve-cancel">Cancel</button><button type="button" class="btn primary" data-action="approve-submit">Approve and build</button></div>`
document.body.append(approveDialog)
let approving = false
const approveMode = () => $<HTMLInputElement>('input[name="approve-mode"]:checked', approveDialog).value
function updateApproveDialog() {
  const mode = approveMode(), count = scope?.threads.filter(t => t.status === 'open').length || 0
  $('.approve-count', approveDialog).textContent = mode === 'not_yet' ? 'Threads stay open.' : count === 0 ? 'No open threads.' : `${count} open thread${count === 1 ? ' closes' : 's close'} with the lane's recommendation.`
  const button = $<HTMLButtonElement>('[data-action="approve-submit"]', approveDialog)
  button.textContent = mode === 'approve' ? 'Approve and build' : mode === 'approve_with_changes' ? 'Approve with changes' : 'Send, not yet'
  button.disabled = approving || mode !== 'approve' && !$<HTMLTextAreaElement>('textarea', approveDialog).value.trim()
}
function openApproveDialog() {
  if (!scope || isApproved() || queuedApproval && !queuedApproval.failed || approveDialog.open) return
  $<HTMLInputElement>(`input[value="${queuedApproval?.failed ? queuedApproval.mode : 'approve'}"]`, approveDialog).checked = true
  $<HTMLTextAreaElement>('textarea', approveDialog).value = queuedApproval?.failed ? queuedApproval.comment : ''
  $('.error', approveDialog).textContent = ''
  updateApproveDialog(); approveDialog.showModal(); $<HTMLTextAreaElement>('textarea', approveDialog).focus()
}
async function submitApproval() {
  if ($<HTMLButtonElement>('[data-action="approve-submit"]', approveDialog).disabled) return
  approving = true; updateApproveDialog(); $('.error', approveDialog).textContent = ''
  try {
    const client_id = clientId(), mode = approveMode(), comment = $<HTMLTextAreaElement>('textarea', approveDialog).value
    const result = await api<{ approval?: ScopeApproval; queued?: boolean; client_id?: string }>(`${endpoint}/approve`, { mode, comment, client_id })
    approveDialog.close()
    if (queuedApproval?.timer) clearTimeout(queuedApproval.timer)
    queuedApproval = null
    if (result.queued === true) trackQueuedApproval(result.client_id || client_id, mode, comment)
    else if (scope && result.approval) { scope.approval = result.approval; render(); publishApproval() }
    let refreshed: Parameters<typeof accept>[0] | undefined
    try { refreshed = await api<Parameters<typeof accept>[0]>(endpoint) } catch {}
    if (refreshed) accept(refreshed)
  } catch (error) { $('.error', approveDialog).textContent = error instanceof Error ? error.message : 'Approval failed' }
  finally { approving = false; updateApproveDialog() }
}
approveDialog.addEventListener('input', updateApproveDialog)
approveDialog.addEventListener('change', updateApproveDialog)
approveDialog.addEventListener('click', e => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action
  if (action === 'approve-cancel') approveDialog.close()
  if (action === 'approve-submit') void submitApproval()
})
approveDialog.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); void submitApproval() } })
document.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-action="approve-scope"]')) openApproveDialog() })
window.addEventListener('scope:approve-open', openApproveDialog)
function trackQueuedApproval(clientId: string, mode: string, comment: string) {
  if (queuedApproval?.timer) clearTimeout(queuedApproval.timer)
  const item: QueuedApproval = { clientId, mode, comment, failed: false }
  queuedApproval = item
  settleQueuedApproval()
  if (queuedApproval === item) item.timer = window.setTimeout(() => {
    if (queuedApproval !== item) return
    item.failed = true; render()
  }, 30_000)
  render()
}
function settleQueuedApproval() {
  if (!queuedApproval || !isApproved() && scope?.approval?.client_id !== queuedApproval.clientId) return
  if (queuedApproval.timer) clearTimeout(queuedApproval.timer)
  queuedApproval = null
}
let approvalSignature: string | undefined
function publishApproval() {
  const approval = scope?.approval || null, signature = JSON.stringify(approval)
  if (signature === approvalSignature) return
  approvalSignature = signature
  window.dispatchEvent(new CustomEvent('scope:approval', { detail: approval }))
}
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
    if (id) deleteDraft(id)
    renderCards()
  } else if (typeof result.thread?.anchor?.section === 'string' && result.thread.created_at) upsert(result.thread)
  else {
    let refreshed: Parameters<typeof accept>[0] | undefined
    try { refreshed = await api<Parameters<typeof accept>[0]>(endpoint) } catch { /* The write landed; the next event or poll supplies the view. */ }
    if (refreshed) accept(refreshed)
  }
  return result
}
async function postThread(body: { anchor: Anchor; text: string; via?: 'voice'; images?: string[] }) { return write('', body) }
async function postReply(id: string, body: { text: string; via?: 'voice'; images?: string[] }) { return write(`/${id}/reply`, body, id) }
async function postResolve(id: string, body: { decision: string; alex_words?: string; how?: 'take' | 'own' | 'resolve'; via?: 'voice'; images?: string[] }) { return write(`/${id}/resolve`, body, id) }
async function postReject(id: string, body: { text: string; via?: 'voice'; images?: string[] }) { return write(`/${id}/reject`, body, id) }
async function postPark(id: string, body: { via?: 'voice' } = {}) { return write(`/${id}/park`, body, id) }
function hasClientId(clientId: string) { return scope?.threads.some(t => t.messages.some(m => (m as any).client_id === clientId) || (t.resolution as any)?.client_id === clientId || (t as any).parked_client_id === clientId) || false }
function sendingLine(item: Sending) { return `<div class="waiting sending" data-client="${esc(item.clientId)}" role="status">${Date.now() - item.at >= 120_000 ? 'Still sending. Admin will keep trying.' : 'Sending…'}${item.text ? ` &quot;${esc(item.text)}&quot;` : ''}</div>` }
setInterval(() => {
  document.querySelectorAll<HTMLElement>('.sending[data-client]').forEach(line => {
    const item = [...sending.values()].find(item => item.clientId === line.dataset.client)
    if (item && Date.now() - item.at >= 120_000) line.textContent = `Still sending. Admin will keep trying.${item.id && item.text ? ` "${item.text}"` : ''}`
  })
}, 10_000)
type CommentState = 'Sent' | 'Seen 👀' | 'Answered' | 'Retrying' | 'Not sent' | 'No lane pane'
const commentStates = new Map<string, { state: CommentState; takenAt?: number; timer?: number }>()
function delivery(id: string): CommentState | '' {
  const note = [...notes.values()].filter(n => n.thread === id && n.from === 'alex' && !['lane_note', 'approve', 'approve_with_changes', 'not_yet'].includes(n.event)).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1)
  const thread = scope?.threads.find(t => t.id === id), section = scope?.doc.sections.find(s => s.id === thread?.anchor.section)
  if (!note) {
    const state = (thread as Thread & { delivery?: string })?.delivery
    if (state === 'in_doc') return 'Answered'
    if (state !== 'with_lane' && state !== 'queued') return thread?.reaction?.emoji === '👀' ? 'Seen 👀' : ''
    const lastAlex = thread?.messages.filter(m => m.from === 'alex').at(-1)
    const taken = lastAlex && (thread?.messages.some(m => m.from !== 'alex' && m.at > lastAlex.at) || (section as DocSection & { updated_at?: string })?.updated_at! > lastAlex.at) || thread?.status === 'resolved' && thread.resolution?.confirmed_at
    return taken ? 'Answered' : thread?.reaction?.emoji === '👀' ? 'Seen 👀' : 'Sent'
  }
  if (note.delivery === 'delivered' && (thread?.messages.some(m => m.from !== 'alex' && m.at > note.delivered_at) || (section as DocSection & { updated_at?: string })?.updated_at! > note.delivered_at || thread?.status === 'resolved' && thread.resolution?.confirmed_at)) return 'Answered'
  if (thread?.reaction?.emoji === '👀' && !['retrying', 'failed', 'no_pane'].includes(note.delivery)) return 'Seen 👀'
  return ({ held: 'Sent', delivered: 'Sent', queued: 'Sent', retrying: 'Retrying', failed: 'Not sent', no_pane: 'No lane pane' } as Record<string, CommentState>)[note.delivery] || ''
}
function updateCommentStates() {
  for (const t of scope?.threads || []) {
    const state = delivery(t.id), previous = commentStates.get(t.id)
    if (!state) { if (previous?.timer) clearTimeout(previous.timer); commentStates.delete(t.id); continue }
    if (previous?.state === state) continue
    if (previous?.timer) clearTimeout(previous.timer)
    const entry: { state: CommentState; takenAt?: number; timer?: number } = { state }
    if (state === 'Answered') {
      entry.takenAt = previous ? Date.now() : 0
      if (previous) entry.timer = window.setTimeout(render, 30_000)
    }
    commentStates.set(t.id, entry)
  }
}
function deliveryChip(id: string) {
  const entry = commentStates.get(id)
  return entry && (entry.state !== 'Answered' || entry.takenAt && Date.now() - entry.takenAt < 30_000) ? `<span class="delivery-chip">${entry.state}</span>` : ''
}
function inflight() {
  const count = (state: CommentState) => scope!.threads.filter(t => delivery(t.id) === state).length
  const sent = count('Sent'), seen = count('Seen 👀'), answered = count('Answered')
  if (!sent && !seen) return ''
  const total = sent + seen + answered
  return `${total} comment${total === 1 ? '' : 's'} · ` + [[answered, 'Answered'], [seen, 'Seen 👀'], [sent, 'Sent']].filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ')
}
function cardHtml(t: Thread) {
  const isOpen = t.status === 'open', label = t.status === 'parked' ? 'Parked' : !isOpen ? 'Resolved' : t.kind === 'question' ? 'Lane asks' : 'You commented'
  if (t.status === 'resolved') {
    const lastAlex = t.messages.reduce((index, m, i) => m.from === 'alex' ? i : index, -1), answer = t.messages.slice(Math.max(1, lastAlex + 1)).filter(m => m.from === 'agent').at(-1)
    return `<div class="head"><span class="kind"><span class="dot resolved"></span><span class="who">Resolved</span></span><span class="when">${time(t.created_at)}</span></div><div class="q">${esc(t.messages[0]?.text)}</div>${imageStrip(t.messages[0]?.images)}${answer ? `<div class="msg"><div class="from">Lane<span>${time(answer.at)}</span></div><div>${esc(answer.text)}</div>${imageStrip(answer.images)}</div>` : ''}<div class="settled">${t.resolution?.how === 'approve' ? 'Approved with the scope:' : 'Resolved ·'} ${esc(t.resolution?.decision)}</div>${t.messages.slice(1).filter(message => message !== answer).map(message => imageStrip(message.images)).join('')}${imageStrip(t.resolution?.images)}`
  }
  const mode = !sending.has(t.id) && (modes.get(t.id) || (t.kind === 'comment' ? 'reply' : null))
  const compose = mode && !(t.recommendation && mode === 'else') && { no: ["What's wrong with it? (optional)", 'Send No'], else: ['Your answer', 'Send answer'], reply: [t.kind === 'question' ? 'Ask the lane something' : 'Reply', t.kind === 'question' ? 'Send' : 'Reply'] }[mode]
  const menu = isOpen && menus.has(t.id) ? `<div class="menu" role="menu">${t.kind === 'question' ? '<button role="menuitem" data-action="menu-reply">Reply</button>' : ''}<button role="menuitem" data-action="resolve">Resolve</button>${t.kind === 'question' ? '<button role="menuitem" class="tall" data-action="park">Not now<small>Park it without answering</small></button>' : ''}</div>` : ''
  let body = ''
  if (isOpen && compose) body = `<div class="reply only-on"><textarea data-draft="${t.id}" rows="${modes.has(t.id) ? 2 : 1}" placeholder="${esc(compose[0])}">${esc(getDraft(t.id))}</textarea>${imageStrip(getImages(t.id), true, t.id)}<p class="error" role="alert">${esc(errors.get(t.id))}</p><div class="actions">${attachControl}<button class="btn primary" data-action="${t.kind === 'comment' ? 'reply' : 'send'}">${compose[1]}</button>${modes.has(t.id) ? '<button class="btn" data-action="cancel">Cancel</button>' : ''}</div></div>`
  else if (isOpen && t.rejected_at) body = '<div class="waiting"><span class="dot"></span>Rejected, waiting for a new option</div>'
  else if (isOpen && t.kind === 'question') {
    const decision = askDecisions.get(t.id), suggested = askSuggestions.has(t.id) ? ' suggest' : ''
    const choices = decision ? `<p class="decided">${esc(decision.choice.action === 'take' ? 'Took it' : decision.choice.action === 'option' ? `Chose: ${decision.choice.label}` : decision.choice.action === 'no' ? 'Said no' : 'Something else')}${decision.note ? ` · ${esc(decision.note)}` : ''} <button data-action="undo">Undo</button></p>` : `<div class="choices"><button class="btn${suggested}" data-action="take">Take it</button><button class="btn${suggested}" data-action="no">No</button><button class="btn${suggested}" data-action="else">Something else</button></div>${suggested ? '<p class="pick-hint">Pick one; your note goes with it.</p>' : ''}`
    body = t.recommendation ? `<div class="reply only-on"><textarea data-draft="${t.id}" rows="1" placeholder="${modes.get(t.id) === 'else' ? 'Your answer' : 'Add a note · ⌘Enter takes it'}">${esc(getDraft(t.id))}</textarea>${imageStrip(getImages(t.id), true, t.id)}<p class="error" role="alert">${esc(errors.get(t.id))}</p><div class="actions">${attachControl}</div>${choices}</div>` : '<div class="choices only-on"><button class="btn one" data-action="else">Answer</button></div>'
  }
  const newRec = !t.rejected_at && t.messages.some(m => m.kind === 'option')
  const state = [deliveryChip(t.id), t.anchor.general ? 'General comment' : t.anchor.t != null ? `<span class="moment">at ${moment(t.anchor.t)}</span>` : ''].filter(Boolean).join(' · ')
  return `<div class="head"><span class="kind"><span class="dot ${isOpen ? t.kind : 'resolved'}"></span><span class="who">${label}</span></span>${unread(t) ? '<span class="unread-dot" aria-label="New answer"></span>' : ''}<span class="when">${time(t.created_at)}</span>${isOpen ? '<button class="more" data-action="menu" aria-label="More" aria-haspopup="menu">⋯</button>' : ''}</div>${menu}<div class="q">${esc(t.messages[0]?.text)}</div>${imageStrip(t.messages[0]?.images)}${state ? `<p class="card-state">${state}</p>` : ''}
  ${isOpen && t.recommendation ? `<div class="rec${newRec ? ' new' : ''}"><span class="lbl">Recommended</span><span class="txt">${esc(t.recommendation)}</span></div>` : ''}
  ${isOpen && t.kind === 'question' && t.options?.length && !askDecisions.has(t.id) ? `<details class="other-options only-on"><summary>Other options (${t.options.length - 1})</summary>${t.options.slice(1).map((option, i) => `<button${askSuggestions.get(t.id)?.option === i + 1 ? ' class="suggest"' : ''} data-action="option" data-option="${i + 1}">${esc(option)}</button>`).join('')}</details>` : ''}
  ${isOpen && t.why ? `<details class="why only-on"><summary>Why</summary><p>${esc(t.why)}</p></details>` : ''}
  ${t.messages.length > 1 ? `<div class="msgs only-on">${t.messages.slice(1).map((m, i) => `<div class="msg"><div class="from">${m.from === 'alex' ? 'You' : 'Lane'}<span>${time(m.at)}</span></div><div>${m.kind === 'reject' ? 'No' + (m.text ? ': ' : '') : ''}${esc(m.text)}</div>${imageStrip(m.images)}</div>`).join('')}</div>` : ''}
  ${t.status === 'parked' ? '<div class="settled"><b>Parked.</b> Not answered; the lane leaves it for later.</div>' : ''}${sending.has(t.id) ? sendingLine(sending.get(t.id)!) : body}${!compose && errors.has(t.id) ? `<p class="error" role="alert">${esc(errors.get(t.id))}</p>` : ''}`
}
function card(t: Thread) {
  const node = document.createElement('div'); node.className = `card ${t.kind} ${t.status}${unread(t) ? ' unread' : ''}${focused === t.id ? ' on' : ''}`; node.dataset.t = t.id; if (sending.has(t.id)) node.dataset.sending = 'true'; node.innerHTML = cardHtml(t); return node
}
function highlight() {
  missing.clear()
  for (const t of ordered()) {
    if (t.anchor.general) continue
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
  return JSON.stringify([contentSignature(s), s.id === 'title' ? [scope!.revision, scope!.updated_at, line, scope!.approval, queuedApproval] : null])
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
  const reading = activeKey && !composing ? candidates.find(n => unchanged(n.closest('section')!.id)) || candidates[0] : candidates[0]
  const readingSection = reading?.closest('section')?.id
  const readingIndex = reading ? [...reading.closest('section')!.querySelectorAll('h1,h2,p,li,figure,pre,table')].indexOf(reading) : -1
  const composerAnchor = composing && !composing.general ? composing : null
  const composerRange = composerAnchor && rangeFromAnchor(composerAnchor)?.range
  const readingTop = composerRange ? composerRange.getBoundingClientRect().top : reading?.getBoundingClientRect().top
  if (composerAnchor && sectionContents.has(composerAnchor.section)) {
    const section = scope.doc.sections.find(s => s.id === composerAnchor.section)
    if (section && contentSignature(section) !== sectionContents.get(section.id)) changedComposer = composerAnchor
  }
  const sel = getSelection(), selected = sel?.rangeCount && !sel.isCollapsed ? anchorFromRange(sel.getRangeAt(0)) : null
  const keepSelection = selected && unchanged(selected.section) ? selected : null
  const backward = !!sel?.rangeCount && sel.anchorNode === sel.getRangeAt(0).endContainer && sel.anchorOffset === sel?.getRangeAt(0)?.endOffset
  const askOpen = doc.querySelector<HTMLDetailsElement>('.ask-fold')?.open || false
  const redrawn: HTMLElement[] = []
  let position = 0
  for (const s of scope.doc.sections) {
    let node = [...doc.children].find(n => n.id === s.id) as HTMLElement | undefined
    if (!node || !unchanged(s.id)) {
      const replacement = document.createElement('div'); replacement.innerHTML = `<section id="${esc(s.id)}" data-section>${s.id === 'ask' ? `<details class="ask-fold"${askOpen ? ' open' : ''}><summary><svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><h2>${esc(s.heading)}</h2></summary><div class="body">${markdown(s.body_md, scope!.doc.assets, `${endpoint}/assets`)}</div></details>` : `${s.id === 'title' ? '<p class="eyebrow" data-cm-skip>Scoping</p>' : ''}${s.id === 'title' ? `<div class="title-row"><h1>${esc(s.heading)}</h1><span class="title-actions" data-cm-skip>${boot.comment !== 'host' ? '<button type="button" class="btn" data-action="general-comment">Comment</button>' : ''}${boot.approve !== 'host' && !isApproved() && (!queuedApproval || queuedApproval.failed) ? '<button type="button" class="btn primary" data-action="approve-scope" data-cm-skip>Approve scope</button>' : ''}</span></div>${approvalBanner()}` : `<h2>${esc(s.heading)}</h2>`}<div class="body ${s.id === 'title' ? 'lede' : ''}">${markdown(s.body_md, scope!.doc.assets, `${endpoint}/assets`)}</div>${s.id === 'title' ? `<p class="meta" data-cm-skip>Revision ${scope!.revision} · Updated ${time(scope!.updated_at)}${boot.voice === false && boot.voiceUrl && /^https?:\/\//i.test(boot.voiceUrl) ? ` · <a href="${esc(boot.voiceUrl)}" target="_blank" rel="noopener">Open with voice</a>` : ''}</p><p class="inflight" data-cm-skip${line ? '' : ' hidden'}>${esc(line)}</p>` : ''}`}</section>`
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
    const section = readingSection ? document.getElementById(readingSection) : null
    const anchor = composerAnchor && rangeFromAnchor(composerAnchor)?.range || (reading?.isConnected ? reading : section?.querySelectorAll('h1,h2,p,li,figure,pre,table')[readingIndex] || section?.querySelector('h1,h2'))
    if (anchor && readingTop != null) { const difference = anchor.getBoundingClientRect().top - readingTop; if (Math.abs(difference) > 1) scrollBy({ top: difference, behavior: 'instant' }) }
  }
  restoreReading()
  for (const node of redrawn) void renderMermaid(node, () => { layout(); restoreReading() })
  if (keepSelection) {
    const range = rangeFromAnchor(keepSelection)?.range
    if (range && sel) sel.setBaseAndExtent(backward ? range.endContainer : range.startContainer, backward ? range.endOffset : range.startOffset, backward ? range.startContainer : range.endContainer, backward ? range.startOffset : range.endOffset)
  }
  if (activeKey) { const target = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')].find(n => n.dataset.draft === activeKey && n.getClientRects().length); if (target && document.activeElement !== target) target.focus({ preventScroll: true }); if (caret != null) target?.setSelectionRange(caret, caretEnd ?? caret, direction || undefined) }
}
function renderCards() {
  syncFigureFocus()
  if (focused && document.visibilityState === 'visible' && document.querySelector(`.card.on[data-t="${focused}"]`)) markSeen(focused)
  syncThreadClasses()
  const visible = ordered().filter(t => t.status === 'open' || recent(t) || showResolved)
  const active = document.activeElement as HTMLElement | null
  const activeCard = active?.matches('textarea[data-draft]') ? active.closest<HTMLElement>('.card') : null
  const retained = [...cards.querySelectorAll<HTMLTextAreaElement>('[data-retained-reply] textarea'), ...detached.querySelectorAll<HTMLTextAreaElement>('[data-retained-reply] textarea')].find(input => input.value.trim())?.closest<HTMLElement>('.card')
  const kept = activeCard && (activeCard.parentElement === cards || activeCard.parentElement === detached) ? activeCard : retained || null
  const composer = composing ? document.querySelector<HTMLElement>('.card.composer') : null
  const keptThread = kept?.dataset.t && scope?.threads.find(t => t.id === kept.dataset.t)
  if (keptThread && !visible.includes(keptThread)) refreshCard(kept!, card(keptThread))
  const makeCard = (t: Thread) => kept?.dataset.t === t.id ? refreshCard(kept, card(t)) : card(t)
  const mainNodes: Node[] = visible.filter(t => !missing.has(t.id)).map(makeCard)
  if (composer?.parentElement === cards) mainNodes.push(composer)
  if (kept?.parentElement === cards && !mainNodes.includes(kept) && kept.dataset.t) mainNodes.push(kept)
  replaceAround(cards, mainNodes, kept?.parentElement === cards ? kept : composer)
  const gone = visible.filter(t => missing.has(t.id))
  const detachedNodes: Node[] = gone.length ? [document.createTextNode('Detached · the text it was on changed'), ...gone.map(makeCard)] : []
  if (kept?.parentElement === detached && kept.dataset.t && !detachedNodes.includes(kept)) detachedNodes.push(kept)
  replaceAround(detached, detachedNodes, kept)
  for (const item of sending.values()) if (!item.id && item.anchor) {
    const node = document.createElement('div'); node.className = 'card comment on'; node.dataset.sending = 'true'; node.dataset.client = item.clientId
    node.innerHTML = `<div class="head"><span class="who">You commented</span></div><div class="q">${esc(item.text)}</div>${sendingLine({ ...item, text: '' })}`
    if (item.anchor.general) cards.prepend(node); else cards.append(node)
  }
  if (composing) renderComposer()
  document.body.classList.toggle('show-resolved', showResolved)
  const toggle = $<HTMLInputElement>('#showResolved'); toggle.checked = showResolved; toggle.toggleAttribute('checked', showResolved)
  const resolvedCount = ordered().filter(t => t.status !== 'open').length, resolvedLabel = `Resolved (${resolvedCount})`
  $('#resolvedLabel').textContent = resolvedLabel
  const chip = $('#resolvedChip'); chip.textContent = resolvedLabel; chip.hidden = resolvedCount === 0; chip.setAttribute('aria-pressed', String(showResolved))
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
    if (queued?.anchor?.general || n.classList.contains('composer') && composing?.general) return 8
    const mark = marks(n.dataset.t!)[0], anchor = mark && !hidden(mark) && mark.getClientRects().length ? figureFor(mark) || mark : mark?.closest('details:not([open])')?.querySelector('summary')
    const composerRange = n.classList.contains('composer') && composing && rangeFromAnchor(composing)?.range
    return Math.max(8, (n.classList.contains('composer') ? composerRange ? composerRange.getBoundingClientRect().top + scrollY : selectionTop : range ? range.getBoundingClientRect().top + scrollY : anchor ? anchor.getBoundingClientRect().top + scrollY : base + scrollY) - scrollY - base - (n.classList.contains('composer') ? 0 : 12))
  })
  const heights = nodes.map(n => n.offsetHeight), top = [...want]
  let pivot = nodes.findIndex(n => composing ? n.classList.contains('composer') : n.dataset.t === focused); if (pivot < 0) pivot = 0
  if (composing && !composing.general) {
    const below: number[] = []
    let above = top[pivot], bottom = top[pivot] + heights[pivot] + 10
    for (let i = pivot - 1; i >= 0; i--) {
      const candidate = Math.min(want[i], above - heights[i] - 10)
      if (candidate < 8) below.unshift(i)
      else { top[i] = candidate; above = candidate }
    }
    below.push(...nodes.map((_, i) => i).slice(pivot + 1))
    for (const i of below) { top[i] = Math.max(want[i], bottom); bottom = top[i] + heights[i] + 10 }
  } else {
    for (let i = pivot + 1; i < nodes.length; i++) top[i] = Math.max(want[i], top[i - 1] + heights[i - 1] + 10)
    for (let i = pivot - 1; i >= 0; i--) top[i] = Math.min(want[i], top[i + 1] - heights[i] - 10)
    if (top[0] < 8) { const shift = 8 - top[0]; top.forEach((_, i) => top[i] += shift) }
  }
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
function threadTarget(id: string) {
  const thread = scope?.threads.find(t => t.id === id)
  if (thread?.anchor.general) return { node: document.getElementById('title'), general: true, fallback: true }
  const list = marks(id), mark = list.find(m => !hidden(m) && m.getClientRects().length)
  if (mark) return { node: figureFor(mark) || mark, general: false, fallback: false }
  return { node: list.length && !list.some(hidden) ? document.getElementById(thread?.anchor.section || '') : null, general: false, fallback: true }
}
function jumpThread(id: string, flash = false) {
  const target = threadTarget(id), node = target.node
  if (!node) return
  if (target.general) scrollTo({ top: 0, behavior: 'instant' })
  else if (phone()) scrollTo({ top: scrollY + node.getBoundingClientRect().top - 96, behavior: 'instant' })
  else node.scrollIntoView({ block: target.fallback ? 'start' : 'center', behavior: 'smooth' })
  if (flash && !target.fallback) { node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash') }
}
function threadOnScreen(id: string) {
  const node = threadTarget(id).node
  if (!node) return false
  const rect = node.getBoundingClientRect()
  return rect.bottom >= 52 && rect.top < innerHeight
}
function focus(id: string | null, scroll = false, openSheet = true) {
  focused = id
  if (id) markSeen(id)
  renderCards()
  if (id && scope?.threads.some(t => t.id === id && t.status === 'open' && t.anchor.section === 'ask')) { const fold = doc.querySelector<HTMLDetailsElement>('.ask-fold'); if (fold) fold.open = true }
  document.querySelectorAll<HTMLElement>('.card[data-t],mark[data-t]').forEach(n => n.classList.toggle('on', n.dataset.t === id))
  syncFigureFocus()
  if (id && scroll) jumpThread(id, true)
  if (phone() && id && openSheet) { document.body.classList.add('sheet-open'); renderSheet(); jumpThread(id) }
  updateCount(); layout()
}
function step(direction: number) { const list = open(); if (!list.length) return; const index = list.findIndex(t => t.id === focused); focus(list[Math.max(0, Math.min(list.length - 1, index < 0 ? 0 : index + direction))].id, true) }
function renderSheet() {
  const t = scope?.threads.find(t => t.id === focused); if (!t) { closeSheet(); return }
  const i = open().findIndex(x => x.id === t.id)
  sheet.toggleAttribute('data-sending', sending.has(t.id)); if (sending.has(t.id)) sheet.dataset.sending = 'true'
  const fresh = document.createElement('div')
  fresh.innerHTML = `<div class="grab"></div><div class="quote">${t.anchor.general ? 'General comment' : `On <q>${esc(t.anchor.quote)}</q>`}</div><div class="card on ${t.kind} ${t.status}" data-t="${t.id}">${cardHtml(t)}</div>${i >= 0 ? `<div class="nav"><span>${i + 1} of ${open().length} open</span><span class="spacer"></span><button class="icon-btn" data-go="-1" aria-label="Previous">↑</button><button class="icon-btn" data-go="1" aria-label="Next">↓</button></div>` : ''}`
  const active = document.activeElement as HTMLElement | null
  const activeCard = active?.matches('textarea[data-draft]') ? active.closest<HTMLElement>('.card') : null
  const retained = [...sheet.querySelectorAll<HTMLTextAreaElement>('[data-retained-reply] textarea')].find(input => input.value.trim())?.closest<HTMLElement>('.card')
  const kept = activeCard?.parentElement === sheet ? activeCard : retained || null
  const next = fresh.querySelector<HTMLElement>('.card')!
  if (kept?.parentElement === sheet && kept.dataset.t === t.id) { refreshCard(kept, next); replaceAround(sheet, [...fresh.childNodes].map(n => n instanceof HTMLElement && n.matches('.card') ? kept : n), kept) }
  else sheet.replaceChildren(...fresh.childNodes)
}
function closeSheet() { document.body.classList.remove('sheet-open') }
function docSelection() {
  const sel = getSelection()
  if (!sel?.rangeCount || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!doc.contains(range.startContainer) || !doc.contains(range.endContainer)) return null
  const anchor = anchorFromRange(range)
  return anchor ? { range, anchor } : null
}
function showSelection() {
  document.querySelector('[data-action="comment"]')?.remove()
  if (!selection || composing || selectionScrolling) return
  const range = selectionRange?.startContainer.isConnected ? selectionRange : rangeFromAnchor(selection)?.range
  const rect = range && [...range.getClientRects()].filter(r => r.width > 0).at(-1)
  if (!rect) return
  const button = document.createElement('button'); button.className = 'add'; button.dataset.action = 'comment'; button.textContent = 'Comment'
  document.body.append(button)
  const width = button.offsetWidth, height = button.offsetHeight
  const top = rect.bottom + 6 + height > innerHeight - 8 ? rect.top - height - 6 : rect.bottom + 6
  button.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`
  button.style.left = `${Math.max(8, Math.min(rect.right - width / 2, innerWidth - width - 8))}px`
}
function readSelection() {
  if (!zoom.hidden) return
  const selected = docSelection()
  if (selected) { selection = selected.anchor; selectionRange = selected.range.cloneRange(); selectionTop = selected.range.getBoundingClientRect().top + scrollY; showSelection() }
  else if (!document.activeElement?.closest('.card,.add')) { selection = null; selectionRange = null; showSelection() }
}
function openSelectionComment(anchor = selection, range = selectionRange) {
  if (!anchor) return
  selection = anchor; selectionRange = range?.cloneRange() || null
  if (range) selectionTop = range.getBoundingClientRect().top + scrollY
  composing = anchor; renderCards(); showSelection()
  $('.composer textarea', phone() ? sheet : cards).focus({ preventScroll: true })
}
doc.addEventListener('contextmenu', e => {
  if (phone() || !zoom.hidden) return
  const selected = docSelection()
  if (!selected || ![...selected.range.getClientRects()].some(rect => rect.width > 0 && e.clientX >= rect.left - 2 && e.clientX <= rect.right + 2 && e.clientY >= rect.top - 2 && e.clientY <= rect.bottom + 2)) return
  e.preventDefault(); openSelectionComment(selected.anchor, selected.range)
})
document.addEventListener('keydown', e => {
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey
  if (!zoom.hidden || e.isComposing || e.code !== 'KeyM' || !modifier || !(e.altKey || e.shiftKey) || (e.target as HTMLElement).closest('textarea,input,[contenteditable]')) return
  const selected = docSelection()
  if (!selected) return
  e.preventDefault(); openSelectionComment(selected.anchor, selected.range)
})
function openGeneralComment() {
  const quote = scope?.doc.sections.find(s => s.id === 'title')?.heading.trim().slice(0, 300)
  if (!quote) return
  getSelection()?.removeAllRanges(); selection = null
  composing = { section: 'title', quote, prefix: '', suffix: '', general: true }
  renderCards(); $('.composer textarea', phone() ? sheet : cards).focus()
}
window.addEventListener('scope:comment-open', openGeneralComment)
function cancelComposer() {
  composing = null; closeSheet(); renderCards()
}
function renderComposer() {
  const key = composerKey()
  let node = document.querySelector<HTMLElement>('.card.composer')
  if (node?.querySelector<HTMLElement>('[data-draft]')?.dataset.draft !== key) { node?.remove(); node = null }
  const fresh = document.createElement('div'); fresh.className = 'card composer comment on'; fresh.innerHTML = `<div class="head"><span class="dot comment"></span><span class="who">You commented</span></div><div class="reply">${composing?.t != null ? `<div class="moment">At ${moment(composing.t)}</div>` : ''}<textarea rows="2" data-draft="${esc(key)}" placeholder="${composing?.general ? 'Comment on the whole doc' : composing?.t != null ? 'Comment on this moment' : 'Comment on this text'}">${esc(getDraft(key))}</textarea>${imageStrip(getImages(key), true, key)}<p class="error">${esc(errors.get(key))}</p><div class="actions">${attachControl}<button class="btn primary" data-action="post">Comment</button><button class="btn" data-action="cancel">Cancel</button></div></div>`
  if (node) refreshCard(node, fresh)
  else {
    node = fresh
    if (phone()) sheet.replaceChildren(node)
    else if (composing?.general || !scope?.doc.sections.some(s => s.id === composing?.section)) cards.prepend(node)
    else { const range = composing && rangeFromAnchor(composing)?.range; const after = [...cards.children].find(n => { const mark = marks((n as HTMLElement).dataset.t!)[0]; return range && mark && range.comparePoint(mark.firstChild!, 0) > 0 }); cards.insertBefore(node, after || null) }
  }
  const message = !composing?.general && !scope?.doc.sections.some(s => s.id === composing?.section) ? 'This section was removed. Your draft is kept.' : changedComposer === composing ? 'This section changed since you started.' : ''
  let note = node.querySelector<HTMLElement>('.composer-note')
  if (message) { if (!note) { note = document.createElement('p'); note.className = 'composer-note'; node.querySelector('textarea')!.before(note) }; note.textContent = message } else note?.remove()
  if (phone()) document.body.classList.add('sheet-open')
}
async function action(name: string, target: HTMLElement, imageSnapshot?: string[]) {
  if (name === 'general-comment') { openGeneralComment(); return }
  if (name === 'comment') { openSelectionComment(); return }
  const id = target.closest<HTMLElement>('[data-t]')?.dataset.t, t = scope?.threads.find(t => t.id === id), key = target.closest('.composer') ? target.closest('.composer')?.querySelector<HTMLElement>('[data-draft]')?.dataset.draft || 'composer' : id!
  if (name === 'undo' && t) { const decision = askDecisions.get(t.id); if (decision) clearTimeout(decision.timer); askDecisions.delete(t.id); renderCards(); return }
  if (name === 'attach') { target.closest('.reply')?.querySelector<HTMLInputElement>('[data-images]')?.click(); return }
  if (name === 'remove-image') { saveImages(key, getImages(key).filter((_, i) => i !== Number(target.dataset.image))); updateImageBox(key); return }
  if (pending.has(key) || sending.has(key) || uploading.get(key) || askDecisions.has(key) || picking.has(key) && ['take', 'no', 'else', 'option'].includes(name)) return
  const images = imageSnapshot ?? getImages(key).map(image => image.id), pictures = images.length ? { images } : {}
  const text = getDraft(key).trim()
  if (name === 'cancel') { if (t) { modes.delete(t.id); menus.delete(t.id); renderCards() } else { cancelComposer() }; return }
  if (t && name === 'else' && t.recommendation && !text) { modes.set(t.id, 'else'); renderCards(); const input = (phone() ? sheet : document).querySelector<HTMLTextAreaElement>(`.card[data-t="${t.id}"] textarea`); if (input) input.placeholder = 'Your answer'; focusBox(t.id); return }
  if (t && ['menu', 'menu-reply', ...(!t.recommendation ? ['else'] : [])].includes(name)) {
    if (name === 'menu') { if (menus.has(t.id)) menus.delete(t.id); else menus.add(t.id) }
    else { menus.delete(t.id); modes.set(t.id, name === 'menu-reply' ? 'reply' : name as 'no' | 'else') }
    renderCards(); if (name !== 'menu') focusBox(t.id); return
  }
  const mode = t && modes.get(t.id)
  if ((name === 'send' && mode !== 'no' || name === 'reply' || name === 'post') && !text && !(images.length && (name === 'post' || name === 'reply' || mode === 'reply'))) { target.closest('.card')?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); return }
  pending.add(key); disablePending()
  try {
    if (name === 'post' && composing && (text || images.length)) { const anchor = composing; const result = await postThread({ anchor, text, ...pictures }); composing = null; selection = null; deleteDraft(key); errors.delete(key); if (result.thread) focus(result.thread.id); else closeSheet(); return }
    if (!t) return
    if (name === 'reply' || name === 'send' && mode === 'reply') await postReply(t.id, { text, ...pictures })
    else if (name === 'send' && mode === 'no') await postReject(t.id, { text, ...pictures })
    else if (name === 'send' && mode === 'else') await postResolve(t.id, { decision: text, alex_words: text, how: 'own', ...pictures })
    else if (name === 'take' && t.recommendation) await postResolve(t.id, { decision: t.recommendation, alex_words: text || 'Take the recommendation', how: 'take', ...pictures })
    else if (name === 'no' && t.recommendation) await postReject(t.id, { text, ...pictures })
    else if (name === 'else' && t.recommendation && text) await postResolve(t.id, { decision: text, alex_words: text, how: 'own', ...pictures })
    else if (name === 'option' && t.options?.[Number(target.dataset.option)] != null) { const option = t.options[Number(target.dataset.option)]; await postResolve(t.id, { decision: option, alex_words: text || option, how: 'own', ...pictures }) }
    else if (name === 'resolve') await postResolve(t.id, { decision: 'Resolved', alex_words: 'Resolved', how: 'resolve', ...pictures })
    else if (name === 'park') await postPark(t.id)
    if (getDraft(key).trim() === text) deleteDraft(key); errors.delete(key); modes.delete(t.id); menus.delete(t.id); askSuggestions.delete(t.id)
    if (!sending.has(t.id) && (['take', 'resolve', 'park'].includes(name) || name === 'send' && mode === 'else')) { closeSheet(); focused = open()[0]?.id || null }
    renderCards()
  } catch (error) { errors.set(key, error instanceof Error ? error.message : 'Could not send') }
  finally { pending.delete(key); renderCards() }
}
async function pickAsk(t: Thread) {
  if (pending.has(t.id) || sending.has(t.id) || picking.has(t.id) || askDecisions.has(t.id) || uploading.get(t.id)) return
  const note = getDraft(t.id).trim(), images = getImages(t.id).map(image => image.id)
  focus(t.id, false, false)
  picking.add(t.id)
  let result: { choice: AskChoice | null; sure: boolean } = { choice: { action: 'take', label: t.recommendation! }, sure: true }
  try {
    if (note) { try { result = await api(`${endpoint}/threads/${t.id}/pick`, { text: note }) } catch { result = { choice: null, sure: false } } }
    if (scope?.threads.find(thread => thread.id === t.id)?.status !== 'open' || getDraft(t.id).trim() !== note) return
    if (!result.sure || !result.choice) { askSuggestions.set(t.id, result.choice); renderCards(); return }
    const choice = result.choice
    askSuggestions.delete(t.id)
    const timer = window.setTimeout(() => {
      askDecisions.delete(t.id)
      if (scope?.threads.find(thread => thread.id === t.id)?.status !== 'open') { renderCards(); return }
      const target = document.createElement('button'); target.dataset.t = t.id; if (choice.option != null) target.dataset.option = String(choice.option)
      setDraft(t.id, note)
      void action(choice.action, target, images)
    }, 10_000)
    askDecisions.set(t.id, { choice, note, timer }); renderCards()
  } finally { picking.delete(t.id) }
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
  const id = target.dataset.draft!, thread = scope?.threads.find(t => t.id === id)
  if (thread?.kind === 'question' && thread.status === 'open' && thread.recommendation && modes.get(id) !== 'reply') { void pickAsk(thread); return }
  const button = target.closest('.reply')?.querySelector<HTMLElement>('.btn.primary[data-action]')
  if (button) void action(button.dataset.action!, button)
})
document.addEventListener('click', e => {
  const target = e.target as HTMLElement
  const thumbnail = target.closest<HTMLButtonElement>('button.thumb[data-action="view-image"]'); if (thumbnail) { lightboxOpener = thumbnail; lightboxItems = [...thumbnail.closest('.thumbs')!.querySelectorAll<HTMLButtonElement>('button.thumb')]; lightboxIndex = lightboxItems.indexOf(thumbnail); showLightboxImage(); lightbox.showModal(); return }
  if (lightbox.contains(target)) return
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
  const mark = target.closest<HTMLElement>('mark[data-t]'); if (mark && (!mark.classList.contains('resolved') || mark.classList.contains('recent') || showResolved)) { focus(mark.dataset.t!); seekMoment(mark.dataset.t!); return }
  const node = target.closest<HTMLElement>('.card[data-t]'); if (node && !target.closest('textarea,button,a,summary,details')) { focus(node.dataset.t!, true); seekMoment(node.dataset.t!); if (!phone()) focusBox(node.dataset.t!) }
})
document.addEventListener('input', e => { const input = e.target as HTMLTextAreaElement; if (!input.dataset.draft) return; setDraft(input.dataset.draft, input.value); const reply = input.closest('.card')?.querySelector<HTMLButtonElement>('[data-action="reply"]'); if (reply) { reply.hidden = !phone() && !input.value.trim() && !getImages(input.dataset.draft).length; reply.disabled = pending.has(input.dataset.draft) || !!uploading.get(input.dataset.draft) || !input.value.trim() && !getImages(input.dataset.draft).length }; layout() })
let selectionTimer = 0
for (const event of ['selectionchange', 'pointerup', 'mouseup']) document.addEventListener(event, () => { clearTimeout(selectionTimer); selectionTimer = window.setTimeout(readSelection, 80) })
$('#prev').onclick = $('#chipPrev').onclick = () => step(-1)
$('#next').onclick = $('#chipNext').onclick = () => step(1)
$('#openLabel').onclick = () => focus(open().some(t => t.id === focused) ? focused : open()[0]?.id || null, true)
$('#scrim').onclick = closeSheet
$('#showResolved').onchange = e => { showResolved = (e.target as HTMLInputElement).checked; storage.set('scope:showResolved', String(showResolved)); renderCards() }
$('#resolvedChip').onclick = () => { showResolved = !showResolved; storage.set('scope:showResolved', String(showResolved)); renderCards() }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renderCards() })
document.addEventListener('keydown', e => { if (!zoom.hidden) return; if (e.key === 'Escape') { if (composing && (phone() || composing.general)) cancelComposer(); else closeSheet(); return }; if ((e.target as HTMLElement).closest('button,a,summary,select,textarea,input,[contenteditable]')) return; if (e.key === 'j') step(1); if (e.key === 'k') step(-1); if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && focused && !phone()) { e.preventDefault(); focusBox(focused) } })
addEventListener('resize', () => { layout(); showSelection() }); document.fonts.ready.then(layout)
let docWidth = doc.getBoundingClientRect().width, layoutFrame = 0
new ResizeObserver(() => {
  const width = doc.getBoundingClientRect().width
  if (Math.abs(width - docWidth) < .5) return
  docWidth = width
  cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(layout)
}).observe(doc)
let scrollTimer = 0
addEventListener('scroll', () => { selectionScrolling = true; showSelection(); clearTimeout(scrollTimer); scrollTimer = window.setTimeout(() => { selectionScrolling = false; if (!zoom.hidden) return; showSelection(); if (phone() && document.body.classList.contains('sheet-open')) return; if (focused && threadOnScreen(focused)) return; const next = open().find(t => threadOnScreen(t.id)); if (next) focus(next.id, false, false) }, 150) })
function context() { const sections = [...doc.querySelectorAll<HTMLElement>('section[data-section]')]; const section = sections.filter(n => n.getBoundingClientRect().top <= innerHeight * .3).at(-1) || sections[0]; return { thread: focused, section: section?.id || null, selection } }
function voiceUi(ui: ScopeVoiceUi) { if (ui.do === 'focus_thread') focus(ui.thread, true); if (ui.do === 'focus_section') document.getElementById(ui.section)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); if (ui.do === 'show_resolved') { showResolved = ui.on; storage.set('scope:showResolved', String(showResolved)); renderCards() }; if (ui.do === 'scroll') scrollBy({ top: innerHeight * .8 * (ui.direction === 'up' ? -1 : 1), behavior: 'smooth' }) }
const feedRows: (ScopeFeedLine & { at: Date })[] = []
let feedExpanded = false, feedClosed = false
const feed = document.createElement('div')
feed.className = 'voice-feed'; feed.setAttribute('aria-live', 'polite'); feed.setAttribute('aria-label', 'Voice activity'); feed.hidden = true
if (boot.voice !== false) document.body.append(feed)
function positionFeed() {
  const capsule = document.querySelector<HTMLElement>('.voice-capsule')
  const bottom = capsule ? innerHeight - capsule.getBoundingClientRect().top + 8 : embed ? innerHeight - $('#talk').getBoundingClientRect().top + 12 : phone() ? 84 : 24
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
  feed.innerHTML = `<div class="voice-feed-controls"><span class="voice-feed-heading">Voice activity</span>${feedRows.length > limit ? `<button class="voice-feed-toggle">${feedExpanded ? 'Show less' : `Show all (${feedRows.length})`}</button>` : ''}<button class="voice-feed-close" aria-label="Close voice activity">×</button></div><div class="voice-feed-list${feedExpanded ? ' expanded' : ''}">${visible.map(row => `<button class="voice-feed-row" data-ok="${row.ok}"${row.write ? ' data-write' : ''}${row.thread ? ` data-thread="${esc(row.thread)}"` : ''} title="${esc(row.at.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET')}"><span class="voice-feed-dot" aria-hidden="true"></span><span class="voice-feed-label">${esc(row.label)}</span>${row.write && row.thread ? `<span class="voice-feed-delivery">${esc(delivery(row.thread) === 'Sent' || delivery(row.thread) === 'Answered' ? 'Sent to the lane' : delivery(row.thread))}</span>` : ''}</button>`).join('')}</div>`
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
if (embed && boot.voice !== false) document.body.append($('#talk'))
$('#talk').onclick = async () => { if (boot.voice === false) return; try { const audio = prepareAudio(); const { mountVoice } = await import('./voice-mount'); mountVoice(audio, { getScope: async () => ({ slug, scope: scope! }), getContext: context, postThread, postReply, postResolve, postReject, postPark, fetchContext: q => api(`${endpoint}/context?q=${encodeURIComponent(q)}`), postLaneNote: body => api(`${endpoint}/lane-note`, { ...body, client_id: clientId() }), postApprove: async body => { const result = await api<{ queued?: boolean; client_id?: string }>(`${endpoint}/approve`, body); if (result.queued === true) trackQueuedApproval(result.client_id || body.client_id, body.mode, body.comment ?? ''); try { accept(await api(endpoint)) } catch {}; return result }, onFeed }, voiceUi, active => { if (active) { feedRows.length = 0; feedExpanded = false; feedClosed = false; renderFeed() }; $('#talk').classList.toggle('active', active) }) } catch (error) { $('#live').textContent = error instanceof Error ? error.message : 'Voice unavailable' } }
let lastPayload = ''
function accept(payload: { scope: ScopeV2; notes?: any[]; error?: string }) { if (!payload.scope) { lastPayload = ''; doc.textContent = payload.error || 'The lane has not published a doc yet.'; return }; const fingerprint = JSON.stringify(payload); if (fingerprint === lastPayload) return; lastPayload = fingerprint
  scope = payload.scope
  settleQueuedApproval()
  publishApproval()
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
  let reconnectTimer = 0
  events.onopen = () => { clearTimeout(reconnectTimer); reconnectTimer = 0; $('#live').textContent = 'Live' }
  events.onerror = () => {
    if (events.readyState === EventSource.CLOSED) { clearTimeout(reconnectTimer); reconnectTimer = 0; $('#live').textContent = 'Reconnecting' }
    else if (!reconnectTimer) reconnectTimer = window.setTimeout(() => { reconnectTimer = 0; if (events.readyState !== EventSource.OPEN) $('#live').textContent = 'Reconnecting' }, 5000)
  }
}
void start().catch(error => { doc.textContent = `Could not load: ${error.message}`; $('#live').textContent = 'Reconnecting' })
