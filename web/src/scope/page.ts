import './scope.css'
import { placeCards } from './card-layout'
import '../vendor/page-chrome/v1.css'
import './page-chrome.css'
import { mountPage, commentsHeader, type PageAction } from '../vendor/page-chrome/v1.js'
import { appOf, orderThreads, type ScopeV2, type Thread, type DocSection, type ScopeApproval, type CommentImage } from '../../../src/scope-doc.js'
import { locateAnchor, locateEmbed, makeAnchor, type Anchor } from '../../../src/scope-anchor.js'
import { demoNote, demoPins, readDemoMessage, type DemoNoteMessage, type DemoReadyMessage } from '../../../src/demo-host.js'
import { DOC_KINDS, KIND_IDS, kindOf, kindSpec } from '../../../src/doc-kinds.js'
const moment = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
import { anchorFromRange, sectionText, rangeFromAnchor } from './dom-anchor'
import { esc, markdown, renderMermaid } from './markdown'
import { answerHtml } from './answer.ts'
import { approvalBannerHtml } from './approval-banner.js'
import { prepareAudio } from '../lib/voice-audio'
import type { ScopeVoiceUi, ScopeFeedLine } from '../../../src/scope-voice.js'

const $ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)!
const boot = (window as any).__SCOPE_BOOT__ || {}
const slug = boot.slug || location.pathname.match(/^\/s\/([^/]+)/)?.[1]
const apiBase = (boot.api || '/api/scope').replace(/\/$/, '')
const embed = boot.embed === true || new URLSearchParams(location.search).get('embed') === '1'
document.body.classList.toggle('embed', embed)
document.body.classList.toggle('in-frame', window.parent !== window)
const doc = $('#doc'), cards = $('#cards'), detached = $('#detached'), sheet = $('#sheet')
const phone = () => matchMedia('(max-width:899px)').matches
const storage = { get(key: string) { try { return localStorage.getItem(key) } catch { return null } }, set(key: string, value: string) { try { localStorage.setItem(key, value) } catch {} }, remove(key: string) { try { localStorage.removeItem(key) } catch {} } }
const time = (iso: string) => `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`
let scope: ScopeV2 | null = null, focused: string | null = null, initialized = false
let detachedPin: { id: string; top: number } | null = null
function focusedCard() { return [...cards.querySelectorAll<HTMLElement>('.card[data-t]'), ...detached.querySelectorAll<HTMLElement>('.card[data-t]')].find(n => n.dataset.t === focused) }
let showResolved = storage.get('scope:showResolved') === 'true'
const commentsBar = commentsHeader($('.side-head'), { open: 0, index: 0, total: 0, showResolved, onPrev: () => step(-1), onNext: () => step(1), onShowResolved: checked => { showResolved = checked; storage.set('scope:showResolved', String(checked)); if (!checked && scope?.threads.find(t => t.id === focused)?.status !== 'open') focused = null; renderCards() } })
let chrome: ReturnType<typeof mountPage> | null = null, chromeSignature = ''
const APP_NAME = { recruiter: 'Recruiter', closer: 'Closer', 'rails-admin': 'Rails Admin' }
function hostDrawsApprove() { try { return window.frameElement?.getAttribute('data-approve-host') === '1' } catch { return false } }
const docFlags = () => kindSpec(scope)
const navList = () => docFlags().resolve ? open() : ordered()
function chromeSpec() {
  const flags = docFlags()
  const actions: PageAction[] = []
  if (boot.comment !== 'host') actions.push({ id: 'comment', label: flags.margin, kind: 'screen-only', placement: 'title', run: () => { openGeneralComment(); return { ok: true, speech: flags.margin === 'Ask' ? 'Ask about the whole doc.' : 'Comment on the whole doc.' } } })
  if (flags.approve && (boot.approve !== 'host' || !hostDrawsApprove()) && !isApproved() && !(queuedApproval && !queuedApproval.failed)) actions.push({ id: 'approve-scope', label: 'Approve scope', kind: 'move', placement: 'title', run: () => { openApproveDialog(); return { ok: true, speech: 'Approve scope is open.' } } })
  if (boot.voice !== false || typeof boot.voiceUrl === 'string' && /^https?:\/\//i.test(boot.voiceUrl)) actions.push({ id: 'voice', label: embed ? 'Talk' : 'Talk it through by voice', kind: 'screen-only', placement: embed ? 'title' : 'menu', run: () => { if (boot.voice !== false) $('#talk').click(); else window.open(boot.voiceUrl, '_blank', 'noopener'); return { ok: true, speech: 'Voice is open.' } } })
  return { title: [...(scope!.title || scope!.doc.sections.find(s => s.id === 'title')?.heading || slug)].slice(0, 80).join(''), description: flags.margin === 'Ask' ? `Explainer · revision ${scope!.revision}` : `${APP_NAME[appOf(scope!)]} · revision ${scope!.revision}`, back: boot.back && typeof boot.back.label === 'string' && typeof boot.back.route === 'string' ? boot.back : { label: flags.label, route: '/s/' }, actions, primary: actions.some(a => a.id === 'approve-scope') ? 'approve-scope' : undefined, chat: { onToggle: openGeneralComment }, initialize: false as const, forwardKeys: true }
}
function syncChrome() {
  if (!scope) return
  const spec = chromeSpec(), signature = JSON.stringify(spec)
  if (!chrome) chrome = mountPage($('#page'), spec)
  else if (signature !== chromeSignature) chrome.update(spec)
  chromeSignature = signature
}
let selection: Anchor | null = null, selectionTop = 0, composing: Anchor | null = null
let selectionRange: Range | null = null, selectionScrolling = false
let embedSelectionRect: { top: number; bottom: number; right: number } | null = null
type Sending = { clientId: string; id?: string; anchor?: Anchor; text: string; at: number }
const sending = new Map<string, Sending>()
const pending = new Set<string>()
function disablePending() { document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]').forEach(box => { if (uploading.get(box.dataset.draft!)) { const button = box.closest('.reply')?.querySelector<HTMLButtonElement>('.btn.primary'); if (button) button.disabled = true; box.closest('.reply')?.querySelectorAll<HTMLButtonElement>('[data-action="take"],[data-action="no"],[data-action="else"]').forEach(button => button.disabled = true) } }); document.querySelectorAll<HTMLElement>('.card').forEach(card => { const key = card.classList.contains('composer') ? card.querySelector<HTMLElement>('[data-draft]')?.dataset.draft : card.dataset.t; if (key && (pending.has(key) || sending.has(key))) card.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button => button.disabled = true) }) }
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
async function uploadPicture(bytes: Blob, type: string): Promise<CommentImage> {
  const res = await fetch(`${endpoint}/assets`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes })
  if (res.status === 404 || res.status === 405) throw new Error('Pictures need the newer Admin.')
  const result = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`)
  if (typeof result.id !== 'string') throw new Error('Could not upload picture')
  return { id: result.id, width: result.width, height: result.height }
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
      const image = await uploadPicture(bytes, file.type)
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
  const key = `composer:${composing?.section}:${composing?.embed ? composing.embed.src + ":" : ""}${composing?.quote}`
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
    nextReply.innerHTML = `<p class="composer-note">${fresh.classList.contains('parked') ? 'Parked' : 'Resolved'} while you were typing. Sending reopens it.</p><textarea></textarea>${imageStrip(getImages(kept.dataset.t), true, kept.dataset.t)}<p class="error" role="alert">${esc(errors.get(kept.dataset.t))}</p><div class="actions">${attachControl}<button class="btn primary" data-action="reply">${fresh.classList.contains('explainer') ? 'Ask' : fresh.classList.contains('comment') ? 'Reply' : 'Send'}</button></div>`
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
const marks = (id: string) => {
  const anchor = scope?.threads.find(t => t.id === id)?.anchor
  const stage = anchor?.embed && embedStage(anchor)
  return stage ? [stage] : [...doc.querySelectorAll<HTMLElement>(`mark[data-t="${id}"]`)]
}
const hidden = (mark: HTMLElement) => !!mark.closest('details:not([open]),[role="tabpanel"][hidden]')
const ordered = () => scope ? orderThreads(scope) : []
const open = () => ordered().filter(t => t.status === 'open')
function unread(t: Thread) {
  const last = t.messages.at(-1), alex = t.messages.filter(m => m.from === 'alex').at(-1)
  return t.status === 'open' && !!alex && last?.from === 'agent' && Date.parse(last.at) > Date.parse(alex.at) && Date.parse(last.at) > Date.parse(storage.get(`scope:seen:${slug}:${t.id}`) || '1970-01-01')
}
function markSeen(id: string) { const t = scope?.threads.find(t => t.id === id); if (t && unread(t)) storage.set(`scope:seen:${slug}:${id}`, t.messages.at(-1)!.at) }
function syncThreadClasses() {
  for (const t of ordered()) for (const mark of marks(t.id)) { mark.classList.toggle('unread', unread(t)) }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
  const result = await res.json(); if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`); return result
}
const endpoint = `${apiBase}/${encodeURIComponent(slug)}`
type QueuedApproval = { clientId: string; comment: string; mode: string; failed: boolean; timer?: number }
let queuedApproval: QueuedApproval | null = null
function isApproved() { return scope?.approval?.mode === 'approve_to_try' || scope?.approval?.mode === 'approve' || scope?.approval?.mode === 'approve_with_changes' }
function approvalBanner() {
  if (!docFlags().approve) return ''
  if (queuedApproval) return `<div class="approval" data-cm-skip role="status"><strong>${queuedApproval.failed ? "Couldn't approve. Try again." : 'Sending…'}</strong>${queuedApproval.comment ? `<div class="approval-note">${esc(queuedApproval.comment)}</div>` : ''}</div>`
  return approvalBannerHtml(scope?.approval)
}
const approveDialog = document.createElement('dialog')
approveDialog.className = 'approve'
approveDialog.innerHTML = `<h2>Approve this scope</h2><p class="approve-count"></p><fieldset><legend>What happens next?</legend><label><input type="radio" name="approve-mode" value="approve_to_try">Approve to try</label><label><input type="radio" name="approve-mode" value="approve" checked>Approve and ship</label><label><input type="radio" name="approve-mode" value="approve_with_changes">Approve with changes: the lane folds your note in first</label><label><input type="radio" name="approve-mode" value="not_yet">Not yet: just send the note</label></fieldset><label class="approve-note-label" for="approve-note">Final note</label><textarea id="approve-note" placeholder="Anything the builder should know?" maxlength="4000" rows="5"></textarea><p class="error" role="alert"></p><div class="actions"><button type="button" class="btn" data-action="approve-cancel">Cancel</button><button type="button" class="btn primary" data-action="approve-submit">Approve and build</button></div>`
document.body.append(approveDialog)
let approving = false
const approveMode = () => $<HTMLInputElement>('input[name="approve-mode"]:checked', approveDialog).value
function updateApproveDialog() {
  const mode = approveMode(), count = scope?.threads.filter(t => t.status === 'open').length || 0
  $('.approve-count', approveDialog).textContent = mode === 'not_yet' ? 'Threads stay open.' : count === 0 ? 'No open threads.' : `${count} open thread${count === 1 ? ' closes' : 's close'} with the lane's recommendation.`
  const button = $<HTMLButtonElement>('[data-action="approve-submit"]', approveDialog)
  button.textContent = mode === 'approve_to_try' ? 'Approve to try' : mode === 'approve' ? 'Approve and ship' : mode === 'approve_with_changes' ? 'Approve with changes' : 'Send, not yet'
  button.disabled = approving || !['approve', 'approve_to_try'].includes(mode) && !$<HTMLTextAreaElement>('textarea', approveDialog).value.trim()
}
function openApproveDialog() {
  if (!scope || !docFlags().approve || isApproved() || queuedApproval && !queuedApproval.failed || approveDialog.open) return
  $<HTMLInputElement>(`input[value="${queuedApproval?.failed ? queuedApproval.mode : (scope as ScopeV2 & { approve_default?: string }).approve_default === 'try' ? 'approve_to_try' : 'approve'}"]`, approveDialog).checked = true
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
  syncChrome()
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
  const client_id = typeof body.client_id === 'string' && body.client_id ? body.client_id : clientId()
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
async function postThread(body: { anchor: Anchor; text: string; via?: 'voice'; images?: string[]; client_id?: string }) { return write('', body) }
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
type LiveItem = { id: string; type: 'reply'; thread: string; to: string; by: string; status: 'seen' | 'thinking' | 'streaming' | 'done' | 'failed'; doing: { text: string; link?: string } | null; text: string; error?: string; seq: number; updated_at: string }
const items = new Map<string, LiveItem>()
const liveRank = { seen: 0, thinking: 1, streaming: 2, done: 3, failed: 3 }
function mergeItem(item: LiveItem) {
  const previous = items.get(item.id)
  if (previous && (item.seq <= previous.seq || liveRank[item.status] < liveRank[previous.status])) return false
  items.set(item.id, item); return true
}
const latestAlex = (t: Thread) => t.messages.filter(m => m.from === 'alex').at(-1)
const currentItem = (t: Thread) => { const at = latestAlex(t)?.at; return [...items.values()].find(item => item.thread === t.id && item.to === at) }
function seenBy(t: Thread) {
  const item = currentItem(t)
  if (item) return item.by || 'the lane'
  const note = [...notes.values()].filter(n => n.thread === t.id && n.from === 'alex' && !['lane_note', 'approve', 'approve_to_try', 'approve_with_changes', 'not_yet'].includes(n.event)).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1)
  if (note?.read_by) return note.read_by
  return t.reaction?.emoji === '👀' ? 'the lane' : ''
}
function queuePlaces() {
  const places = new Map<string, string>()
  if (!scope || docFlags().answerer || (scope as ScopeV2 & { answerer?: string }).answerer === 'on') return places
  const waiting = scope.threads.filter(t => { const last = latestAlex(t); return t.status === 'open' && last && !t.messages.some(m => m.from !== 'alex' && m.at > last.at) }).sort((a, b) => latestAlex(a)!.at.localeCompare(latestAlex(b)!.at) || Number(a.id.slice(1)) - Number(b.id.slice(1)))
  if (waiting.length < 2) return places
  let previous: Thread | undefined
  for (const t of waiting) {
    if (['thinking', 'streaming'].includes(currentItem(t)?.status || '')) continue
    places.set(t.id, previous ? `After ${previous.id}` : 'Next'); previous = t
  }
  return places
}
function thinkingHtml(doing: LiveItem['doing']) {
  // Activity links, like answer links, must not turn an item into executable markup.
  const link = doing?.link && /^https?:\/\//i.test(doing.link) ? doing.link : ''
  return `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="doing">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(doing!.text)}</a>` : esc(doing?.text || 'Thinking')}</span>`
}
function patchLiveCard(card: HTMLElement, t: Thread, places: Map<string, string>) {
  const last = latestAlex(t)
  const message = [...card.querySelectorAll<HTMLElement>('[data-alex-at]')].find(n => n.dataset.alexAt === last?.at)
  if (!message) return
  message.dataset.liveTurn = ''
  const by = seenBy(t)
  let reaction = card.querySelector<HTMLElement>('.reaction')
  if (!by) reaction?.remove()
  else {
    if (!reaction) { reaction = document.createElement('span'); reaction.className = 'reaction'; reaction.setAttribute('role', 'img'); reaction.textContent = '👀'; message.append(reaction) }
    reaction.title = `Seen by ${by}`; reaction.setAttribute('aria-label', reaction.title)
  }
  const item = currentItem(t)
  const pending = card.querySelector<HTMLElement>('.answer.pending')
  if (item) pending?.remove()
  const replied = t.messages.some(m => m.from !== 'alex' && m.at > last!.at && !(m as AnswerMessage).pending)
  const show = item && !replied && ['thinking', 'streaming', 'done'].includes(item.status)
  let live = card.querySelector<HTMLElement>('.live:not(.pending)')
  if (!show) live?.remove()
  else {
    if (!live) { live = document.createElement('div'); live.className = 'msg live'; live.setAttribute('aria-live', 'polite'); live.innerHTML = `<div class="from">${docFlags().qa ? 'Answer' : 'Lane'}</div>`; message.after(live) }
    live.dataset.status = item.status
    let text = live.querySelector<HTMLElement>('.live-text')
    if (!item.text) text?.remove()
    else { if (!text) { text = document.createElement('div'); text.className = 'live-text answer-body'; live.append(text) }; if (text.dataset.source !== item.text) { text.innerHTML = answerHtml(item.text); text.dataset.source = item.text } }
    let thinking = live.querySelector<HTMLElement>('.thinking')
    if (item.status !== 'thinking' && !(item.status === 'streaming' && item.doing)) thinking?.remove()
    else { if (!thinking) { thinking = document.createElement('p'); thinking.className = 'thinking'; thinking.setAttribute('role', 'status'); live.append(thinking) }; const html = thinkingHtml(item.doing); if (thinking.innerHTML !== html) thinking.innerHTML = html }
  }
  let failed = card.querySelector<HTMLElement>('.live-failed')
  if (item?.status !== 'failed' || replied) failed?.remove()
  else {
    card.querySelectorAll('.live, .thinking').forEach(n => n.remove())
    if (!failed) { failed = document.createElement('p'); failed.className = 'live-failed'; message.after(failed) }
    failed.textContent = `${item.by || 'the lane'} couldn't reply: ${item.error || 'it stopped'}`
  }
  let queue = card.querySelector<HTMLElement>('.queue-place')
  const place = places.get(t.id)
  if (!place) queue?.remove()
  else { if (!queue) { queue = document.createElement('span'); queue.className = 'queue-place'; const q = card.querySelector('.q'); if (q) q.prepend(queue); else card.querySelector('.head')?.append(queue) }; queue.textContent = place }
  if (by) { const chip = card.querySelector('.delivery-chip'); if (chip && /^(Sent|Read by|Seen)/.test(chip.textContent || '')) chip.remove() }
}
function patchLive() {
  if (!scope) return
  const places = queuePlaces(); let changed = false
  document.querySelectorAll<HTMLElement>('.card[data-t]').forEach(card => {
    const t = scope!.threads.find(t => t.id === card.dataset.t); if (!t) return
    const height = card.offsetHeight; patchLiveCard(card, t, places); changed ||= height !== card.offsetHeight
  })
  const line = inflight(), titleLine = doc.querySelector<HTMLElement>('.inflight')
  if (titleLine && titleLine.textContent !== line) { titleLine.textContent = line; titleLine.hidden = !line; changed = true }
  if (changed) layout()
}
type CommentState = 'Sending…' | 'Sent' | `Read by ${string}` | 'Seen 👀' | 'Answered' | 'Retrying' | 'Not sent' | 'No lane pane'
const commentStates = new Map<string, { state: CommentState; takenAt?: number; timer?: number }>()
function delivery(id: string): CommentState | '' {
  const note = [...notes.values()].filter(n => n.thread === id && n.from === 'alex' && !['lane_note', 'approve', 'approve_to_try', 'approve_with_changes', 'not_yet'].includes(n.event)).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1)
  const thread = scope?.threads.find(t => t.id === id), section = scope?.doc.sections.find(s => s.id === thread?.anchor.section)
  if (!note) {
    const state = (thread as Thread & { delivery?: string })?.delivery
    if (state === 'in_doc') return 'Answered'
    if (state !== 'with_lane' && state !== 'queued') return thread && seenBy(thread) ? 'Seen 👀' : ''
    const lastAlex = thread?.messages.filter(m => m.from === 'alex').at(-1)
    const taken = lastAlex && (thread?.messages.some(m => m.from !== 'alex' && m.at > lastAlex.at) || (section as DocSection & { updated_at?: string })?.updated_at! > lastAlex.at) || thread?.status === 'resolved' && thread.resolution?.confirmed_at
    return taken ? 'Answered' : thread && seenBy(thread) ? 'Seen 👀' : state === 'queued' ? 'Sending…' : 'Sent'
  }
  if (note.delivery === 'delivered' && (thread?.messages.some(m => m.from !== 'alex' && m.at > note.delivered_at) || (section as DocSection & { updated_at?: string })?.updated_at! > note.delivered_at || thread?.status === 'resolved' && thread.resolution?.confirmed_at)) return 'Answered'
  if (thread && seenBy(thread) && !['retrying', 'failed', 'no_pane'].includes(note.delivery)) return 'Seen 👀'
  return ({ held: 'Sending…', delivered: 'Sent', queued: 'Sending…', retrying: 'Retrying', failed: 'Not sent', no_pane: 'No lane pane' } as Record<string, CommentState>)[note.delivery] || ''
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
  return entry && !entry.state.startsWith('Read by ') && entry.state !== 'Seen 👀' && (entry.state !== 'Answered' || entry.takenAt && Date.now() - entry.takenAt < 30_000) ? `<span class="delivery-chip">${esc(entry.state)}</span>` : ''
}
function inflight() {
  const states = scope!.threads.map(t => delivery(t.id))
  const count = (state: CommentState) => states.filter(s => s === state).length
  const read = states.filter(s => s.startsWith('Read by ')).length
  const sending = count('Sending…'), sent = count('Sent'), seen = count('Seen 👀') + read, answered = count('Answered')
  if (!read && !sending && !sent && !seen) return ''
  const total = sending + sent + seen + answered
  return `${total} comment${total === 1 ? '' : 's'} · ` + [[answered, 'Answered'], [seen, 'Seen'], [sent, 'Sent'], [sending, 'Sending…']].filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ')
}
const deleting = new Set<string>(), copiedLinks = new Set<string>()
const checkButton = '<button type="button" class="check" data-action="resolve" aria-label="Resolve" title="Resolve"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg></button>'
const moreButton = '<button class="more" data-action="menu" aria-label="More" aria-haspopup="menu">⋯</button>'
type AnswerMessage = Thread['messages'][number] & { answerer?: boolean; pending?: boolean; needs_owner?: boolean; handoff?: boolean }
const answerBody = (text: string) => `<div class="answer-body">${answerHtml(text)}</div>`
function answerMessageHtml(message: AnswerMessage, latest: boolean) {
  const pending = message.pending === true, text = (message.text || '').trim()
  const partial = pending && text && !/^Answering(?:…|\.\.\.)?$/.test(text) ? message.text : ''
  const body = pending ? `${partial ? `<div class="live-text answer-body">${answerHtml(partial)}</div>` : ''}<p class="thinking" role="status">${thinkingHtml(null)}</p>` : answerBody(message.text)
  const note = message.needs_owner || message.handoff ? '<p class="answer-note">Sent to the owner</p>' : ''
  return `<div${pending ? ' data-status="thinking" aria-live="polite"' : ''} class="msg answer${pending ? ' pending live' : ''}${latest ? ' latest' : ' only-on'}"><div class="from">Answer${pending ? '' : `<span>${time(message.at)}</span>`}</div>${body}${note}${imageStrip(message.images)}</div>`
}
// One exchange after another, in order. A card that is not focused shows the question, the follow-up that the newest
// answer replies to (if any) and the start of that answer; focusing it shows the whole thread.
function explainerCardHtml(t: Thread) {
  const messages = t.messages as AnswerMessage[]
  const newestAt = messages.reduce((found, message, i) => i > 0 && message.from === 'agent' && message.answerer ? i : found, -1)
  const menu = threadMenu(t)
  const reply = !sending.has(t.id) ? `<div class="reply only-on"><textarea data-draft="${t.id}" rows="${modes.has(t.id) ? 2 : 1}" placeholder="Ask a follow-up">${esc(getDraft(t.id))}</textarea>${imageStrip(getImages(t.id), true, t.id)}<p class="error" role="alert">${esc(errors.get(t.id))}</p><div class="actions">${attachControl}<button class="btn primary" data-action="reply">Ask</button>${modes.has(t.id) ? '<button class="btn" data-action="cancel">Cancel</button>' : ''}</div></div>` : ''
  const state = [copiedLinks.has(t.id) ? 'Link copied' : '', t.anchor.general ? 'Whole doc' : t.anchor.t != null ? `<span class="moment">at ${moment(t.anchor.t)}</span>` : ''].filter(Boolean).join(' · ')
  const thread = messages.slice(1).map((message, k) => {
    const i = k + 1
    if (message.from === 'agent' && message.answerer) return answerMessageHtml(message, i === newestAt)
    if (message.from === 'alex') return `<div data-alex-at="${esc(message.at)}" class="msg follow${i === newestAt - 1 ? '' : ' only-on'}"><div class="q">${esc(message.text)}</div>${imageStrip(message.images)}</div>`
    return `<div class="msg only-on"><div class="from">Lane<span>${time(message.at)}</span></div><div>${esc(message.text)}</div>${imageStrip(message.images)}</div>`
  }).join('')
  return `<div class="head"><span class="kind"><span class="who">You asked</span></span><span class="when">${time(t.created_at)}</span>${moreButton}</div>${menu}<div class="q" data-alex-at="${messages[0]?.from === 'alex' ? esc(messages[0].at) : ''}">${esc(messages[0]?.text)}</div>${imageStrip(messages[0]?.images)}${state ? `<p class="card-state">${state}</p>` : ''}${thread}${sending.has(t.id) ? sendingLine(sending.get(t.id)!) : reply}`
}
function threadMenu(t: Thread) {
  if (!menus.has(t.id)) return ''
  if (deleting.has(t.id)) return '<div class="menu" role="menu"><p>Delete this note?</p><button role="menuitem" data-action="confirm-delete">Delete</button><button role="menuitem" data-action="menu-cancel">Cancel</button></div>'
  if (!docFlags().resolve) return `<div class="menu" role="menu"><button role="menuitem" data-action="menu-reply">Reply</button><button role="menuitem" data-action="copy-link">Copy link</button>${!missing.has(t.id) ? '<button role="menuitem" data-action="jump-text">Jump to text</button>' : ''}${(t.author ?? t.messages[0]?.from) === 'alex' ? '<button role="menuitem" data-action="delete">Delete</button>' : ''}</div>`
  return `<div class="menu" role="menu"><button role="menuitem" data-action="menu-reply">Reply</button><button role="menuitem" data-action="${t.status === 'open' ? 'resolve' : 'reopen'}">${t.status === 'open' ? 'Resolve' : 'Reopen'}</button>${t.status === 'open' && t.kind === 'question' ? '<button role="menuitem" class="tall" data-action="park">Not now<small>Park it without answering</small></button>' : ''}<button role="menuitem" data-action="copy-link">Copy link</button>${!missing.has(t.id) ? '<button role="menuitem" data-action="jump-text">Jump to text</button>' : ''}${(t.author ?? t.messages[0]?.from) === 'alex' ? '<button role="menuitem" data-action="delete">Delete</button>' : ''}</div>`
}
function closeMenus() { if (!menus.size) return; menus.clear(); deleting.clear(); renderCards() }
function openMenu(id: string, point?: { x: number; y: number }) {
  menus.clear(); deleting.clear(); menus.add(id); focus(id)
  const menu = (phone() ? sheet : document).querySelector<HTMLElement>(`.card[data-t="${id}"] .menu`)
  if (!menu) return
  if (point && !phone()) {
    const card = menu.closest<HTMLElement>('.card')!, rect = card.getBoundingClientRect(), bounds = menu.getBoundingClientRect()
    const left = Math.max(rect.left, Math.min(point.x, rect.right - bounds.width, innerWidth - bounds.width - 8))
    const top = Math.max(8, Math.min(point.y, innerHeight - bounds.height - 8))
    menu.style.right = 'auto'; menu.style.left = `${left - rect.left}px`; menu.style.top = `${top - rect.top}px`
  }
  menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
}
function baseCardHtml(t: Thread) {
  if (docFlags().qa) return explainerCardHtml(t)
  const isOpen = t.status === 'open', label = t.status === 'parked' ? 'Parked' : !isOpen ? 'Resolved' : t.kind === 'question' ? 'Lane asks' : 'You commented'
  if (t.status === 'resolved' && modes.get(t.id) !== 'reply') {
    const lastAlex = t.messages.reduce((index, m, i) => m.from === 'alex' ? i : index, -1), answer = t.messages.slice(Math.max(1, lastAlex + 1)).filter(m => m.from === 'agent').at(-1)
    return `<div class="head"><span class="kind"><span class="dot resolved"></span><span class="who">Resolved</span></span><span class="when">${time(t.created_at)}</span>${moreButton}</div>${threadMenu(t)}<div class="q" data-alex-at="${t.messages[0]?.from === 'alex' ? esc(t.messages[0].at) : ''}">${esc(t.messages[0]?.text)}</div>${imageStrip(t.messages[0]?.images)}${answer ? `<div class="msg"><div class="from">Lane<span>${time(answer.at)}</span></div><div>${esc(answer.text)}</div>${imageStrip(answer.images)}</div>` : ''}<div class="settled">${t.resolution?.how === 'approve' ? 'Approved with the scope:' : t.resolution?.by === 'agent' ? 'Lane resolved ·' : t.resolution?.how === 'take' ? 'You approved ·' : 'You resolved ·'} ${esc(t.resolution?.decision)}</div>${t.messages.slice(1).filter(message => message !== answer).map(message => imageStrip(message.images)).join('')}${imageStrip(t.resolution?.images)}<button class="btn" data-action="reopen">Reopen</button>${copiedLinks.has(t.id) ? '<p class="card-state">Link copied</p>' : ''}${errors.has(t.id) ? `<p class="error" role="alert">${esc(errors.get(t.id))}</p>` : ''}`
  }
  const mode = !sending.has(t.id) && (modes.get(t.id) || (t.kind === 'comment' && !t.recommendation ? 'reply' : null))
  const compose = mode && !(t.recommendation && mode === 'else') && { no: ["What's wrong with it? (optional)", 'Send No'], else: ['Your answer', 'Send answer'], reply: [t.kind === 'question' ? 'Ask the lane something' : 'Reply', t.kind === 'question' ? 'Send' : 'Reply'] }[mode]
  const menu = threadMenu(t)
  let body = ''
  if (compose && (isOpen || mode === 'reply')) body = `<div class="reply only-on"><textarea data-draft="${t.id}" rows="${modes.has(t.id) ? 2 : 1}" placeholder="${esc(compose[0])}">${esc(getDraft(t.id))}</textarea>${imageStrip(getImages(t.id), true, t.id)}<p class="error" role="alert">${esc(errors.get(t.id))}</p><div class="actions">${attachControl}<button class="btn primary" data-action="${t.kind === 'comment' ? 'reply' : 'send'}">${compose[1]}</button>${modes.has(t.id) ? '<button class="btn" data-action="cancel">Cancel</button>' : ''}</div></div>`
  else if (isOpen && t.rejected_at) body = '<div class="waiting"><span class="dot"></span>Rejected, waiting for a new option</div>'
  else if (isOpen && (t.kind === 'question' || t.recommendation)) {
    // Alex, 2026-10-02 19:45 ET: a note is a reply to the lane, never a decision; Approve takes the recommendation.
    const approve = t.recommendation ? '<button class="btn primary" data-action="take">Approve</button>' : ''
    body = `<div class="reply only-on"><textarea data-draft="${t.id}" rows="1" placeholder="Reply to the lane · ⌘Enter sends">${esc(getDraft(t.id))}</textarea>${imageStrip(getImages(t.id), true, t.id)}<p class="error" role="alert">${esc(errors.get(t.id))}</p><div class="actions">${attachControl}<button class="btn${approve ? '' : ' primary'}" data-action="reply">Reply</button>${approve}${approve && t.kind !== 'question' ? '<button class="btn" data-action="no">Reject</button>' : ''}</div>${approve ? '<p class="pick-hint">Approve takes the recommendation; a note goes with it.</p>' : ''}</div>`
  }
  const newRec = !t.rejected_at && t.messages.some(m => m.kind === 'option')
  const state = [copiedLinks.has(t.id) ? 'Link copied' : deliveryChip(t.id), t.anchor.embed ? `<button class="btn small" data-action="jump-text">${missing.has(t.id) ? 'Embed changed' : 'Embed ' + esc(t.anchor.embed.src)} · <q>${esc(t.anchor.embed.quote)}</q></button>` : t.anchor.general ? 'General comment' : t.anchor.t != null ? `<span class="moment">at ${moment(t.anchor.t)}</span>` : ''].filter(Boolean).join(' · ')
  return `<div class="head"><span class="kind"><span class="dot ${isOpen ? t.kind : 'resolved'}"></span><span class="who">${label}</span></span>${unread(t) ? '<span class="unread-dot" aria-label="New answer"></span>' : ''}<span class="when">${time(t.created_at)}</span>${isOpen ? checkButton : ''}${moreButton}</div>${menu}<div class="q" data-alex-at="${t.messages[0]?.from === 'alex' ? esc(t.messages[0].at) : ''}">${esc(t.messages[0]?.text)}</div>${imageStrip(t.messages[0]?.images)}${state ? `<p class="card-state">${state}</p>` : ''}
  ${isOpen && t.recommendation ? `<div class="rec${newRec ? ' new' : ''}"><span class="lbl">Recommended</span><span class="txt">${esc(t.recommendation)}</span></div>` : ''}
  ${isOpen && t.kind === 'question' && t.options?.length ? `<details class="other-options only-on"><summary>Other options (${t.options.length - 1})</summary>${t.options.slice(1).map((option, i) => `<div class="other-option"><span>${esc(option)}</span><button class="btn small" data-action="option" data-option="${i + 1}">Pick this</button></div>`).join('')}</details>` : ''}
  ${isOpen && t.why ? `<details class="why only-on"><summary>Why</summary><p>${esc(t.why)}</p></details>` : ''}
  ${t.messages.length > 1 ? `<div class="msgs only-on">${t.messages.slice(1).map((m, i) => `<div${m.from === 'alex' ? ` data-alex-at="${esc(m.at)}"` : ''} class="msg"><div class="from">${m.from === 'alex' ? 'You' : 'Lane'}<span>${time(m.at)}</span></div><div>${m.kind === 'reject' ? 'No' + (m.text ? ': ' : '') : ''}${esc(m.text)}</div>${imageStrip(m.images)}</div>`).join('')}</div>` : ''}
  ${!isOpen ? `<div class="settled">${t.status === 'parked' ? '<b>Parked.</b> Not answered; the lane leaves it for later.' : 'Resolved'}</div><button class="btn" data-action="reopen">Reopen</button>` : ''}${sending.has(t.id) ? sendingLine(sending.get(t.id)!) : body}${!compose && errors.has(t.id) ? `<p class="error" role="alert">${esc(errors.get(t.id))}</p>` : ''}`
}
function cardHtml(t: Thread) {
  const card = document.createElement('div'); card.innerHTML = baseCardHtml(t)
  patchLiveCard(card, t, queuePlaces())
  return card.innerHTML
}
function card(t: Thread) {
  const node = document.createElement('div'); node.className = `card ${t.kind} ${t.status}${docFlags().qa ? ' explainer' : ''}${unread(t) ? ' unread' : ''}${focused === t.id ? ' on' : ''}`; node.dataset.t = t.id; if (sending.has(t.id)) node.dataset.sending = 'true'; node.innerHTML = cardHtml(t); return node
}
function highlight() {
  missing.clear()
  for (const t of ordered()) {
    if (t.anchor.general) continue
    if (t.anchor.embed) { const stage = embedStage(t.anchor); if (!stage || embedMatches.get(t.id) === false) missing.add(t.id); continue }
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
  const pinnedCard = !phone() && !composing ? focusedCard() : null
  const pinnedRect = pinnedCard?.getBoundingClientRect()
  const pinnedLayoutTop = pinnedCard ? pinnedRect!.top - cards.getBoundingClientRect().top : null
  const pin = pinnedCard && pinnedRect && pinnedRect.bottom > 0 && pinnedRect.top < innerHeight ? { id: focused, top: pinnedRect.top } : null
  document.documentElement.style.overflowAnchor = pin ? 'none' : ''
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
      const replacement = document.createElement('div'); replacement.innerHTML = `<section id="${esc(s.id)}" data-section>${s.id === 'ask' ? `<details class="ask-fold"${askOpen ? ' open' : ''}><summary><svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg><h2>${esc(s.heading)}</h2></summary><div class="body">${markdown(s.body_md, scope!.doc.assets, `${endpoint}/assets`)}</div></details>` : `${s.id === 'title' ? `<h1 class="title-anchor">${esc(s.heading)}</h1>${approvalBanner()}` : `<h2>${esc(s.heading)}</h2>`}<div class="body ${s.id === 'title' ? 'lede' : ''}">${markdown(s.body_md, scope!.doc.assets, `${endpoint}/assets`)}</div>${s.id === 'title' ? `<p class="inflight" data-cm-skip${line ? '' : ' hidden'}>${esc(line)}</p>` : ''}`}</section>`
      const next = replacement.firstElementChild as HTMLElement
      if (node) node.replaceWith(next)
      node = next; redrawn.push(node)
      if (!first && (s.id !== 'title' || contentSignature(s) !== sectionContents.get(s.id))) {
        node.classList.add('changed')
        clearTimeout(changeTimers.get(s.id))
        changeTimers.set(s.id, window.setTimeout(() => { node!.classList.remove('changed'); changeTimers.delete(s.id) }, 4000))
      }
      node.querySelectorAll<HTMLElement>('.demo-stage').forEach(stage => { const remembered = stage.dataset.embedSrc ? demoHeights.get(stage.dataset.embedSrc) : undefined; stage.style.height = `${remembered ?? stage.dataset.height}px`; stage.dataset.title = stage.closest('figure')?.querySelector('figcaption')?.textContent || 'Demo' })
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
  document.title = scope.title; syncChrome(); highlight()
  if (pin && pin.id && missing.has(pin.id) && pinnedLayoutTop != null && !composing) detachedPin = { id: pin.id, top: pinnedLayoutTop }
  syncFigureFocus(); renderCards(); renderFeed()
  const restoreReference = () => {
    if (pin && focused === pin.id && !phone() && !composing) {
      const node = focusedCard()
      if (node) { const difference = node.getBoundingClientRect().top - pin.top; if (Math.abs(difference) > 1) scrollBy({ top: difference, behavior: 'instant' }); return }
    }
    const section = readingSection ? document.getElementById(readingSection) : null
    const anchor = composerAnchor && rangeFromAnchor(composerAnchor)?.range || (reading?.isConnected ? reading : section?.querySelectorAll('h1,h2,p,li,figure,pre,table')[readingIndex] || section?.querySelector('h1,h2'))
    if (anchor && readingTop != null) { const difference = anchor.getBoundingClientRect().top - readingTop; if (Math.abs(difference) > 1) scrollBy({ top: difference, behavior: 'instant' }) }
  }
  restoreReference()
  for (const node of redrawn) void renderMermaid(node, () => { layout(); restoreReference() })
  if (keepSelection) {
    const range = rangeFromAnchor(keepSelection)?.range
    if (range && sel) sel.setBaseAndExtent(backward ? range.endContainer : range.startContainer, backward ? range.endOffset : range.startOffset, backward ? range.startContainer : range.endContainer, backward ? range.startOffset : range.endOffset)
  }
  if (activeKey) { const target = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')].find(n => n.dataset.draft === activeKey && n.getClientRects().length); if (target && document.activeElement !== target) target.focus({ preventScroll: true }); if (caret != null) target?.setSelectionRange(caret, caretEnd ?? caret, direction || undefined) }
  watchDemos()
  postDemoPins()
  refreshEmbedMatches()
}
function renderCards() {
  syncFigureFocus()
  if (focused && document.visibilityState === 'visible' && document.querySelector(`.card.on[data-t="${focused}"]`)) markSeen(focused)
  syncThreadClasses()
  const byId = new Map(scope?.threads.map(t => [t.id, t]))
  const docOrder = scope ? orderThreads({ ...scope, threads: scope.threads.map(t => ({ ...t, status: 'open' })) }) : []
  const visible = docOrder.map(t => byId.get(t.id)!).filter(t => !docFlags().resolve || t.status === 'open' || showResolved || t.id === focused)
  const focusedNode = focusedCard()
  // While a new comment is being written the composer leads; a detached focused card goes to the Detached list as on main.
  const holds = (id: string) => !phone() && !composing && id === focused
  if (detachedPin?.id !== focused || !missing.has(focused || '') || composing) detachedPin = null
  if (!phone() && !composing && focusedNode && focused && missing.has(focused) && !detachedPin) detachedPin = { id: focused, top: focusedNode.parentElement === cards ? parseFloat(focusedNode.style.top) || 8 : focusedNode.getBoundingClientRect().top - cards.getBoundingClientRect().top }
  const active = document.activeElement as HTMLElement | null
  const activeCard = active?.matches('textarea[data-draft]') ? active.closest<HTMLElement>('.card') : null
  const retained = [...cards.querySelectorAll<HTMLTextAreaElement>('[data-retained-reply] textarea'), ...detached.querySelectorAll<HTMLTextAreaElement>('[data-retained-reply] textarea')].find(input => input.value.trim())?.closest<HTMLElement>('.card')
  const kept = activeCard && (activeCard.parentElement === cards || activeCard.parentElement === detached) ? activeCard : retained || focusedNode || null
  const composer = composing ? document.querySelector<HTMLElement>('.card.composer') : null
  const keptThread = kept?.dataset.t && scope?.threads.find(t => t.id === kept.dataset.t)
  if (keptThread && !visible.includes(keptThread)) refreshCard(kept!, card(keptThread))
  const makeCard = (t: Thread) => {
    const fresh = card(t)
    if (holds(t.id) && missing.has(t.id)) { const note = document.createElement('p'); note.className = 'anchor-note'; note.textContent = 'Section changed'; fresh.append(note) }
    const existing = kept?.dataset.t === t.id ? kept : focusedNode?.dataset.t === t.id ? focusedNode : null
    return existing ? refreshCard(existing, fresh) : fresh
  }
  const mainNodes: Node[] = visible.filter(t => !missing.has(t.id) || holds(t.id)).map(makeCard)
  if (composer?.parentElement === cards) {
    const range = composing && !composing.general && rangeFromAnchor(composing)?.range
    const at = !range ? 0 : mainNodes.findIndex(n => { const mark = marks((n as HTMLElement).dataset.t!)[0]; return mark && range.comparePoint(mark.firstChild!, 0) > 0 })
    mainNodes.splice(at < 0 ? mainNodes.length : at, 0, composer)
  }
  if (kept?.parentElement === cards && !mainNodes.includes(kept) && kept.dataset.t && (getDraft(kept.dataset.t).trim() || getImages(kept.dataset.t).length || uploading.get(kept.dataset.t))) mainNodes.push(kept)
  replaceAround(cards, mainNodes, kept?.parentElement === cards ? kept : composer)
  const gone = visible.filter(t => missing.has(t.id) && !holds(t.id))
  const detachedNodes: Node[] = gone.length ? [document.createTextNode('Detached · the text it was on changed'), ...gone.map(makeCard)] : []
  if (kept?.parentElement === detached && kept.dataset.t && !detachedNodes.includes(kept) && (getDraft(kept.dataset.t).trim() || getImages(kept.dataset.t).length || uploading.get(kept.dataset.t))) detachedNodes.push(kept)
  replaceAround(detached, detachedNodes, kept)
  for (const item of sending.values()) if (!item.id && item.anchor) {
    const node = document.createElement('div'); node.className = 'card comment on'; node.dataset.sending = 'true'; node.dataset.client = item.clientId
    node.innerHTML = `<div class="head"><span class="who">${docFlags().qa ? 'You asked' : 'You commented'}</span></div><div class="q">${esc(item.text)}</div>${sendingLine({ ...item, text: '' })}`
    if (item.anchor.general) cards.prepend(node); else cards.append(node)
  }
  if (composing) renderComposer()
  document.body.classList.toggle('show-resolved', !docFlags().resolve || showResolved)
  const resolvedCount = ordered().filter(t => t.status !== 'open').length, resolvedLabel = `Resolved (${resolvedCount})`
  const chip = $('#resolvedChip'); chip.textContent = resolvedLabel; chip.hidden = !docFlags().resolve || resolvedCount === 0; chip.setAttribute('aria-pressed', String(showResolved))
  if (!composing && phone() && document.body.classList.contains('sheet-open')) {
    const thread = scope?.threads.find(t => t.id === focused)
    if (thread) renderSheet()
  }
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
document.addEventListener('scope-tab-change', () => layout())
function layout() {
  layoutShots()
  if (phone()) return
  const base = cards.getBoundingClientRect().top
  const nodes = [...cards.querySelectorAll<HTMLElement>(':scope > .card')]
  for (const node of nodes) node.style.transitionProperty = node.dataset.t === focused ? 'background, border-color, box-shadow' : ''
  const want = nodes.map(n => {
    if (detachedPin && !composing && n.dataset.t === focused && detachedPin.id === focused) return detachedPin.top
    const queued = [...sending.values()].find(item => !item.id && item.clientId === n.dataset.client), range = queued?.anchor && rangeFromAnchor(queued.anchor)?.range
    if (queued?.anchor?.general || n.classList.contains('composer') && composing?.general) return 8
    const mark = marks(n.dataset.t!)[0], anchor = mark && !hidden(mark) && mark.getClientRects().length ? figureFor(mark) || mark : mark?.closest('details:not([open])')?.querySelector('summary')
    const embedAnchor = queued?.anchor || (n.classList.contains('composer') ? composing : scope?.threads.find(t => t.id === n.dataset.t)?.anchor)
    const stage = embedAnchor?.embed && embedStage(embedAnchor)
    if (stage) return Math.max(8, stage.getBoundingClientRect().top - base)
    const composerRange = n.classList.contains('composer') && composing && rangeFromAnchor(composing)?.range
    return Math.max(8, (n.classList.contains('composer') ? composerRange ? composerRange.getBoundingClientRect().top + scrollY : selectionTop : range ? range.getBoundingClientRect().top + scrollY : anchor ? anchor.getBoundingClientRect().top + scrollY : base + scrollY) - scrollY - base - (n.classList.contains('composer') ? 0 : 12))
  })
  const heights = nodes.map(n => n.offsetHeight)
  const pivot = nodes.findIndex(n => composing ? n.classList.contains('composer') : n.dataset.t === focused)
  const top = placeCards(nodes.map((n, i) => ({ want: want[i], height: n.offsetHeight })), pivot, detachedPin?.id === focused && !composing)
  nodes.forEach((n, i) => n.style.top = `${top[i]}px`)
  const height = nodes.length ? Math.max(...top.map((t, i) => t + heights[i])) + 20 : 0
  cards.style.height = `${height}px`; showSelection()
}
function updateCount() {
  const list = navList(), i = list.findIndex(t => t.id === focused), flags = docFlags()
  document.body.classList.toggle('explainer', flags.qa)
  commentsBar.update({ open: list.length, index: i + 1, total: list.length, showResolved, label: flags.resolve ? undefined : 'Questions', resolved: flags.resolve ? undefined : false })
  const resolvedToggle = document.querySelector<HTMLInputElement>('.side-head input[type="checkbox"]'); if (resolvedToggle) { resolvedToggle.id = 'showResolved'; const label = resolvedToggle.parentElement!; for (const node of [...label.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.textContent = ` Resolved (${ordered().filter(t => t.status !== 'open').length})` }
  const openLabel = $('#openLabel')
  if (!flags.resolve) { const count = document.createElement('span'); count.className = 'q-count'; count.textContent = String(list.length); openLabel.replaceChildren('Questions', count) }
  else openLabel.textContent = `${list.length} open`
}
// Only a click on a thread seeks its recording; scroll-follow, posting and redraws leave it where it is.
function seekMoment(id: string) {
  const anchor = scope?.threads.find(t => t.id === id)?.anchor as Anchor | undefined
  const figure = figureFor(marks(id)[0])
  const video = figure?.querySelector<HTMLVideoElement>('video')
  if (video && anchor?.t != null) video.currentTime = anchor.t
  const frame = figure?.querySelector('iframe')
  if (frame?.contentWindow && anchor?.t != null) frame.contentWindow.postMessage({ type: 'rails-demo/seek', v: 1, t: anchor.t, region: anchor.region ?? null, pause: true }, '*')
}
function threadTarget(id: string) {
  const thread = scope?.threads.find(t => t.id === id)
  if (thread?.anchor.general) return { node: document.getElementById('title'), general: true, fallback: true }
  const list = marks(id), mark = list.find(m => !hidden(m) && m.getClientRects().length)
  if (mark) return { node: figureFor(mark) || mark, general: false, fallback: false }
  return { node: list.length && !list.some(hidden) ? document.getElementById(thread?.anchor.section || '') : null, general: false, fallback: true }
}
function jumpThread(id: string, flash = false) {
  highlightEmbed(id)
  const target = threadTarget(id), node = target.node
  if (!node) return
  if (target.general) scrollTo({ top: phone() ? scrollY + node.getBoundingClientRect().top - 96 : 0, behavior: 'instant' })
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
  if (id) document.dispatchEvent(new CustomEvent('scope-thread-focus', { detail: id }))
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
function step(direction: number) { const list = navList(); if (!list.length) return; const index = list.findIndex(t => t.id === focused); focus(list[Math.max(0, Math.min(list.length - 1, index < 0 ? 0 : index + direction))].id, true) }
function renderSheet() {
  const t = scope?.threads.find(t => t.id === focused); if (!t) { closeSheet(); return }
  const list = navList(), i = list.findIndex(x => x.id === t.id)
  sheet.toggleAttribute('data-sending', sending.has(t.id)); if (sending.has(t.id)) sheet.dataset.sending = 'true'
  const fresh = document.createElement('div')
  fresh.innerHTML = `<div class="grab"></div><div class="quote">${t.anchor.embed ? `Embed ${esc(t.anchor.embed.src)} · <q>${esc(t.anchor.embed.quote)}</q>` : t.anchor.general ? (docFlags().margin === 'Ask' ? 'The whole doc' : 'General comment') : `On <q>${esc(t.anchor.quote)}</q>`}</div><div class="card on ${t.kind} ${t.status}${docFlags().qa ? ' explainer' : ''}" data-t="${t.id}">${cardHtml(t)}</div>${i >= 0 ? `<div class="nav"><span>${i + 1} of ${list.length}${docFlags().resolve ? ' open' : ''}</span><span class="spacer"></span><button class="icon-btn" data-go="-1" aria-label="Previous">↑</button><button class="icon-btn" data-go="1" aria-label="Next">↓</button></div>` : ''}`
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
  const rect = selection.embed ? embedSelectionRect : range && [...range.getClientRects()].filter(r => r.width > 0).at(-1)
  if (!rect) return
  const button = document.createElement('button'); button.className = 'add'; button.dataset.action = 'comment'; button.textContent = docFlags().margin
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
  else if (!selection?.embed && !document.activeElement?.closest('.card,.add')) { selection = null; selectionRange = null; showSelection() }
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

function menuThread(target: EventTarget | null) {
  if (!(target instanceof Element)) return null
  const node = target.closest<HTMLElement>('.card[data-t],mark.hl[data-t]'), thread = scope?.threads.find(t => t.id === node?.dataset.t)
  return thread && (!docFlags().resolve || thread.status === 'open' || showResolved || node?.classList.contains('card')) ? thread : null
}
document.addEventListener('contextmenu', e => {
  if (e.defaultPrevented || phone() || !zoom.hidden) return
  const thread = menuThread(e.target)
  if (!thread) return
  e.preventDefault(); openMenu(thread.id, { x: e.clientX, y: e.clientY })
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && menus.size) { e.preventDefault(); closeMenus(); return }
  const menu = (e.target as HTMLElement).closest('.menu')
  if (!menu || !['ArrowUp', 'ArrowDown'].includes(e.key)) return
  e.preventDefault()
  const items = [...menu.querySelectorAll<HTMLButtonElement>('button')], i = items.indexOf(e.target as HTMLButtonElement)
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
})
let holdTimer = 0, holdPoint: { x: number; y: number } | null = null, suppressThreadClick = 0
function cancelHold() { clearTimeout(holdTimer); holdPoint = null }
function startHold(target: EventTarget | null, x: number, y: number) {
  cancelHold()
  if (!phone()) return
  const thread = menuThread(target)
  if (!thread || (target as Element).closest('button,textarea,input,a')) return
  holdPoint = { x, y }; holdTimer = window.setTimeout(() => { suppressThreadClick = Date.now() + 1500; openMenu(thread.id) }, 500)
}
function moveHold(x: number, y: number) { if (holdPoint && Math.hypot(x - holdPoint.x, y - holdPoint.y) > 10) cancelHold() }
document.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') startHold(e.target, e.clientX, e.clientY) })
document.addEventListener('pointermove', e => moveHold(e.clientX, e.clientY))
for (const event of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) document.addEventListener(event, cancelHold)
document.addEventListener('touchstart', e => { const touch = e.touches[0]; if (touch) startHold(e.target, touch.clientX, touch.clientY) }, { passive: true })
document.addEventListener('touchmove', e => { const touch = e.touches[0]; if (touch) moveHold(touch.clientX, touch.clientY) }, { passive: true })
function focusHash() {
  const id = location.hash.match(/^#thread=(T\d+)$/)?.[1], thread = scope?.threads.find(t => t.id === id)
  if (!thread) return
  if (thread.status !== 'open') { showResolved = true; storage.set('scope:showResolved', 'true') }
  focus(thread.id, true)
}
window.addEventListener('hashchange', focusHash)

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
  const flags = docFlags(), ask = flags.margin === 'Ask'
  const fresh = document.createElement('div'); fresh.className = `card composer comment on${flags.qa ? ' explainer' : ''}`; fresh.innerHTML = `<div class="head">${flags.qa ? '' : '<span class="dot comment"></span>'}<span class="who">${flags.qa ? 'You asked' : 'You commented'}</span></div><div class="reply">${composing?.t != null ? `<div class="moment">At ${moment(composing.t)}</div>` : ''}<textarea rows="2" data-draft="${esc(key)}" placeholder="${ask ? (composing?.general ? 'Ask about the whole doc' : 'Ask about this text') : composing?.general ? 'Comment on the whole doc' : composing?.t != null ? 'Comment on this moment' : 'Comment on this text'}">${esc(getDraft(key))}</textarea>${imageStrip(getImages(key), true, key)}<p class="error">${esc(errors.get(key))}</p><div class="actions">${attachControl}<button class="btn primary" data-action="post">${flags.margin}</button><button class="btn" data-action="cancel">Cancel</button></div></div>`
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
  if (name === 'attach') { target.closest('.reply')?.querySelector<HTMLInputElement>('[data-images]')?.click(); return }
  if (name === 'remove-image') { saveImages(key, getImages(key).filter((_, i) => i !== Number(target.dataset.image))); updateImageBox(key); return }
  if (pending.has(key) || sending.has(key) || uploading.get(key)) return
  const images = imageSnapshot ?? getImages(key).map(image => image.id), pictures = images.length ? { images } : {}
  const text = getDraft(key).trim()
  if (name === 'cancel') { if (t) { modes.delete(t.id); menus.delete(t.id); renderCards() } else { cancelComposer() }; return }
  if (t && name === 'menu') { if (menus.has(t.id)) closeMenus(); else openMenu(t.id); return }
  if (t && name === 'delete') { deleting.add(t.id); renderCards(); (phone() ? sheet : document).querySelector<HTMLButtonElement>(`.card[data-t="${t.id}"] .menu button`)?.focus(); return }
  if (name === 'menu-cancel') { closeMenus(); return }
  if (t && name === 'copy-link') {
    closeMenus()
    try { await navigator.clipboard.writeText(location.origin + location.pathname + location.search + '#thread=' + t.id); copiedLinks.add(t.id); renderCards(); window.setTimeout(() => { copiedLinks.delete(t.id); renderCards() }, 2000) }
    catch (error) { errors.set(t.id, error instanceof Error ? error.message : 'Could not copy'); renderCards() }
    return
  }
  if (t && name === 'jump-text') { closeMenus(); highlightEmbed(t.id); focus(t.id); marks(t.id)[0]?.scrollIntoView({ block: 'center' }); return }
  if (t && target.closest('.menu') && name !== 'menu-reply') { menus.delete(t.id); deleting.delete(t.id); renderCards() }
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
    else if (name === 'reopen') await write(`/${t.id}/reopen`, {}, t.id)
    else if (name === 'confirm-delete') { await write(`/${t.id}/delete`, {}, t.id); closeSheet(); focused = open()[0]?.id || null }
    if (getDraft(key).trim() === text) deleteDraft(key); errors.delete(key); modes.delete(t.id); menus.delete(t.id)
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
  const id = target.dataset.draft!, thread = scope?.threads.find(t => t.id === id)
  const reply = thread && (thread.kind === 'question' || thread.recommendation) && thread.status === 'open' && !modes.has(id)
  const button = target.closest('.reply')?.querySelector<HTMLElement>(reply ? '[data-action="reply"]' : '.btn.primary[data-action]')
  if (button) void action(button.dataset.action!, button)
})
function captionAnchorOf(figure: HTMLElement): Anchor | null {
  const caption = figure.querySelector('figcaption')
  if (!caption) return null
  const range = document.createRange(); range.selectNodeContents(caption)
  const anchor = anchorFromRange(range)
  if (!anchor) return null
  const video = figure.querySelector('video')
  if (video && video.currentTime >= .5) anchor.t = Math.round(video.currentTime * 10) / 10
  return anchor
}
const embedMatches = new Map<string, boolean>()
const embedConnections = new WeakMap<HTMLIFrameElement, { token: string; direct: boolean }>()
function embedStage(anchor: Anchor): HTMLElement | null {
  return [...(document.getElementById(anchor.section)?.querySelectorAll<HTMLElement>('.demo-stage') || [])].find(stage => stage.dataset.embedSrc === anchor.embed?.src) || null
}
function embedCommand(frame: HTMLIFrameElement, data: Record<string, unknown>) {
  const connection = embedConnections.get(frame)
  if (connection) frame.contentWindow?.postMessage({ type: 'rails-embed', token: connection.token, ...data }, '*') // opaque asset origin
}
function connectEmbed(frame: HTMLIFrameElement, stage: HTMLElement) {
  const token = crypto.randomUUID()
  for (const thread of scope?.threads || []) if (thread.anchor.embed && embedStage(thread.anchor) === stage) embedMatches.delete(thread.id)
  try {
    const child = frame.contentDocument
    if (child?.body && frame.contentWindow?.location.origin === location.origin) {
      embedConnections.set(frame, { token, direct: true })
      const read = () => {
        const sel = child.getSelection()
        if (!sel?.rangeCount || sel.isCollapsed || !child.body.contains(sel.anchorNode) || !child.body.contains(sel.focusNode)) return
        const range = sel.getRangeAt(0), { text, map } = sectionText(child.body)
        const inside = map.map((pos, i) => pos && range.comparePoint(pos.node, pos.offset) === 0 && !(pos.node === range.endContainer && pos.offset === range.endOffset) ? i : -1).filter(i => i >= 0)
        if (!inside.length) return
        const section = stage.closest<HTMLElement>('section[data-section]')!.id
        const anchor = makeAnchor(section, text, inside[0], inside.at(-1)! + 1)
        if (anchor) receiveEmbedSelection(stage, anchor, range.getBoundingClientRect())
      }
      for (const event of ['selectionchange', 'pointerup', 'mouseup']) child.addEventListener(event, () => window.setTimeout(read, 80))
      refreshEmbedMatches(); if (focused) highlightEmbed(focused); return
    }
  } catch {} // sandboxed HTML deliberately has an opaque origin
  if (!stage.dataset.embedSrc?.startsWith('asset:')) return
  embedConnections.set(frame, { token, direct: false })
  embedCommand(frame, { action: 'init' })
}
function receiveEmbedSelection(stage: HTMLElement, quote: { quote: string; prefix: string; suffix: string }, rect: { top: number; bottom: number; right: number }) {
  const frameRect = stage.querySelector('iframe')!.getBoundingClientRect()
  selection = { section: stage.closest<HTMLElement>('section[data-section]')!.id, ...quote, embed: { src: stage.dataset.embedSrc!, ...quote } }
  selectionRange = null; selectionTop = frameRect.top + rect.top + scrollY
  embedSelectionRect = { top: frameRect.top + rect.top, bottom: frameRect.top + rect.bottom, right: frameRect.left + rect.right }
  showSelection()
}
function directEmbedRange(frame: HTMLIFrameElement, anchor: Anchor) {
  try {
    const child = frame.contentDocument
    if (!child?.body || !anchor.embed) return null
    const { text, map } = sectionText(child.body), found = locateEmbed(text, anchor.embed)
    const positions = found && map.slice(found.start, found.end).filter(p => p)
    if (!positions?.length) return null
    const first = positions[0]!, last = positions.at(-1)!, range = child.createRange()
    range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1)
    return range
  } catch { return null }
}
function refreshEmbedMatches() {
  for (const stage of doc.querySelectorAll<HTMLElement>('.demo-stage')) {
    const frame = stage.querySelector('iframe'), connection = frame && embedConnections.get(frame)
    if (!frame || !connection) continue
    const threads = (scope?.threads || []).filter(t => t.anchor.embed && embedStage(t.anchor) === stage)
    if (connection.direct) for (const thread of threads) embedMatches.set(thread.id, !!directEmbedRange(frame, thread.anchor))
    else embedCommand(frame, { action: 'match', anchors: threads.map(t => ({ id: t.id, anchor: t.anchor.embed })) })
  }
  updateEmbedDetached(); renderCards(); layout()
}
function updateEmbedDetached() {
  for (const thread of scope?.threads || []) if (thread.anchor.embed) {
    if (!embedStage(thread.anchor) || embedMatches.get(thread.id) === false) missing.add(thread.id)
    else missing.delete(thread.id)
  }
}
function highlightEmbed(id: string) {
  const anchor = scope?.threads.find(t => t.id === id)?.anchor
  const stage = anchor?.embed && embedStage(anchor), frame = stage && stage.querySelector('iframe')
  if (!anchor || !frame) return
  if (embedConnections.get(frame)?.direct) {
    const range = directEmbedRange(frame, anchor)
    if (range) { range.startContainer.parentElement?.scrollIntoView({ block: 'center' }); const sel = frame.contentDocument!.getSelection()!; sel.removeAllRanges(); sel.addRange(range) }
  } else embedCommand(frame, { action: 'highlight', anchor: anchor.embed })
}
const demoHeights = new Map<string, number>()
window.addEventListener('message', event => {
  const frame = [...doc.querySelectorAll<HTMLIFrameElement>('.demo-stage iframe')].find(frame => frame.contentWindow === event.source)
  if (frame) {
    const size = readDemoMessage(event.data)
    if (size?.type === 'rails-demo/size') {
      const stage = frame.closest<HTMLElement>('.demo-stage')!
      stage.style.height = `${size.h}px`
      if (stage.dataset.embedSrc) demoHeights.set(stage.dataset.embedSrc, size.h)
      layout()
      return
    }
  }
  if (event.data?.type !== 'rails-embed') return
  const connection = frame && embedConnections.get(frame)
  if (!frame || !connection || connection.direct || event.origin !== 'null' || event.data.token !== connection.token) return
  const stage = frame.closest<HTMLElement>('.demo-stage')!, data = event.data
  if (data.action === 'ready') { refreshEmbedMatches(); if (focused) highlightEmbed(focused) }
  if (data.action === 'selection' && typeof data.anchor?.quote === 'string' && data.anchor.quote.trim() && typeof data.anchor.prefix === 'string' && typeof data.anchor.suffix === 'string' && [data.rect?.top, data.rect?.bottom, data.rect?.right].every(Number.isFinite)) receiveEmbedSelection(stage, data.anchor, data.rect)
  if (data.action === 'matches' && Array.isArray(data.matches)) {
    for (const item of data.matches) if (typeof item.found === 'boolean' && scope?.threads.some(t => t.id === item.id && embedStage(t.anchor) === stage)) embedMatches.set(item.id, item.found)
    updateEmbedDetached(); renderCards(); layout()
  }
})
const demoFrames = new WeakMap<Window, HTMLElement>()
type DemoFigure = HTMLElement & { demoReady?: DemoReadyMessage }
function mountDemo(stage: HTMLElement) {
  if (stage.querySelector('iframe')) return
  const frame = document.createElement('iframe')
  frame.src = stage.dataset.src || ''
  frame.setAttribute('sandbox', stage.dataset.sandbox || '')
  if (stage.dataset.allow) frame.setAttribute('allow', stage.dataset.allow)
  frame.referrerPolicy = 'no-referrer'
  frame.title = stage.dataset.title || 'Demo'
  frame.loading = 'lazy'
  frame.addEventListener('load', () => connectEmbed(frame, stage), { once: true })
  stage.replaceChildren(frame)
  const figure = stage.closest('figure')
  if (frame.contentWindow && figure) demoFrames.set(frame.contentWindow, figure)
  layout()
}
const pendingStages = new Set<HTMLElement>()
const demoObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    const stage = entry.target as HTMLElement
    demoObserver.unobserve(stage)
    pendingStages.delete(stage)
    mountDemo(stage)
  }
}, { rootMargin: '200px' })
function watchDemos() {
  const live = new Set(doc.querySelectorAll<HTMLElement>('.demo-stage'))
  for (const stage of pendingStages) if (!live.has(stage)) { demoObserver.unobserve(stage); pendingStages.delete(stage) }
  for (const stage of live) {
    if (stage.querySelector('iframe') || pendingStages.has(stage)) continue
    pendingStages.add(stage)
    demoObserver.observe(stage)
  }
}
function postPins(figure: HTMLElement, frame: HTMLIFrameElement) {
  const anchor = captionAnchorOf(figure)
  if (!anchor || !scope || !frame.contentWindow) return
  frame.contentWindow.postMessage(demoPins(scope.threads, anchor), '*')
}
function postDemoPins() {
  if (!scope) return
  for (const frame of doc.querySelectorAll<HTMLIFrameElement>('.demo-stage iframe')) {
    const figure = frame.closest('figure')
    if (!figure || !frame.contentWindow || !demoFrames.has(frame.contentWindow)) continue
    postPins(figure, frame)
  }
}
function shotBlob(dataUrl: string) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}
function demoAck(frame: HTMLIFrameElement, id: string, ok: boolean, error?: string) {
  frame.contentWindow?.postMessage({ type: 'rails-demo/ack', v: 1, id, ok, ...(error ? { error } : {}) }, '*')
}
async function fileDemoNote(figure: HTMLElement, frame: HTMLIFrameElement, msg: DemoNoteMessage) {
  try {
    const caption = captionAnchorOf(figure)
    const note = caption && demoNote(msg, caption)
    if (!note?.anchor) { demoAck(frame, msg.id, false, 'No caption'); return }
    let shotId = ''
    if (msg.shot) shotId = (await uploadPicture(shotBlob(msg.shot), 'image/png')).id
    await postThread({ anchor: note.anchor, text: note.text, images: shotId ? [shotId] : [], client_id: `demo-${msg.id}` })
    demoAck(frame, msg.id, true)
  } catch (error) {
    const reason = (error instanceof Error ? error.message : 'Could not file the note').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Could not file the note'
    demoAck(frame, msg.id, false, reason)
  }
}
window.addEventListener('message', event => {
  const source = event.source
  if (!source || source === window) return
  const figure = demoFrames.get(source as Window)
  if (!figure?.isConnected || !scope) return
  const msg = readDemoMessage(event.data)
  if (!msg) return
  const frame = figure.querySelector('iframe')
  if (!frame || frame.contentWindow !== source) return
  if (msg.type === 'rails-demo/ready') { (figure as DemoFigure).demoReady = msg; postPins(figure, frame) }
  else if (msg.type === 'rails-demo/note') void fileDemoNote(figure, frame, msg)
})
document.addEventListener('click', e => {
  if (Date.now() < suppressThreadClick) { e.preventDefault(); return }
  const target = e.target as HTMLElement
  if (!target.closest('.menu,[data-action="menu"]')) closeMenus()
  const thumbnail = target.closest<HTMLButtonElement>('button.thumb[data-action="view-image"]'); if (thumbnail) { lightboxOpener = thumbnail; lightboxItems = [...thumbnail.closest('.thumbs')!.querySelectorAll<HTMLButtonElement>('button.thumb')]; lightboxIndex = lightboxItems.indexOf(thumbnail); showLightboxImage(); lightbox.showModal(); return }
  if (lightbox.contains(target)) return
  const shot = target.closest<HTMLButtonElement>('button.shot'); if (shot) { openZoom(shot); return }
  if (!zoom.hidden) return
  const figureButton = target.closest<HTMLButtonElement>('button.fig-comment')
  if (figureButton) {
    const figure = figureButton.closest('figure')
    const anchor = figure && captionAnchorOf(figure)
    if (!figure || !anchor) return
    composing = anchor; selection = null; selectionTop = figure.getBoundingClientRect().top + scrollY
    renderCards(); $('.composer textarea', phone() ? sheet : cards).focus(); return
  }
  const button = target.closest<HTMLElement>('[data-action]')
  if (button) { void action(button.dataset.action!, button); return }
  const go = target.closest<HTMLElement>('[data-go]'); if (go) { step(Number(go.dataset.go)); return }
  const mark = target.closest<HTMLElement>('mark[data-t]'); if (mark && (!mark.classList.contains('resolved') || !docFlags().resolve || showResolved)) { focus(mark.dataset.t!); seekMoment(mark.dataset.t!); return }
  const node = target.closest<HTMLElement>('.card[data-t]'); if (node && !target.closest('textarea,button,a,summary,details')) { if (node.dataset.t === focused && node.classList.contains('on')) return; focus(node.dataset.t!, true); seekMoment(node.dataset.t!); if (!phone()) focusBox(node.dataset.t!) }
})
document.addEventListener('input', e => { const input = e.target as HTMLTextAreaElement; if (!input.dataset.draft) return; setDraft(input.dataset.draft, input.value); const reply = input.closest('.card')?.querySelector<HTMLButtonElement>('[data-action="reply"]'); if (reply) { reply.hidden = !phone() && !input.value.trim() && !getImages(input.dataset.draft).length; reply.disabled = pending.has(input.dataset.draft) || !!uploading.get(input.dataset.draft) || !input.value.trim() && !getImages(input.dataset.draft).length }; layout() })
let selectionTimer = 0
for (const event of ['selectionchange', 'pointerup', 'mouseup']) document.addEventListener(event, () => { clearTimeout(selectionTimer); selectionTimer = window.setTimeout(readSelection, 80) })
$('#chipPrev').onclick = () => step(-1)
$('#chipNext').onclick = () => step(1)
$('#openLabel').onclick = () => { const list = navList(); focus(list.some(t => t.id === focused) ? focused : list[0]?.id || null, true) }
$('#scrim').onclick = closeSheet
$('#resolvedChip').onclick = () => { showResolved = !showResolved; storage.set('scope:showResolved', String(showResolved)); if (!showResolved && scope?.threads.find(t => t.id === focused)?.status !== 'open') focused = null; renderCards() }
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
addEventListener('scroll', () => { selectionScrolling = true; showSelection(); clearTimeout(scrollTimer); scrollTimer = window.setTimeout(() => { selectionScrolling = false; if (!zoom.hidden) return; showSelection(); if (phone() && document.body.classList.contains('sheet-open')) return; const cardRect = !phone() && focusedCard()?.getBoundingClientRect(); if (focused && (threadOnScreen(focused) || cardRect && cardRect.bottom > 0 && cardRect.top < innerHeight)) return; const next = open().find(t => threadOnScreen(t.id)); if (next) focus(next.id, false, false) }, 150) })
function context() { const sections = [...doc.querySelectorAll<HTMLElement>('section[data-section]')]; const section = sections.filter(n => n.getBoundingClientRect().top <= innerHeight * .3).at(-1) || sections[0]; return { thread: focused, section: section?.id || null, selection } }
function voiceUi(ui: ScopeVoiceUi) { if (ui.do === 'focus_thread') focus(ui.thread, true); if (ui.do === 'focus_section') document.getElementById(ui.section)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); if (ui.do === 'show_resolved') { showResolved = ui.on; storage.set('scope:showResolved', String(showResolved)); renderCards() }; if (ui.do === 'scroll') scrollBy({ top: innerHeight * .8 * (ui.direction === 'up' ? -1 : 1), behavior: 'smooth' }) }
const feedRows: (ScopeFeedLine & { at: Date })[] = []
let feedExpanded = false, feedClosed = false
const feed = document.createElement('div')
feed.className = 'voice-feed'; feed.setAttribute('aria-live', 'polite'); feed.setAttribute('aria-label', 'Voice activity'); feed.hidden = true
if (boot.voice !== false) document.body.append(feed)
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
  feed.innerHTML = `<div class="voice-feed-controls"><span class="voice-feed-heading">Voice activity</span>${feedRows.length > limit ? `<button class="voice-feed-toggle">${feedExpanded ? 'Show less' : `Show all (${feedRows.length})`}</button>` : ''}<button class="voice-feed-close" aria-label="Close voice activity">×</button></div><div class="voice-feed-list${feedExpanded ? ' expanded' : ''}">${visible.map(row => `<button class="voice-feed-row" data-ok="${row.ok}"${row.write ? ' data-write' : ''}${row.thread ? ` data-thread="${esc(row.thread)}"` : ''} title="${esc(row.at.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' ET')}"><span class="voice-feed-dot" aria-hidden="true"></span><span class="voice-feed-label">${esc(row.label)}</span>${row.write && row.thread ? `<span class="voice-feed-delivery">${esc(((s) => s === 'Sent' || s === 'Answered' || s.startsWith('Read by ') ? 'Sent to the lane' : s)(delivery(row.thread)))}</span>` : ''}</button>`).join('')}</div>`
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
$('#talk').onclick = async () => { if (boot.voice === false) return; try { const audio = prepareAudio(); const { mountVoice } = await import('./voice-mount'); mountVoice(audio, { getScope: async () => ({ slug, scope: scope! }), getContext: context, postThread, postReply, postResolve, postReject, postPark, fetchContext: q => api(`${endpoint}/context?q=${encodeURIComponent(q)}`), postLaneNote: body => api(`${endpoint}/lane-note`, { ...body, client_id: clientId() }), postApprove: async body => { const result = await api<{ queued?: boolean; client_id?: string }>(`${endpoint}/approve`, body); if (result.queued === true) trackQueuedApproval(result.client_id || body.client_id, body.mode, body.comment ?? ''); try { accept(await api(endpoint)) } catch {}; return result }, onFeed }, voiceUi, active => { if (active) { feedRows.length = 0; feedExpanded = false; feedClosed = false; renderFeed() }; $('#talk').classList.toggle('active', active) }) } catch (error) { $('#talk').title = error instanceof Error ? error.message : 'Voice unavailable' } }
let lastPayload = ''
function accept(payload: { scope: ScopeV2; notes?: any[]; items?: LiveItem[]; error?: string }) { const changed = (payload.items || []).map(mergeItem).some(Boolean); if (changed) patchLive(); if (!payload.scope) { lastPayload = ''; doc.textContent = payload.error || 'The lane has not published a doc yet.'; return }; const fingerprint = JSON.stringify({ scope: payload.scope, notes: payload.notes }); if (fingerprint === lastPayload) return; lastPayload = fingerprint
  const firstPayload = !scope
  scope = payload.scope
  settleQueuedApproval()
  publishApproval()
  const settled = new Set(scope.threads.flatMap(t => [...t.messages.map(m => (m as any).client_id), (t.resolution as any)?.client_id, (t as any).parked_client_id]).concat((payload.notes || []).map(note => note.client_id)))
  for (const [key, item] of sending) if (settled.has(item.clientId)) sending.delete(key)
  for (const note of payload.notes || []) notes.set(note.id, note); render(); if (firstPayload) focusHash() }
let lastOk = 0, stale = false
function goodRead() { lastOk = Date.now(); if (stale) { stale = false; chrome?.update({ updatedAt: undefined }) } }
function failedRead() { if (lastOk && !stale) { stale = true; chrome?.update({ updatedAt: lastOk, staleAfterMs: 60_000, onRefresh: () => void poll() }) } }
async function poll() { try { accept(await api(endpoint)); goodRead() } catch { failedRead() } }
async function start() {
  if (!slug) {
    const { scopes } = await api<{ scopes: { slug: string; title?: string; kind?: string }[] }>(apiBase)
    const row = (item: { slug: string; title?: string }) => `<a class="index-row" href="/s/${esc(item.slug)}">${esc(item.title || item.slug)}</a>`
    const group = (title: string, items: { slug: string; title?: string }[]) => items.length ? `<section class="index-group"><h2>${esc(title)}</h2>${items.map(row).join('')}</section>` : ''
    document.body.classList.add('index')
    doc.innerHTML = KIND_IDS.map((id) => group(DOC_KINDS[id].label, scopes.filter((item) => kindOf(item) === id))).join('')
    chrome = mountPage($('#page'), { title: 'Scoping', initialize: false }); return
  }
  if (boot.events === false) { await poll(); setInterval(() => void poll(), 2000); return }
  accept(await api(endpoint)); goodRead()
  const events = new EventSource(`${endpoint}/events`)
  events.addEventListener('item', e => { if (mergeItem(JSON.parse((e as MessageEvent).data))) patchLive(); goodRead() })
  events.addEventListener('state', e => { accept(JSON.parse((e as MessageEvent).data)); goodRead() })
  events.addEventListener('scope', e => { const data = JSON.parse((e as MessageEvent).data); accept(data.scope ? data : { scope: data }); goodRead() })
  events.addEventListener('note', e => { const note = JSON.parse((e as MessageEvent).data); notes.set(note.id, note); render(); goodRead() })
  events.onopen = goodRead
  events.onerror = failedRead
}
void start().catch(error => { doc.textContent = `Could not load: ${error.message}`; failedRead() })
