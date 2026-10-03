import { markdown } from './markdown.ts'

// Wrap file:line cites and bare URLs outside code; inert markdown owns media safety.
const CITE_OR_URL = /(\[[^\]\n]*\]\([^)\s]*\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|((?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z]\w*:\d+(?:[-–]\d+)?)(?![\w/])/g
function answerSource(text: string): string {
  let fenced = false
  return String(text ?? '').replace(/[\r\u0000]/g, '').split('\n').map(line => {
    const content = line.replace(/^[>\s]*/, '').replace(/^\[!(NOTE|TIP|WARNING)\]\s*/, '')
    if (/^```/.test(content)) { fenced = !fenced; return line }
    if (fenced) return line
    return line.split(/(`[^`\n]*`)/).map((part, i) => i % 2 ? part : part.replace(CITE_OR_URL, (all, link: string, url: string, cite: string) => link ? all : url ? `[${url}](${url})` : `\`${cite}\``)).join('')
  }).join('\n')
}

export function answerHtml(text: string): string {
  return markdown(answerSource(text), {}, '', { inert: true })
}
