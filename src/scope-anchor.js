export const ANCHOR_SECTION = /^([a-z][a-z0-9-]{0,39}|q:Q\d{1,3})$/

const collapse = (text) => String(text).replace(/\s+/g, ' ').trim()
const anchorText = (text) => collapse(typeof text === 'string' ? text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '') : '')
const fold = (text) => text.split('').map((ch) => ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch).join('')

const round3 = (n) => Math.round(n * 1000) / 1000

/** A demo highlight, fractions of the stage. Null when it is not four finite numbers or the box is empty. */
export function cleanRegion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) return null
  const { x, y, w, h } = input
  if (![x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const cx = Math.min(1, Math.max(0, x))
  const cy = Math.min(1, Math.max(0, y))
  const cw = Math.min(Math.max(0, 1 - cx), Math.max(0, w))
  const ch = Math.min(Math.max(0, 1 - cy), Math.max(0, h))
  if (cw <= 0 || ch <= 0) return null
  return { x: round3(cx), y: round3(cy), w: round3(cw), h: round3(ch) }
}

export function normalizeAnchor(input) {
  if (!input || typeof input !== 'object' || typeof input.section !== 'string' || !ANCHOR_SECTION.test(input.section) || typeof input.quote !== 'string') return null
  const quote = anchorText(input.quote).slice(0, 300).trim()
  if (!quote) return null
  const anchor = { section: input.section, quote, prefix: anchorText(input.prefix).slice(-40).trim(), suffix: anchorText(input.suffix).slice(0, 40).trim() }
  if (input.embed !== undefined) {
    const embed = input.embed
    if (!embed || typeof embed !== 'object' || Array.isArray(embed) || typeof embed.src !== 'string' || !embed.src.trim() || embed.src.length > 2048 || typeof embed.quote !== 'string') return null
    const quote = anchorText(embed.quote).slice(0, 300).trim()
    if (!quote) return null
    anchor.embed = { src: embed.src.trim(), quote, prefix: anchorText(embed.prefix).slice(-40).trim(), suffix: anchorText(embed.suffix).slice(0, 40).trim() }
  }
  if (input.general === true && input.section === 'title') anchor.general = true
  if (Number.isFinite(input.t) && input.t >= 0 && input.t <= 86400) {
    anchor.t = Math.round(input.t * 10) / 10
    if (Number.isFinite(input.t_end) && input.t_end > input.t && input.t_end <= 86400) anchor.t_end = Math.round(input.t_end * 10) / 10
    if (Number.isInteger(input.step) && input.step >= 0 && input.step <= 999) anchor.step = input.step
    const region = cleanRegion(input.region)
    if (region) anchor.region = region
  }
  if (input.rect !== undefined) {
    const rect = cleanRegion(input.rect)
    if (!rect) return null
    anchor.rect = rect
  }
  if (input.crop !== undefined) {
    if (!anchor.rect || typeof input.crop !== 'string' || !/^[0-9a-f]{16}\.png$/.test(input.crop)) return null
    anchor.crop = input.crop
  }
  if (anchor.rect && anchor.embed) return null
  return anchor
}

export function rectLabel(rect) {
  return ['x', 'y', 'w', 'h'].map(key => `${key}=${Math.round(rect[key] * 100)}%`).join(' ')
}

export function makeAnchor(section, text, start, end) {
  return normalizeAnchor({ section, quote: text.slice(start, end), prefix: collapse(text.slice(0, start)), suffix: collapse(text.slice(end)) })
}

export function locateAnchor(text, anchor) {
  const map = []
  let stripped = ''
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    stripped += text[i]
    map.push(i)
  }
  const quote = String(anchor.quote ?? '').replace(/\s/g, '')
  if (!quote) return null
  let exact = true
  let source = stripped
  let sought = quote
  if (!source.includes(sought)) {
    exact = false
    source = fold(source)
    sought = fold(sought)
  }
  const prefix = String(anchor.prefix ?? '').replace(/\s/g, '')
  const suffix = String(anchor.suffix ?? '').replace(/\s/g, '')
  const before = exact ? prefix : fold(prefix)
  const after = exact ? suffix : fold(suffix)
  let best = null
  let score = -1
  for (let i = source.indexOf(sought); i >= 0; i = source.indexOf(sought, i + 1)) {
    let matched = 0
    for (let j = 1; j <= before.length && i - j >= 0 && source[i - j] === before[before.length - j]; j++) matched++
    for (let j = 0; j < after.length && source[i + sought.length + j] === after[j]; j++) matched++
    if (matched > score) { best = i; score = matched }
  }
  return best === null ? null : { start: map[best], end: map[best + quote.length - 1] + 1, exact }
}

/** Embed text must retain exact case and nearby context, never a loose fallback. */
export function locateEmbed(text, anchor) {
  const found = locateAnchor(text, anchor)
  if (!found?.exact) return null
  const prefix = String(anchor.prefix ?? '').replace(/\s/g, '').slice(-12)
  const suffix = String(anchor.suffix ?? '').replace(/\s/g, '').slice(0, 12)
  if (prefix || suffix) {
    const before = text.slice(0, found.start).replace(/\s/g, '')
    const after = text.slice(found.end).replace(/\s/g, '')
    if (!(prefix && before.endsWith(prefix)) && !(suffix && after.startsWith(suffix))) return null
  }
  return found
}

export function sectionLabel(section) {
  return { plan: 'the plan', ask: 'your ask', decisions: 'the decisions', thread: 'the comment' }[section] ?? (/^q:Q\d{1,3}$/.test(section) ? section.slice(2) : section)
}

export function quoteSnippet(quote, max = 80) {
  const text = collapse(quote).replace(/"/g, "'")
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max - 1)
  return `${text.slice(0, cut > 0 ? cut : Math.max(0, max - 1)).trim()}…`
}

export function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S*/gi, 'a link')
    .replace(/^\s*(?:[-*_]\s*){3,}$|^\s*\|?[\s:|-]+\|\s*$/gm, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\|/g, ' ')
    .split(/\n\s*\n/).map(collapse).filter(Boolean).join('\n')
}

/** Only a demo fence in the containing section may own an embed anchor. */
export function hasEmbedFence(section, src) {
  return [...String(section?.body_md ?? '').matchAll(/^\s*```demo[^\n]*\n([\s\S]*?)^\s*```\s*$/gm)]
    .some(match => match[1].split('\n').some(line => line.match(/^\s*src:\s*(.*?)\s*$/)?.[1] === src))
}
