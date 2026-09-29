import { makeAnchor, locateAnchor, type Anchor, type AnchorSection } from '../../../src/scope-anchor.js'

export const blocks = 'p,li,h3,h4,pre,tr,td,th,div.quote,.q-text,.rec,.why,.settled,.decision,.note'
const skip = 'button,textarea,[data-cm-skip]'
export function sectionOf(node: Node | null): { section: AnchorSection; root: HTMLElement } | null {
  const el = node instanceof Element ? node : node?.parentElement
  if (!el || el.closest(skip)) return null
  const root = el.closest<HTMLElement>('.q-body,#ask,#plan,#decisions,#thread')
  if (!root) return null
  const section = root.classList.contains('q-body') ? `q:${root.closest('.q')?.id.slice(2)}` : root.id
  return { section: section as AnchorSection, root }
}
export function sectionText(root: HTMLElement): { text: string; map: ({ node: Text; offset: number } | null)[] } {
  let text = ''
  const map: ({ node: Text; offset: number } | null)[] = []
  const boundary = () => { if (text && !/\s$/.test(text)) { text += '\n'; map.push(null) } }
  const walk = (node: Node) => {
    if (node instanceof Element) {
      if (node.matches(skip)) return
      if (node.matches(blocks)) boundary()
      node.childNodes.forEach(walk)
      if (node.matches(blocks)) boundary()
    } else if (node instanceof Text) {
      for (let i = 0; i < node.length; i++) { text += node.data[i]; map.push({ node, offset: i }) }
    }
  }
  walk(root)
  return { text, map }
}
function offsets(range: Range, map: ReturnType<typeof sectionText>['map']) {
  const inside = map.map((pos, i) => {
    if (!pos) return -1
    return range.comparePoint(pos.node, pos.offset) === 0 ? i : -1
  }).filter((i) => i >= 0)
  if (!inside.length) return null
  // comparePoint includes the end boundary; a selected character must begin before it.
  let end = inside.at(-1)! + 1
  const last = map[end - 1]
  if (last && last.node === range.endContainer && last.offset === range.endOffset) end--
  return end > inside[0] ? { start: inside[0], end } : null
}
export function anchorFromRange(range: Range): Anchor | null {
  if (range.collapsed) return null
  const a = sectionOf(range.startContainer), b = sectionOf(range.endContainer)
  if (!a || !b || a.root !== b.root) return null
  const { text, map } = sectionText(a.root)
  const found = offsets(range, map)
  return found ? makeAnchor(a.section, text, found.start, found.end) : null
}
export function rootFor(anchor: Anchor): HTMLElement | null {
  return anchor.section.startsWith('q:') ? document.querySelector(`#q-${CSS.escape(anchor.section.slice(2))} .q-body`) : document.getElementById(anchor.section)
}
export function rangeFromAnchor(anchor: Anchor): { range: Range; exact: boolean } | null {
  const root = rootFor(anchor)
  if (!root) return null
  const { text, map } = sectionText(root), found = locateAnchor(text, anchor)
  if (!found) return null
  const start = map.slice(found.start, found.end).find((p) => p), end = map.slice(found.start, found.end).reverse().find((p) => p)
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset + 1)
  if (start.node.parentElement?.closest('[hidden]') || end.node.parentElement?.closest('[hidden]') || !range.getClientRects().length) return null
  return { range, exact: found.exact }
}
export function blockAnchor(el: Element): Anchor {
  const range = document.createRange(); range.selectNodeContents(el)
  const anchor = anchorFromRange(range)
  if (!anchor) throw new Error('This block has no anchorable text.')
  if (anchor.quote.length >= 300) anchor.quote = anchor.quote.slice(0, 300).replace(/\s+\S*$/, '').trim() || anchor.quote.slice(0, 300)
  return anchor
}
export function inViewAnchor(): Anchor | null {
  const candidates = [...document.querySelectorAll<HTMLElement>(blocks)].filter((el) => sectionOf(el) && el.getClientRects().length)
  const line = 52 + (innerHeight - 52) * .35
  const el = candidates.find((el) => { const r = el.getBoundingClientRect(); return r.top <= line && r.bottom >= line })
    || candidates.find((el) => el.getBoundingClientRect().top >= 52)
  if (!el) return null
  try { return blockAnchor(el) } catch { return null }
}
