const rules = [
  ['ai-word', /\b(?:additionally|crucial|delve|enduring|enhance[sd]?|fostering|garner|interplay|intricate|pivotal|showcase[sd]?|tapestry|testament|underscore[sd]?|vibrant)\b/gi, 'a plain word, or cut it'],
  ['is', /\b(?:serves as|stands as|boasts)\b/gi, 'say "is" or "has"'],
  ['not-just', /\bnot (?:just|only)\b[^.!?]*?\bbut\b/gi, 'state the point directly'],
  ['em-dash', /[—–]/g, 'use a period or comma'],
  ['curly-quote', /[“”‘’]/g, 'use straight quotes'],
  ['chatbot', /\b(?:I hope this helps|let me know if|certainly!|of course!|great question\b)/gi, 'cut it'],
  ['filler', /\b(?:in order to|due to the fact that|it is important to note)\b/gi, '"to", "because", cut it'],
  ['plain-word', /\b(?:utilize|leverage[sd]?|facilitate[sd]?|numerous)\b/gi, (match) => `say "${/^numerous$/i.test(match) ? 'many' : /^facilitate/i.test(match) ? 'help' : 'use'}"`],
  ['jargon', /\b(?:substrate|wedge|vector|locus|nexus|paradigm|flywheel|north star|bedrock|modality)\b/gi, 'the concrete word'],
  ['pr-number', /\bPR\s+#?\d{3,}\b|#\d{3,}\b/gi, 'say what changed'],
  ['path', /~\/[^\s<>]+|\/(?:Users|Volumes|private)\/[^\s<>]+|\b[\w.-]+(?:\/[\w.-]+)+\.(?:py|js|mjs|ts|tsx|json|md|sh|css|html)\b/gi, "name the thing he'd see"],
  ['pane', /\bw5H:p[A-Za-z0-9]+\b|\bp[A-Z][A-Za-z0-9]{1,2}\b/g, 'name the lane or person'],
  ['seat', /\b(?:gpt-implementer|codex-verifier|opus-seat|sol-consult|gpt-explorer|sonnet-implementer|cursor-seat|devin-seat)\b/gi, 'say what does the work'],
  ['unsettled', /\b(?:open question|TBD|Q\d+|we could either)\b/gi, 'state the plan; ask in the margin'],
]

const blank = (text) => text.replace(/[^\n]/g, ' ')

function prose(text) {
  let fence = null
  const lines = text.split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null
      return blank(line)
    }
    if (marker) { fence = marker[1]; return blank(line) }
    if (/^\s*!\[.*\]\(.*\)\s*$/.test(line)) return blank(line)
    return line.replace(/\s*\{#[^}]+\}\s*$/, blank)
  })
  return lines.join('\n')
    .replace(/(`+)([\s\S]*?)\1/g, blank)
    .replace(/(!?\[[^\]\n]*\])\((?:[^()\n]|\([^()\n]*\))*\)/g, (all, label) => label + blank(all.slice(label.length)))
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, blank)
}

export function lintText(text, { keep = [] } = {}) {
  const source = String(text)
  let checked = prose(source)
  // Mask only complete kept terms, preserving offsets into the original text.
  for (const term of keep) {
    if (!term) continue
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    checked = checked.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'gi'), blank)
  }
  const findings = []
  for (const [rule, pattern, hint] of rules) {
    for (const match of checked.matchAll(pattern)) {
      const exact = source.slice(match.index, match.index + match[0].length)
      findings.push({ rule, match: exact, hint: typeof hint === 'function' ? hint(exact) : hint })
    }
  }
  return findings
}

export function lintDoc(sections, { keep = [] } = {}) {
  const findings = [], warnings = []
  for (const section of sections) {
    for (const field of ['heading', 'body_md']) {
      findings.push(...lintText(section[field], { keep }).map((finding) => ({ section: section.id, field, ...finding })))
    }
    const body = prose(section.body_md).split('\n').filter((line) => !/^\s*(?:#{1,6}\s|Figure:|\||>\s*\[!)/i.test(line)).join('\n')
    const count = body.trim() ? body.trim().split(/\s+/).length : 0
    if (count > 120) warnings.push({ section: section.id, rule: 'words', count, limit: 120 })
  }
  return { findings, warnings }
}
