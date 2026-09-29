export const ANCHOR_SECTION = /^([a-z][a-z0-9-]{0,39}|q:Q\d{1,3})$/

const collapse = (text) => String(text).replace(/\s+/g, ' ').trim()
const anchorText = (text) => collapse(typeof text === 'string' ? text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '') : '')
const fold = (text) => text.split('').map((ch) => ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch).join('')

export function normalizeAnchor(input) {
  if (!input || typeof input !== 'object' || typeof input.section !== 'string' || !ANCHOR_SECTION.test(input.section) || typeof input.quote !== 'string') return null
  const quote = anchorText(input.quote).slice(0, 300).trim()
  if (!quote) return null
  const anchor = { section: input.section, quote, prefix: anchorText(input.prefix).slice(-40).trim(), suffix: anchorText(input.suffix).slice(0, 40).trim() }
  if (Number.isFinite(input.t) && input.t >= 0 && input.t <= 86400) {
    anchor.t = Math.round(input.t * 10) / 10
    if (Number.isFinite(input.t_end) && input.t_end > input.t && input.t_end <= 86400) anchor.t_end = Math.round(input.t_end * 10) / 10
  }
  return anchor
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

export function sectionLabel(section) {
  return { plan: 'the plan', ask: 'your ask', decisions: 'the decisions', thread: 'the thread' }[section] ?? (/^q:Q\d{1,3}$/.test(section) ? section.slice(2) : section)
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
