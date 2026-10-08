import { cleanRegion, type Anchor } from '../../../src/scope-anchor.js'
import type { DocSection, Slide, Thread } from '../../../src/scope-doc.js'
import { esc } from './markdown'
type Rect = NonNullable<Anchor['rect']>
export function slideSectionHtml(section: DocSection, slide: Slide & { width?: number | null; height?: number | null }, n: number, assetUrl: (id: string) => string): string {
  return `<section id="${esc(section.id)}" data-section class="slide"><h2><span class="slide-n">${n}</span> ${esc(section.heading)}</h2><div class="slide-stage" data-slide="${esc(section.id)}"><img src="${assetUrl(slide.image)}"${slide.width && slide.height ? ` width="${slide.width}" height="${slide.height}"` : ''} alt="${esc(section.heading)}" draggable="false"></div><button class="btn small slide-draw" hidden>Mark an area</button></section>`
}
export function regionMark(t: Thread, focused: string | null): HTMLElement {
  const mark = document.createElement('mark'), r = t.anchor.rect!
  mark.className = `hl region ${t.kind} ${t.status}${t.status === 'parked' ? ' resolved' : ''}${t.id === focused ? ' on' : ''}`
  mark.dataset.t = t.id
  Object.assign(mark.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` })
  return mark
}
export function attachDrawing(stage: HTMLElement, onDraw: (rect: Rect, top: number) => void, suppressClick: () => void = () => {}) {
  const coarse = matchMedia('(pointer: coarse)'), button = stage.parentElement!.querySelector<HTMLButtonElement>('.slide-draw')!
  let enabled = false, start: { x: number; y: number; id: number } | null = null, draft: HTMLElement | null = null
  const mode = (on: boolean) => { enabled = on; stage.style.touchAction = on ? 'none' : ''; button.textContent = on ? 'Cancel marking' : 'Mark an area'; button.setAttribute('aria-pressed', String(on)) }
  button.hidden = !coarse.matches
  button.onclick = () => mode(!enabled)
  const point = (e: PointerEvent) => { const b = stage.querySelector('img')!.getBoundingClientRect(); return { x: Math.max(0, Math.min(b.width, e.clientX - b.left)), y: Math.max(0, Math.min(b.height, e.clientY - b.top)), b } }
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || (coarse.matches && !enabled) || (e.target as Element).closest('mark')) return
    const p = point(e); if (!p.b.width || !p.b.height) return
    start = { x: p.x, y: p.y, id: e.pointerId }; stage.setPointerCapture(e.pointerId); e.preventDefault()
  })
  stage.addEventListener('pointermove', e => {
    if (!start || start.id !== e.pointerId) return
    const p = point(e)
    if (Math.hypot(p.x - start.x, p.y - start.y) < 8 && !draft) return
    if (!draft) { stage.querySelector('.region-draft')?.remove(); draft = document.createElement('div'); draft.className = 'region-draft'; stage.append(draft) }
    Object.assign(draft.style, { left: `${Math.min(start.x, p.x) / p.b.width * 100}%`, top: `${Math.min(start.y, p.y) / p.b.height * 100}%`, width: `${Math.abs(p.x - start.x) / p.b.width * 100}%`, height: `${Math.abs(p.y - start.y) / p.b.height * 100}%` })
  })
  stage.addEventListener('pointerup', e => {
    if (!start || start.id !== e.pointerId) return
    const p = point(e), origin = start; start = null
    stage.releasePointerCapture(e.pointerId)
    const rect = Math.hypot(p.x - origin.x, p.y - origin.y) >= 8 ? cleanRegion({ x: Math.min(origin.x, p.x) / p.b.width, y: Math.min(origin.y, p.y) / p.b.height, w: Math.abs(p.x - origin.x) / p.b.width, h: Math.abs(p.y - origin.y) / p.b.height }) : null
    if (rect && rect.w > 0 && rect.h > 0) { suppressClick(); mode(false); onDraw(rect, p.b.top + rect.y * p.b.height + scrollY); draft = null }
    else { draft?.remove(); draft = null }
  })
  stage.addEventListener('pointercancel', () => { start = null; draft?.remove(); draft = null; mode(false) })
}
export async function cropRegion(img: HTMLImageElement, rect: Rect): Promise<Blob | null> {
  try {
    const sw = img.naturalWidth * rect.w, sh = img.naturalHeight * rect.h
    if (!sw || !sh) return null
    const scale = Math.min(1, 1600 / Math.max(sw, sh)), canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale))
    const ctx = canvas.getContext('2d'); if (!ctx) return null
    ctx.drawImage(img, img.naturalWidth * rect.x, img.naturalHeight * rect.y, sw, sh, 0, 0, canvas.width, canvas.height)
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
  } catch { return null }
}
