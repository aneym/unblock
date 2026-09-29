import DOMPurify from 'dompurify'

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
  return expand(links.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>'))
}
export function markdown(source: string): string {
  const lines = source.replace(/[\r\u0000]/g, '').split('\n'), out: string[] = []
  let i = 0
  const fence = () => { const lang = lines[i++].slice(3).trim(); const body: string[] = []; while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]); i++; return { lang, source: body.join('\n') } }
  const caption = () => /^Figure:\s*/.test(lines[i] || '') ? `<figcaption>${inline(lines[i++].replace(/^Figure:\s*/, ''))}</figcaption>` : ''
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (/^```/.test(line)) {
      const f = fence()
      if (f.lang === 'svg') {
        let phone = ''; if (/^```svg phone\s*$/.test(lines[i] || '')) phone = `<div class="fig-phone" data-cm-skip>${sanitizeSvg(fence().source)}</div>`
        out.push(`<figure class="fig"><div class="fig-wide" data-cm-skip>${sanitizeSvg(f.source)}</div>${phone}${caption()}</figure>`)
      } else if (f.lang === 'mermaid') out.push(`<figure class="fig mermaid"><div data-mermaid="${esc(f.source)}" data-cm-skip><pre>${esc(f.source)}</pre></div>${caption()}</figure>`)
      else out.push(`<pre><code>${esc(f.source)}</code></pre>`)
      continue
    }
    const callout = line.match(/^>\s*\[!(NOTE|TIP|WARNING)\]\s*(.*)/)
    if (callout) { const body = [callout[2]]; i++; while (/^>/.test(lines[i] || '')) body.push(lines[i++].replace(/^>\s?/, '')); out.push(`<div class="callout ${callout[1].toLowerCase()}">${markdown(body.join('\n'))}</div>`); continue }
    if (/^>/.test(line)) {
      const quotes: string[] = []
      while (/^>/.test(lines[i] || '')) { const text = lines[i++].replace(/^>\s?/, ''); const src = /^>\s*—/.test(lines[i] || '') ? lines[i++].replace(/^>\s*/, '') : ''; quotes.push(`<li><q>${inline(text.replace(/^["“]|["”]$/g, ''))}</q>${src ? `<span class="src">${inline(src)}</span>` : ''}</li>`) }
      out.push(`<ul class="quotes">${quotes.join('')}</ul>`); continue
    }
    const heading = line.match(/^(#{1,4})\s+(.*)/)
    if (heading) { const h = Math.max(3, heading[1].length); out.push(`<h${h}>${inline(heading[2])}</h${h}>`); i++; continue }
    if (line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = cells(line); i += 2; const rows: string[][] = []; while ((lines[i] || '').includes('|')) rows.push(cells(lines[i++])); out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue
    }
    if (/^\s*([-*]|\d+[.)])\s/.test(line)) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul', items: string[] = []
      while (/^\s*([-*]|\d+[.)])\s/.test(lines[i] || '')) items.push(`<li>${inline(lines[i++].replace(/^\s*([-*]|\d+[.)])\s+/, ''))}</li>`)
      out.push(`<${tag}>${items.join('')}</${tag}>`); continue
    }
    const para = [lines[i++]]
    while (i < lines.length && lines[i].trim() && !/^(?:```|>|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return out.join('')
}
export async function renderMermaid(root: HTMLElement, onLoad: () => void) {
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-mermaid]')]
  if (!nodes.length) return
  try {
    const { default: mermaid } = await import('mermaid')
    const style = getComputedStyle(document.documentElement)
    mermaid.initialize({ htmlLabels: false, flowchart: { htmlLabels: false }, startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base', themeVariables: { primaryTextColor: style.getPropertyValue('--ink').trim(), primaryColor: style.getPropertyValue('--surface').trim(), primaryBorderColor: style.getPropertyValue('--hairline').trim(), lineColor: style.getPropertyValue('--accent').trim() } })
    for (const [i, node] of nodes.entries()) {
      try { const { svg } = await mermaid.render(`scope-diagram-${Date.now()}-${i}`, node.dataset.mermaid!); if (node.isConnected) node.innerHTML = sanitizeSvg(svg) } catch { /* The source remains readable when a diagram is invalid. */ }
    }
  } catch { /* Offline diagrams retain their source. */ }
  onLoad()
}
