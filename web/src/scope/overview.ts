import type { ScopeV2 } from '../../../src/scope-doc.js'
import { buildStrip } from './build'
import { buildFences, parseBuild, formatRange } from '../../../src/scope-build.js'
import { esc } from './markdown'

const fixed = new Set(['title', 'one-screen', 'context', 'picture'])
let chapter = 'picture'
let current: ScopeV2 | null = null
let redraw = () => {}
const sizes = new WeakMap<Element, { width: number; height: number }>()
const observer = new ResizeObserver(() => fitPicture())

export function fitPicture() {
  if (!oneScreen(current)) return
  const centre = document.getElementById('picture')
  if (!centre || centre.hidden) return
  const figure = centre.querySelector<HTMLElement>('figure')
  const media = figure?.querySelector<SVGSVGElement | HTMLImageElement>('svg, img')
  if (!media) return
  let size = sizes.get(media)
  if (!size) {
    const rect = media.getBoundingClientRect()
    const svg = media instanceof SVGSVGElement
    size = { width: svg ? media.width.baseVal.value || media.viewBox.baseVal.width || rect.width : media.naturalWidth || rect.width, height: svg ? media.height.baseVal.value || media.viewBox.baseVal.height || rect.height : media.naturalHeight || rect.height }
    if (!size.width || !size.height) return
    sizes.set(media, size)
  }
  const caption = figure!.querySelector('figcaption')?.getBoundingClientRect().height || 0
  const heading = centre.querySelector('h2')?.getBoundingClientRect().height || 0
  const fonts = [...media.querySelectorAll('text')].map(text => parseFloat(getComputedStyle(text).fontSize)).filter(font => font > 0)
  const readable = fonts.length ? 11 / Math.min(...fonts) : 1 / 1.5
  const scale = innerWidth < 900 ? Math.max(readable, Math.min(1, centre.clientWidth / size.width)) : Math.max(1 / 1.5, Math.min(2, centre.clientWidth / size.width, (centre.clientHeight - caption - heading - 64) / size.height))
  media.style.width = `${size.width * scale}px`; media.style.height = `${size.height * scale}px`
}

// One-screen is opt-in only: a doc must name a section {#one-screen}. Scrollable with contents is the default (Alex, 2026-10-07).
export const oneScreen = (scope: ScopeV2 | null) => !!scope?.doc.sections.some(s => s.id === 'one-screen')

export function showChapter(id: string) {
  if (!oneScreen(current) || fixed.has(id) && id !== 'picture') return
  if (!current!.doc.sections.some(s => s.id === id)) return
  chapter = id
  document.querySelectorAll<HTMLElement>('#doc > section').forEach(node => {
    node.hidden = node.id !== 'context' && node.id !== chapter
    node.classList.toggle('overview-centre', node.id === chapter)
  })
  document.querySelectorAll<HTMLButtonElement>('.overview-chapters button').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.chapter === chapter)); if (button.dataset.chapter === 'picture') button.textContent = chapter === 'picture' ? 'Picture' : 'Back to the picture' })
  redraw()
}

export function renderOverview(scope: ScopeV2, onChange: () => void) {
  current = scope; redraw = onChange
  const enabled = oneScreen(scope)
  document.body.classList.toggle('one-screen', enabled)
  const layout = document.querySelector<HTMLElement>('.layout')!
  if (!enabled) {
    document.querySelectorAll('.overview-chapters,.overview-build').forEach(node => node.remove())
    document.querySelectorAll<HTMLElement>('#doc > section').forEach(node => { node.hidden = false; node.classList.remove('overview-centre') })
    observer.disconnect()
    return
  }
  let nav = layout.querySelector<HTMLElement>('.overview-chapters')
  if (!nav) {
    nav = document.createElement('nav'); nav.className = 'overview-chapters'; nav.setAttribute('aria-label', 'Scope chapters'); layout.prepend(nav)
    layout.addEventListener('scroll', () => redraw(), true)
    layout.addEventListener('click', event => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
      if (link) showChapter(decodeURIComponent(link.hash.slice(1)))
    })
    nav.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-chapter]')
      if (button) showChapter(button.dataset.chapter!)
    })
  }
  const ids = ['picture', ...scope.doc.sections.filter(s => !fixed.has(s.id)).map(s => s.id)]
  if (!ids.includes(chapter)) chapter = 'picture'
  nav.replaceChildren(...ids.map(id => {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.chapter = id
    button.textContent = id === 'picture' ? 'Back to the picture' : scope.doc.sections.find(s => s.id === id)!.heading
    return button
  }))
  let strip = layout.querySelector<HTMLElement>('.overview-build')
  if (!strip) { strip = document.createElement('footer'); strip.className = 'overview-build'; layout.append(strip) }
  strip.innerHTML = buildPieces(scope) + buildStrip(scope.doc.sections)
  const picture = document.getElementById('picture')
  if (picture) observer.observe(picture)
  showChapter(chapter)
  fitPicture()
}

function buildPieces(scope: ScopeV2) {
  const section = scope.doc.sections.find(s => s.id === 'build')
  const rows = section ? [...document.getElementById(section.id)!.querySelectorAll('tbody tr')].map(row => {
    const cells = [...row.querySelectorAll('td')]
    return { label: cells[0]?.textContent?.trim() || '', estimate: cells.slice(1).map(cell => cell.textContent?.trim()).find(text => /\d.*(?:min|hour|m\b|h\b)/i.test(text || '')) || '' }
  }).filter(piece => piece.label) : []
  if (!rows.length && section) {
    for (const match of section.body_md.matchAll(/\b[\w.-]+\[\s*["']?([^\]"']+)["']?\s*\]/g)) {
      if (!rows.some(row => row.label === match[1])) rows.push({ label: match[1], estimate: '' })
    }
  }
  for (const doc of scope.doc.sections) for (const source of buildFences(doc.body_md)) {
    const { pieces, errors } = parseBuild(source)
    if (errors.length) continue
    if (!rows.length) rows.push(...pieces.map(piece => ({ label: piece.label, estimate: formatRange(piece.p50_min, piece.p90_min) })))
    else for (const row of rows) {
      const piece = pieces.find(piece => row.label === piece.label || row.label === piece.id)
      if (piece && !row.estimate) row.estimate = formatRange(piece.p50_min, piece.p90_min)
    }
  }
  return `<div class="overview-pieces">${rows.map(piece => `<span class="overview-piece">${esc(piece.label)}${piece.estimate ? `<small>${esc(piece.estimate)}</small>` : ''}</span>`).join('')}</div>`
}
