import { type Anchor, sectionLabel } from '../../../src/scope-anchor.js'
import { anchorFromRange, blockAnchor, blocks, rangeFromAnchor, rootFor, sectionOf } from './dom-anchor'

type Deps = { slug: string; notes(): any[]; postNote(body: any): Promise<any>; banner(text: string): void; noteNode(note: any): HTMLElement; autosize(ta: HTMLTextAreaElement): void }
const icon = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a3 3 0 0 1-3 3H9l-5 4v-4a3 3 0 0 1-2-3V5a3 3 0 0 1 3-3h13a3 3 0 0 1 3 3z"/></svg>'
const keyOf = (a: Anchor) => JSON.stringify([a.section, a.quote, a.prefix, a.suffix])
function ui(tag: string, className: string): HTMLElement { const el = document.createElement(tag); el.className = className; el.dataset.cmSkip = ''; return el }
function storage(key: string, value?: string | null) { try { if (value === undefined) return localStorage.getItem(key); if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch {} return null }
function highlight(name: string, ranges: Range[]) {
  const css = CSS as any, Highlight = (window as any).Highlight
  if (css.highlights && Highlight) css.highlights.set(name, new Highlight(...ranges))
}
export function createComments(deps: Deps) {
  const draftKey = `scope:${deps.slug}:cm`, seenKey = `scope:${deps.slug}:seen`
  const pill = ui('button', 'cm-pill') as HTMLButtonElement
  pill.type = 'button'; pill.hidden = true
  const layer = ui('div', 'cm-layer')
  document.body.append(layer, pill)
  let pending: Anchor | null = null, tapped: HTMLElement | null = null, composer: HTMLElement | null = null
  let draft: { anchor: Anchor; text: string } | null = null, openKey: string | null = null, frame = 0, selectionTimer = 0
  const expanded = new Set<string>(), replyDrafts = new Map<string, string>()
  const save = () => storage(draftKey, draft ? JSON.stringify(draft) : null)
  const active = (anchors: Anchor[]) => highlight('cm-active', anchors.flatMap((a) => { const r = rangeFromAnchor(a); return r ? [r.range] : [] }))
  let tappedAnchor: Anchor | null = null
  const clearTap = () => { tapped?.classList.remove('cm-tapped'); tapped = null; tappedAnchor = null }
  const hidePill = () => { pill.hidden = true; pending = null }
  type ReplyFocus = { key: string; start: number; end: number }
  let savedFocus: ReplyFocus | null = null
  function beforeRender() {
    const ta = document.activeElement
    if (ta instanceof HTMLTextAreaElement && ta.dataset.cmReply) savedFocus = { key: ta.dataset.cmReply, start: ta.selectionStart, end: ta.selectionEnd }
  }
  function dockHeight() { return document.getElementById('dock')?.getBoundingClientRect().height || 72 }
  function detachedTarget(anchor: Anchor): HTMLElement | null {
    const root = rootFor(anchor)
    const target = anchor.section.startsWith('q:') ? root?.querySelector<HTMLElement>('.q-text') || document.querySelector<HTMLElement>('#qSec h2') : root?.parentElement?.querySelector<HTMLElement>('h2')
    if (target?.closest('section')) target.closest('section')!.hidden = false
    return target || null
  }
  function inlineTarget(block: HTMLElement | null): HTMLElement | null {
    if (!block) return null
    let target = block
    for (let parent: HTMLElement | null = block; parent && parent.id !== 'main'; parent = parent.parentElement) {
      if (parent.matches('table,ul,ol')) target = parent
    }
    return target
  }
  function selectionAnchor() { const s = getSelection(); return s?.rangeCount && !s.isCollapsed ? anchorFromRange(s.getRangeAt(0)) : null }
  function placeCard(card: HTMLElement, anchor: Anchor, width: number) {
    if (card === composer && innerWidth <= 600) { card.style.left = ''; card.style.top = ''; return }
    const found = rangeFromAnchor(anchor), rects = found?.range.getClientRects()
    const first = rects?.[0], last = rects?.[rects.length - 1]
    const fallback = rootFor(anchor)?.getBoundingClientRect()
    if (!first && !fallback) return
    const r = last || fallback!, left = first?.left ?? r.left
    card.style.left = `${Math.max(16, Math.min(innerWidth - Math.min(width, innerWidth - 32) - 16, left))}px`
    const h = card.getBoundingClientRect().height
    card.style.top = `${Math.max(60, r.bottom + h + 8 > innerHeight ? r.top - h - 8 : r.bottom + 8)}px`
  }
  function showPill(anchor: Anchor, rect: DOMRect, isTap = false) {
    const coarse = matchMedia('(pointer: coarse)').matches
    pending = anchor; pill.innerHTML = icon + `<span>${coarse || isTap ? 'Comment on this' : 'Comment'}</span>`; pill.hidden = false
    const main = document.querySelector('#main')!.getBoundingClientRect()
    const gutter = parseFloat(getComputedStyle(document.querySelector('#main')!).paddingRight)
    if (coarse || main.right - gutter + 20 + pill.offsetWidth > innerWidth - 8) {
      pill.style.top = `${innerHeight - dockHeight() - 44}px`
      pill.style.left = `${(innerWidth - pill.offsetWidth) / 2}px`
    } else {
      pill.style.top = `${Math.max(60, Math.min(innerHeight - dockHeight() - 40, rect.top))}px`
      pill.style.left = `${main.right - gutter + 20}px`
    }
  }
  function repositionPill() {
    if (composer) return
    if (tappedAnchor) {
      const found = rangeFromAnchor(tappedAnchor)
      if (!found) { clearTap(); hidePill(); return }
      const node = found.range.startContainer.parentElement?.closest<HTMLElement>(blocks)
      if (tapped !== node) { tapped?.classList.remove('cm-tapped'); tapped = node || null; tapped?.classList.add('cm-tapped') }
      showPill(tappedAnchor, found.range.getBoundingClientRect(), true)
    } else inspectSelection()
  }
  function inspectSelection() {
    if (composer || document.activeElement?.matches('textarea,input,[contenteditable]')) return
    const anchor = selectionAnchor(), selection = getSelection()
    if (!anchor || !selection?.rangeCount) { if (!tapped) hidePill(); return }
    clearTap()
    const rects = selection.getRangeAt(0).getClientRects(), rect = rects[rects.length - 1]
    if (rect) showPill(anchor, rect)
  }
  function closeComposer() { composer?.remove(); composer = null; draft = null; save(); document.body.classList.remove('cm-composing'); active([]) }
  function compose(anchor: Anchor, text = '') {
    composer?.remove(); clearTap(); hidePill(); getSelection()?.removeAllRanges(); draft = { anchor, text }; save()
    composer = ui('div', 'cm-card cm-composer'); composer.setAttribute('role', 'dialog'); composer.setAttribute('aria-label', 'Comment for the lane')
    const quote = ui('div', 'cm-quote'); quote.textContent = `“${anchor.quote}”`
    const ta = ui('textarea', '') as HTMLTextAreaElement; ta.rows = 2; ta.placeholder = 'Comment for the lane'; ta.value = text
    ta.addEventListener('input', () => { if (draft) draft.text = ta.value; save(); deps.autosize(ta); placeCard(composer!, anchor, 340) })
    const actions = ui('div', 'cm-actions'), cancel = ui('button', 'cm-cancel'), send = ui('button', 'btn primary')
    cancel.textContent = 'Cancel'; send.textContent = 'Send'
    cancel.onclick = closeComposer
    const go = async () => {
      const text = ta.value.trim(); if (!text) return
      closeComposer()
      try { await deps.postNote({ text, anchor }) } catch (error) {
        // Preserve any newer draft rather than overwriting words typed during the request.
        const newer = draft as { anchor: Anchor; text: string } | null
        compose(newer?.anchor || anchor, newer?.text ? `${text}\n\n${newer.text}` : text)
        deps.banner(`That note did not send (${error instanceof Error ? error.message : 'network error'}). It is back in the box.`)
      }
    }
    send.onclick = () => { void go() }
    ta.onkeydown = (e) => {
      if (e.key === 'Escape') closeComposer()
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.metaKey || e.ctrlKey || innerWidth > 600)) { e.preventDefault(); void go() }
    }
    actions.append(cancel, send); composer.append(quote, ta, actions); document.body.append(composer)
    document.body.classList.add('cm-composing'); deps.autosize(ta); placeCard(composer, anchor, 340); active([anchor]); ta.focus()
  }
  pill.onpointerdown = (e) => e.preventDefault()
  pill.onclick = () => { if (pending) compose(pending) }
  function groups() {
    const notes = deps.notes(), grouped = new Map<string, { anchor: Anchor; notes: any[]; unseen: boolean }>()
    for (const n of notes.filter((n) => n.from === 'alex' && n.anchor)) {
      const key = keyOf(n.anchor), group = grouped.get(key) || { anchor: n.anchor, notes: [] as any[], unseen: false }
      group.notes.push(n, ...notes.filter((r) => r.from === 'agent' && String(r.reply_to) === String(n.id)))
      grouped.set(key, group)
    }
    for (const group of grouped.values()) {
      group.notes.sort((a, b) => String(a.at).localeCompare(String(b.at)))
      group.unseen = group.notes.some((n) => n.from === 'agent' && Number(n.id) > Number(storage(seenKey) || 0))
    }
    return grouped
  }
  function markSeen(notes: any[]) {
    storage(seenKey, String(Math.max(Number(storage(seenKey) || 0), ...notes.map((n) => Number(n.id) || 0))))
  }
  function threadCard(group: ReturnType<typeof groups> extends Map<string, infer G> ? G : never, inline: boolean) {
    const card = ui('div', `cm-card cm-thread${inline ? ' cm-inline' : ''}`)
    if (!rangeFromAnchor(group.anchor)) { const detached = ui('div', 'cm-detached-label'); detached.textContent = 'The text this was on has changed'; card.append(detached) }
    const quote = ui('div', 'cm-quote'); quote.textContent = `“${group.anchor.quote}”`; card.append(quote)
    const list = ui('ul', 'notes'); list.append(...group.notes.map((n) => deps.noteNode({ ...n, inCommentCard: true }))); card.append(list)
    const ta = ui('textarea', '') as HTMLTextAreaElement, key = keyOf(group.anchor)
    ta.dataset.cmReply = key; ta.rows = 1; ta.placeholder = 'Add to this'; ta.value = replyDrafts.get(key) || ''
    ta.oninput = () => { replyDrafts.set(key, ta.value); deps.autosize(ta) }
    const send = ui('button', 'btn primary'); send.textContent = 'Send'
    const go = async () => {
      const text = ta.value.trim(); if (!text) return
      replyDrafts.delete(key); ta.value = ''; send.setAttribute('disabled', '')
      try { await deps.postNote({ text, anchor: group.anchor }) } catch (error) {
        replyDrafts.set(key, text); refresh(); deps.banner(`That note did not send (${error instanceof Error ? error.message : 'network error'}). It is back in the box.`)
      } finally { send.removeAttribute('disabled') }
    }
    send.onclick = () => { void go() }
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (e.metaKey || e.ctrlKey || innerWidth > 600)) { e.preventDefault(); void go() } }
    const row = ui('div', 'reply'); row.append(ta, send); card.append(row); requestAnimationFrame(() => deps.autosize(ta))
    return card
  }
  function redraw() {
    frame = 0
    beforeRender()
    const focused = savedFocus || (document.activeElement instanceof HTMLTextAreaElement && document.activeElement.dataset.cmReply ? { key: document.activeElement.dataset.cmReply, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null)
    savedFocus = null
    layer.replaceChildren(); document.querySelectorAll('.cm-chip,.cm-inline').forEach((el) => el.remove())
    const all: Range[] = [], grouped = groups(); let lastTop = -Infinity
    const placements = [...grouped.entries()].map(([key, group]) => {
      const located = rangeFromAnchor(group.anchor), root = rootFor(group.anchor)
      const node = located?.range.startContainer
      const block = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(blocks)
      const target = located ? inlineTarget(block || root) : detachedTarget(group.anchor)
      const rect = located?.range.getClientRects()[0] || target?.getBoundingClientRect()
      return { key, group, located, target, rect }
    }).sort((a, b) => (a.rect?.top || 0) - (b.rect?.top || 0))
    for (const { key, group, located, target, rect } of placements) {
      if (located) all.push(located.range)
      if (!rect || !target) continue
      const wide = innerWidth >= 1024, marker = ui('button', `${wide ? 'cm-marker' : 'cm-chip'}${!located ? ' cm-detached' : ''}${group.unseen ? ' cm-unseen' : ''}`) as HTMLButtonElement
      marker.type = 'button'; marker.setAttribute('aria-label', `${group.notes.length} comments on ${sectionLabel(group.anchor.section)}`)
      const count = group.notes.filter((n) => n.from === 'alex').length, replied = group.notes.some((n) => n.from === 'agent')
      marker.innerHTML = icon
      const label = document.createElement('span'); label.textContent = wide ? count > 1 ? String(count) : '' : `${count} comment${count === 1 ? '' : 's'}${replied ? ' · Lane replied' : ''}`; marker.append(label)
      if (wide) {
        const main = document.querySelector('#main')!.getBoundingClientRect(), top = Math.max(rect.top + scrollY, lastTop + 34); lastTop = top
        marker.style.left = `${main.right - 24 + 20}px`; marker.style.top = `${top}px`; layer.append(marker)
        marker.onmouseenter = marker.onfocus = () => active([group.anchor])
        marker.onmouseleave = marker.onblur = () => active(draft ? [draft.anchor] : [])
      } else target.after(marker)
      marker.onclick = () => {
        if (wide) openKey = openKey === key ? null : key
        else if (expanded.has(key)) expanded.delete(key); else expanded.add(key)
        markSeen(group.notes); refresh()
      }
      if (wide && openKey === key) {
        const card = threadCard(group, false); layer.append(card); card.style.position = 'absolute'
        card.style.left = `${Math.max(16, Math.min(innerWidth - 316, parseFloat(marker.style.left) - 8))}px`
        const ceiling = 60, floor = innerHeight - dockHeight() - 12
        card.style.maxHeight = `${Math.max(0, floor - ceiling)}px`
        const height = card.getBoundingClientRect().height, markerTop = parseFloat(marker.style.top) - scrollY
        const below = markerTop + 34
        const top = below + height <= floor ? below : markerTop - height - 8
        card.style.top = `${scrollY + Math.max(ceiling, Math.min(floor - height, top))}px`
      } else if (!wide && expanded.has(key)) marker.after(threadCard(group, true))
    }
    highlight('cm-anchor', all)
    active(draft ? [draft.anchor] : openKey && grouped.has(openKey) ? [grouped.get(openKey)!.anchor] : [])
    if (composer && draft) placeCard(composer, draft.anchor, 340)
    repositionPill()
    if (focused) {
      const ta = [...document.querySelectorAll<HTMLTextAreaElement>('[data-cm-reply]')].find((el) => el.dataset.cmReply === focused.key)
      ta?.focus({ preventScroll: true }); ta?.setSelectionRange(focused.start, focused.end)
    }
  }
  function refresh() { if (!frame) frame = requestAnimationFrame(redraw) }
  function open(anchor: Anchor, scroll = false) {
    const key = keyOf(anchor)
    if (innerWidth >= 1024) openKey = key; else expanded.add(key)
    const group = groups().get(key); if (group) markSeen(group.notes)
    if (scroll) {
      const range = rangeFromAnchor(anchor)?.range, root = rootFor(anchor)
      const el = range?.startContainer.parentElement || root
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    refresh()
  }
  document.addEventListener('selectionchange', () => { clearTimeout(selectionTimer); selectionTimer = window.setTimeout(inspectSelection, 150) })
  document.addEventListener('pointerup', (e) => {
    if ((e.target as Element)?.closest('[data-cm-skip]')) return
    if (selectionAnchor()) { inspectSelection(); return }
    if (!matchMedia('(pointer: coarse)').matches || composer) { hidePill(); return }
    const target = e.target as Element
    if (target.closest('a,button,input,textarea,[contenteditable]')) { clearTap(); hidePill(); return }
    const block = target.closest<HTMLElement>(blocks)
    const same = block === tapped; clearTap(); hidePill()
    if (!same && block && sectionOf(block)) {
      try { const anchor = blockAnchor(block); tapped = block; tappedAnchor = anchor; tapped.classList.add('cm-tapped'); showPill(anchor, block.getBoundingClientRect(), true) } catch {}
    }
  })
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as Element).closest('.cm-card,.cm-marker,.cm-chip,.cm-pill')) { if (openKey) { openKey = null; refresh() } }
    if (tapped && !(e.target as Element).closest('.cm-pill') && !tapped.contains(e.target as Node)) { clearTap(); hidePill() }
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeComposer(); openKey = null; expanded.clear(); clearTap(); hidePill(); refresh() } })
  window.addEventListener('resize', refresh); window.addEventListener('scroll', () => { repositionPill(); refresh() }, { passive: true })
  void document.fonts.ready.then(refresh)
  try { const saved = JSON.parse(storage(draftKey) || 'null'); if (saved?.anchor) compose(saved.anchor, saved.text || '') } catch {}
  return { refresh, open, beforeRender, context: () => draft?.anchor || tappedAnchor || selectionAnchor() }
}
