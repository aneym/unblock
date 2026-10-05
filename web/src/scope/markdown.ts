import DOMPurify from 'dompurify'
import { parseMediaFence } from '../../../src/scope-media.js'
import './tabs.ts'
import { buildBlock } from './build.ts'
import type { DocAsset } from '../../../src/scope-doc.js'

export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
export function sanitizeSvg(source: string): string {
  const clean = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_ATTR: ['style'], FORBID_TAGS: ['style', 'script', 'foreignObject', 'image', 'use', 'animate', 'set'] })
  const root = document.createElement('div'); root.innerHTML = clean
  root.querySelectorAll('*').forEach(node => {
    for (const attr of [...node.attributes]) {
      const value = attr.value.replace(/\\(?:([0-9a-f]{1,6})\s?|(.))/gi, (_, hex: string, char: string) => hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : char).replace(/\s/g, '').toLowerCase()
      const transform = /^(?:transform|gradienttransform)$/i.test(attr.name)
      const calls = [...value.matchAll(/([\w-]+)\(/g)].map(match => match[1])
      const unsafeCall = calls.some(name => name === 'url' ? !/^url\(#[\w-]+\)$/.test(value) : !/^(?:rgb|rgba|hsl|hsla)$/.test(name) && !(transform && /^(?:translate|rotate|scale|matrix|skewx|skewy)$/.test(name)))
      if (attr.value.includes('\\') || /^on/i.test(attr.name) || /^(?:href|xlink:href)$/i.test(attr.name) && !attr.value.startsWith('#') || unsafeCall) node.removeAttribute(attr.name)
    }
  })
  return root.innerHTML
}
function inline(text: string): string {
  const tokens: string[] = []
  const hold = (html: string) => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000` }
  const code = esc(text).replace(/`([^`]+)`/g, (_, value: string) => hold(`<code>${value}</code>`))
  const links = code.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => hold(`<a href="${url}" target="_blank" rel="noopener">${label.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')}</a>`))
  const expand = (html: string): string => html.replace(/\u0000(\d+)\u0000/g, (_, index: string) => expand(tokens[Number(index)]))
  return expand(links.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w\u0000])_(?=\S)([^_\n]*?\S)_(?![\w])/g, '$1<em>$2</em>'))
}
// Semantic blocks (```terms, ```example, ```do, ```compare, ```steps, ```stat): lanes write words, the page owns the
// look. Separators and labels stay in the DOM as hidden text, so a comment's quote still matches the doc's plain text.
const hiddenText = (text: string) => `<span class="sr-sep">${esc(text)}</span>`
const label = (name: string, cls = '') => `<span class="lbl${cls ? ` ${cls}` : ''}">${esc(name)}</span>${hiddenText(':')} `
const LABEL_LINE = /^([A-Z][A-Za-z']{0,14}(?: [a-z][A-Za-z']{0,10})?):\s+(.*)$/
const splitPair = (line: string) => { const at = line.indexOf(' :: '); return at < 0 ? null : [line.slice(0, at).trim(), line.slice(at + 4).trim()] as const }
const example = (text: string) => `<p class="eg">${inline(text)}</p>`
function termsBlock(source: string): string {
  const items: { term: string; def: string; tags: string; lines: string[] }[] = []
  for (const raw of source.split('\n')) {
    const line = raw.trim(); if (!line) continue
    const pair = splitPair(line)
    if (pair) { items.push({ term: pair[0], def: pair[1], tags: '', lines: [] }); continue }
    const item = items.at(-1); if (!item) continue
    const tags = line.match(/^Tags:\s+(.*)$/)
    if (tags) item.tags = tags[1]; else item.lines.push(line)
  }
  return `<dl class="terms">${items.map(item => {
    const labelled: string[] = [], rest: string[] = []
    for (const line of item.lines) {
      const eg = line.match(/^e\.g\.\s+(.*)$/i), named = line.match(LABEL_LINE)
      if (eg) rest.push(example(eg[1]))
      else if (named) labelled.push(`<span class="pair">${label(named[1])}${inline(named[2])}</span>`)
      else rest.push(`<p class="detail">${inline(line)}</p>`)
    }
    return `<div class="term-row"><dt><span class="term">${inline(item.term)}</span>${item.tags ? `<span class="tags">${hiddenText(' Tags: ')}${inline(item.tags)}</span>` : ''}</dt><dd>${hiddenText(' :: ')}<p class="def">${inline(item.def)}</p>${rest.join('')}${labelled.length ? `<p class="detail labelled">${labelled.join(' ')}</p>` : ''}</dd></div>`
  }).join('')}</dl>`
}
function doBlock(source: string): string {
  const rows = source.split('\n').map(line => line.trim().match(/^(Do|Don't|Say|Avoid):\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[]
  return `<div class="dodont">${rows.map(([, name, text]) => `<p class="${/^(Do|Say)$/.test(name) ? 'say' : 'avoid'}">${label(name)}${inline(text)}</p>`).join('')}</div>`
}
function compareBlock(source: string): string {
  const rows: [string, string][] = []
  for (const raw of source.split('\n')) {
    const match = raw.trim().match(/^(Before|After):\s+(.*)$/); if (!match) continue
    if (match[1] === 'Before' || !rows.length || rows.at(-1)![1]) rows.push(['', ''])
    rows.at(-1)![match[1] === 'Before' ? 0 : 1] = match[2]
  }
  return `<div class="compare">${rows.map(([before, after]) => `<div class="compare-row"><p class="before">${label('Before')}${inline(before)}</p><p class="after">${label('After')}${inline(after)}</p></div>`).join('')}</div>`
}
function stepsBlock(source: string): string {
  const steps = source.split('\n').map(line => line.trim().replace(/^\d+[.)]\s+/, '')).filter(Boolean)
  return `<ol class="steps">${steps.map(step => `<li>${inline(step)}</li>`).join('')}</ol>`
}
function statBlock(source: string): string {
  const stats = source.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [head, meaning] = splitPair(line) ?? [line, '']
    const [, value = head, unit = ''] = head.match(/^([~≈<>+\-−]?[$€£]?[\d][\d.,:]*[%kKmMbB×x]?)\s*(.*)$/) || []
    return `<div class="stat"><p class="stat-figure"><span class="stat-value">${inline(value)}</span>${unit ? ` <span class="stat-unit">${inline(unit)}</span>` : ''}</p>${meaning ? `${hiddenText(' :: ')}<p class="stat-meaning">${inline(meaning)}</p>` : ''}</div>`
  })
  return `<div class="stats">${stats.join('')}</div>`
}
const BLOCKS: Record<string, (source: string) => string> = {
  terms: termsBlock, do: doBlock, compare: compareBlock, steps: stepsBlock, stat: statBlock,
  example: (source) => source.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean).map(text => example(text.replace(/\s*\n\s*/g, ' '))).join(''),
}
export function markdown(source: string, assets: Record<string, DocAsset> = {}, assetBase = '', options: { inert?: boolean } = {}): string {
  const lines = source.replace(/[\r\u0000]/g, '').split('\n'), out: string[] = []
  let i = 0
  const fence = () => { const lang = lines[i++].slice(3).trim(); const body: string[] = []; while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]); i++; return { lang, source: body.join('\n') } }
  const caption = () => /^Figure:\s*/.test(lines[i] || '') ? `<figcaption>${inline(lines[i++].replace(/^Figure:\s*/, ''))}</figcaption>` : ''
  const imageLine = (line: string) => line?.match(/^\s*!\[[^\]\n]*\]\([^\n]*\)\s*$/)
  const assetUrl = (id: string) => esc(`${assetBase}/${encodeURIComponent(id)}`)
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (imageLine(line)) {
      if (options.inert) { out.push(`<p>${esc(line)}</p>`); i++; continue }
      const shots: string[] = []
      let count = 0
      while (imageLine(lines[i])) {
        const match = lines[i++].match(/^\s*!\[([^\]\n]*)\]\(asset:(\S+?)(?: "([^"\n]*)")?\)\s*$/)
        const [, alt, id, title] = match || []
        const asset = id && Object.hasOwn(assets, id) ? assets[id] : undefined
        if (!asset) { shots.push('<div class="shot-missing" data-cm-skip>Image unavailable</div>'); continue }
        const frame = asset.type === 'mock' ? asset.frame === 'phone' ? 'phone' : 'desktop' : title === 'phone' ? 'phone' : 'image'
        const src = asset.type === 'mock' ? asset.light : id
        count++
        shots.push(`<button type="button" class="shot" data-asset="${esc(id)}" data-frame="${frame}" aria-label="Zoom: ${esc(alt)}"><picture>${asset.type === 'mock' && asset.dark ? `<source media="(prefers-color-scheme: dark)" srcset="${assetUrl(asset.dark)}">` : ''}<img src="${assetUrl(src)}"${asset.width && asset.height ? ` width="${asset.width}" height="${asset.height}"` : ''} alt="${esc(alt)}" loading="lazy" decoding="async"></picture><span class="shot-n">${count}</span></button>`)
      }
      const cap = caption()
      const row = shots.map(shot => count > 1 ? shot : shot.replace(/<span class="shot-n">\d+<\/span>/, '')).join('')
      if (count) out.push(`<figure class="fig shots${count >= 4 ? ' storyboard' : ''}"><div class="shots-row" data-cm-skip>${row}</div>${cap}</figure>`)
      else out.push(row + cap)
      continue
    }
    if (/^```/.test(line)) {
      const f = fence()
      if (options.inert) out.push(`<pre><code>${esc(f.source)}</code></pre>`)
      else if (f.lang === 'svg') {
        let phone = ''; if (/^```svg phone\s*$/.test(lines[i] || '')) phone = `<div class="fig-phone" data-cm-skip>${sanitizeSvg(fence().source)}</div>`
        out.push(`<figure class="fig"><div class="fig-wide" data-cm-skip>${sanitizeSvg(f.source)}</div>${phone}${caption()}</figure>`)
      } else if (f.lang === 'mermaid') out.push(`<figure class="fig mermaid"><div data-mermaid="${esc(f.source)}" data-cm-skip><pre>${esc(f.source)}</pre></div>${caption()}</figure>`)
      else if (f.lang === 'build') out.push(buildBlock(f.source))
      else if (f.lang === 'tabs') {
        // Flat demo entries avoid nesting triple-backtick fences in this line-based parser.
        const entries = f.source.split(/^\s*---\s*$/m).filter(entry => entry.trim()).map(entry => parseMediaFence(entry, assets, assetBase))
        const group = `scope-tabs-${out.length}`
        const labels = entries.map((entry, index) => entry.values.caption?.split(/:|—/)[0].trim() || `Tab ${index + 1}`)
        out.push(`<div class="scope-tabs"><div role="tablist" aria-label="Demos" data-cm-skip>${entries.map((entry, index) => `<button type="button" role="tab" id="${group}-tab-${index}" aria-controls="${group}-panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${esc(labels[index])}</button>`).join('')}</div>${entries.map((entry, index) => `<div role="tabpanel" id="${group}-panel-${index}" aria-labelledby="${group}-tab-${index}" data-tab-label="${esc(labels[index])}"${index ? ' hidden' : ''}><figure class="fig demo" data-frame="${entry.values.frame === 'phone' ? 'phone' : 'desktop'}">${entry.src ? `<div class="demo-stage" data-cm-skip data-tab-src="${entry.src}" data-sandbox="${esc(entry.sandbox)}" data-allow="${esc(entry.allow)}" data-height="${entry.height}" data-title="${esc(entry.values.caption || 'Demo')}" style="height:${entry.height}px"></div>` : '<div class="shot-missing" data-cm-skip>Demo unavailable</div>'}<figcaption>${inline(entry.values.caption || labels[index])}</figcaption>${entry.src ? `<div class="fig-actions" data-cm-skip><button type="button" class="btn fig-comment">Comment on this demo</button><a class="demo-open" href="${entry.src}" target="_blank" rel="noopener">Open in a new tab</a></div>` : ''}</figure></div>`).join('')}</div>`)
      }
      else if (f.lang === 'demo' || f.lang === 'video') {
        const { values, src, height, allow, sandbox, mediaUrl } = parseMediaFence(f.source, assets, assetBase, f.lang === 'demo' ? 'html' : 'video')
        const demo = f.lang === 'demo', cap = caption()
        if (!src) { out.push(`<figure class="fig ${f.lang}"><div class="shot-missing" data-cm-skip>${demo ? 'Demo' : 'Recording'} unavailable</div>${cap}</figure>`); continue }
        if (demo) {
          // Every demo mounts inline as it nears the viewport; `autoplay: true` is still accepted and changes nothing.
          const title = document.createElement('div'); title.innerHTML = cap
          out.push(`<figure class="fig demo" data-frame="${values.frame === 'phone' ? 'phone' : 'desktop'}"><div class="demo-stage" data-cm-skip data-src="${src}" data-embed-src="${esc(values.src)}" data-sandbox="${esc(sandbox)}" data-allow="${esc(allow)}" data-height="${height}" data-title="${esc(title.textContent || 'Demo')}"><p class="type-hint">Loading demo…</p></div>${cap}<div class="fig-actions" data-cm-skip>${cap ? '<button type="button" class="btn fig-comment">Comment on this demo</button>' : ''}<a class="demo-open" href="${src}" target="_blank" rel="noopener">Open in a new tab</a></div></figure>`)
        } else {
          const poster = mediaUrl(values.poster, 'image')
          out.push(`<figure class="fig video"><div class="video-stage" data-cm-skip><video controls preload="metadata" playsinline src="${src}"${poster ? ` poster="${poster}"` : ''}></video></div>${cap}${cap ? '<div class="fig-actions" data-cm-skip><button type="button" class="btn fig-comment">Comment on this recording</button></div>' : ''}</figure>`)
        }
      } else if (Object.hasOwn(BLOCKS, f.lang)) out.push(BLOCKS[f.lang](f.source))
      else out.push(`<pre><code>${esc(f.source)}</code></pre>`)
      continue
    }
    const callout = line.match(/^>\s*\[!(NOTE|TIP|WARNING)\]\s*(.*)/)
    if (callout) { const body = [callout[2]]; i++; while (/^>/.test(lines[i] || '')) body.push(lines[i++].replace(/^>\s?/, '')); out.push(`<div class="callout ${callout[1].toLowerCase()}">${markdown(body.join('\n'), assets, assetBase, options)}</div>`); continue }
    if (/^>/.test(line)) {
      const quotes: string[] = []
      while (/^>/.test(lines[i] || '')) { const text = lines[i++].replace(/^>\s?/, ''); const src = /^>\s*—/.test(lines[i] || '') ? lines[i++].replace(/^>\s*/, '') : ''; quotes.push(`<li><q>${inline(text.replace(/^["“]|["”]$/g, ''))}</q>${src ? `<span class="src">${inline(src)}</span>` : ''}</li>`) }
      out.push(`<ul class="quotes">${quotes.join('')}</ul>`); continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/)
    if (heading) { const h = Math.max(3, heading[1].length); out.push(`<h${h}>${inline(heading[2])}</h${h}>`); i++; continue }
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = cells(line); i += 2; const rows: string[][] = []; while ((lines[i] || '').includes('|')) rows.push(cells(lines[i++])); out.push(`<div class="table-wrap"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue
    }
    if (/^\s*([-*]|\d+[.)])\s/.test(line)) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul', items: string[] = []
      while (/^\s*([-*]|\d+[.)])\s/.test(lines[i] || '')) items.push(`<li>${inline(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ''))}</li>`)
      out.push(`<${tag}>${items.join('')}</${tag}>`); continue
    }
    const para = [lines[i++]]
    while (i < lines.length && lines[i].trim() && !imageLine(lines[i]) && !/^(?:```|>|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('')
}
let diagramId = 0
const diagramSheets = new Map<HTMLElement, CSSStyleSheet[]>()
function mountDiagram(node: HTMLElement, svg: string) {
  for (const [owner, sheets] of diagramSheets) if (!owner.isConnected || owner === node) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => !sheets.includes(sheet)); diagramSheets.delete(owner)
  }
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const sheets: CSSStyleSheet[] = []
  parsed.querySelectorAll('style').forEach(style => { const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent || ''); sheets.push(sheet); style.remove() })
  const styles: string[] = []
  parsed.querySelectorAll('[style]').forEach(el => { el.setAttribute('data-scope-style', String(styles.length)); styles.push(el.getAttribute('style')!); el.removeAttribute('style') })
  node.innerHTML = sanitizeSvg(new XMLSerializer().serializeToString(parsed.documentElement))
  node.querySelectorAll<SVGElement>('[data-scope-style]').forEach(el => { el.style.cssText = styles[Number(el.getAttribute('data-scope-style'))]; el.removeAttribute('data-scope-style') })
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, ...sheets]; diagramSheets.set(node, sheets)
}
export async function renderMermaid(root: HTMLElement, onLoad: () => void) {
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-mermaid]')]
  if (!nodes.length) return
  try {
    const { default: mermaid } = await import('mermaid')
    const style = getComputedStyle(document.documentElement)
    mermaid.initialize({ layout: 'dagre', htmlLabels: false, flowchart: { htmlLabels: false }, startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base', themeVariables: { primaryTextColor: style.getPropertyValue('--ink').trim(), primaryColor: style.getPropertyValue('--surface').trim(), primaryBorderColor: style.getPropertyValue('--hairline').trim(), lineColor: style.getPropertyValue('--accent').trim() } })
    for (const node of nodes) {
      try { const { svg } = await mermaid.render(`scope-diagram-${diagramId++}`, node.dataset.mermaid!); if (node.isConnected) mountDiagram(node, svg) } catch { /* The source remains readable when a diagram is invalid. */ }
    }
  } catch { /* Offline diagrams retain their source. */ }
  onLoad()
}
