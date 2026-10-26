import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PLAN_URL = /^(?:https:\/\/[a-z0-9.-]+:8950\/plans\/|https:\/\/app\.rails\.so\/d\/)plan-[A-Za-z0-9_-]+$/

const DIAGRAM_CSS = `.ad svg{width:100%;height:auto;font-family:inherit}
.ad .box{fill:transparent;stroke:var(--wf-line);stroke-width:1}
.ad .core{fill:var(--wf-line);fill-opacity:.25;stroke:var(--wf-ink);stroke-width:1.2}
.ad .hd{font-size:13px;font-weight:600;letter-spacing:.04em;fill:var(--wf-muted)}
.ad .t{font-size:14px;font-weight:600;fill:var(--wf-ink)}
.ad .sm{font-size:12px;fill:var(--wf-ink)}
.ad .muted{fill:var(--wf-muted)}
.ad .wire{stroke:var(--wf-muted);stroke-width:1.2;fill:none}
.ad .wire.ac{stroke:var(--wf-ink)}`

export function plansPath(env = process.env) {
  return join(env.UNBLOCK_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock'), 'scope-plans.json')
}

export function readPlans(path = plansPath()) {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function planFor(slug, path = plansPath()) {
  const record = readPlans(path)[slug]
  return record && PLAN_URL.test(record.url ?? '') ? record : null
}

export function recordPlan(slug, record, path = plansPath()) {
  const plans = readPlans(path)
  plans[slug] = record
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(plans, null, 2))
  renameSync(tmp, path)
}

async function feedKey(env) {
  if (env.RAILS_ADMIN_FEED_KEY) return env.RAILS_ADMIN_FEED_KEY
  const { stdout } = await promisify(execFile)(env.UNBLOCK_AGENT_SECRET_BIN || join(homedir(), '.local', 'bin', 'agent-secret'), ['get', 'rails-admin-feed-key'], { timeout: 10000 })
  return stdout.trim()
}

export async function linkPlan(slug, url, env = process.env) {
  if (env.UNBLOCK_PLAN_LINK === 'off') return null
  const base = `${(env.UNBLOCK_RAILS_ADMIN_ORIGIN || 'https://rails.so').replace(/\/$/, '')}/api/rails-admin/v1/plan/scopes/${encodeURIComponent(slug)}`
  const headers = { authorization: `Bearer ${await feedKey(env)}`, 'content-type': 'application/json' }
  const read = await fetch(base, { headers, signal: AbortSignal.timeout(20000) })
  if (!read.ok && read.status !== 404) throw new Error(`Rails read HTTP ${read.status}`)
  const view = read.ok ? await read.json() : {}
  const lane = !view.mirror && typeof view.lane === 'string' ? view.lane : null
  const client_id = 'unblock-plan-' + createHash('sha256').update(url).digest('hex').slice(0, 32)
  const [path, body] = lane ? ['set-plan-url', { client_id, lane, plan_url: url }] : ['plan-link', { plan_url: url, ...(view.owner ? { owner: view.owner } : {}) }]
  const sent = await fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  if (!sent.ok) throw new Error(`Rails ${path} HTTP ${sent.status}`)
  return { via: path, ...(lane ? { lane } : {}) }
}

const attr = (value) => String(value).replace(/"/g, "'").replace(/[{}<>]/g, ' ').trim()
const short = (value) => attr(value).slice(0, 400).trim()
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
const prose = (line) => line.replace(/\s*\{#[\w-]+\}\s*$/, '').split(/(`+[^`]*?`+)/).map((part, n) => (n % 2 ? part : part.replace(/[<{}]/g, '\\$&'))).join('')
const MEDIA_ASSET = /^asset:([0-9a-f]{16}\.[a-z0-9]+)$/

function mediaValues(source, assets) {
  const values = {}
  for (const line of String(source).split('\n')) {
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/)
    if (!match) continue
    values[match[1].trim()] = match[2]
    const id = match[2].match(MEDIA_ASSET)?.[1]
    if (id) assets.add(id)
  }
  return values
}

function mediaSrc(value, assets) {
  const text = String(value ?? '').trim()
  const id = text.match(MEDIA_ASSET)?.[1]
  if (id) {
    assets.add(id)
    return `asset:${id}`
  }
  return /^https:\/\/\S+$/.test(text) ? attr(text) : ''
}

function mediaBlock(lang, values, caption, counter, assets) {
  const src = mediaSrc(values.src, assets)
  if (!src) return caption
  const label = caption ? ` caption="${short(caption)}"` : ''
  if (lang === 'video' || /\.(mp4|webm)$/.test(src)) {
    const poster = mediaSrc(values.poster, assets)
    return `<Film id="f${++counter.n}" src="${src}"${poster ? ` poster="${poster}"` : ''}${label} />`
  }
  return `<PrototypeEmbed id="p${++counter.n}" src="${src}"${label} />`
}

function convertBody(body, counter, assets) {
  const lines = String(body).split('\n'), out = []
  let code = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (code) {
      if (/^\s*```\s*$/.test(line)) code = false
      out.push(line)
      continue
    }
    const image = line.match(/^!\[([^\]]*)\]\(asset:([0-9a-f]{16}\.(?:png|jpg|webp|gif|svg|mock))(?:\s+"[^"]*")?\)\s*$/)
    if (image) {
      assets.add(image[2])
      out.push(`<MockStill id="m${++counter.n}" src="asset:${image[2]}" alt="${short(image[1]) || 'Figure'}" caption="${short(image[1])}" />`)
      continue
    }
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test((lines[i + 1] ?? '').trim())) {
      const columns = cells(line).map((cell, index) => cell || (index === 0 ? 'Item' : '\u200b'))
      const rows = []
      i += 2
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]))
      i--
      out.push(`<Table id="t${++counter.n}" columns={${JSON.stringify(columns)}} rows={${JSON.stringify(rows)}} />`)
      continue
    }
    const fence = line.trim().match(/^```(video|demo|tabs|html)$/)
    if (fence) {
      const end = lines.indexOf('```', i + 1)
      if (end > i) {
        const source = lines.slice(i + 1, end).join('\n')
        let caption = ''
        if (/^Figure:\s*/.test(lines[end + 1] ?? '')) caption = lines[end + 1].replace(/^Figure:\s*/, '').trim()
        const entries = fence[1] === 'tabs'
          ? source.split(/^\s*---\s*$/m).filter((entry) => entry.trim()).map((entry) => { const values = mediaValues(entry, assets); return mediaBlock('demo', values, values.caption || '', counter, assets) })
          : [mediaBlock(fence[1] === 'html' ? 'demo' : fence[1], mediaValues(source, assets), caption, counter, assets)]
        if (fence[1] === 'tabs' && caption) entries.push(caption)
        out.push(entries.filter(Boolean).join('\n\n'))
        i = caption ? end + 1 : end
        continue
      }
    }
    if (line.trim() === '```svg') {
      const end = lines.indexOf('```', i + 1)
      if (end > i) {
        const svg = lines.slice(i + 1, end).join('\n')
        const label = svg.match(/aria-label="([^"]*)"/)?.[1] ?? ''
        out.push(`<Diagram id="d${++counter.n}" caption="${attr(label)}" frame="hide" renderMode="design">\n\n\`\`\`html\n<div class="ad">\n${svg}\n</div>\n\`\`\`\n\n\`\`\`css\n${DIAGRAM_CSS}\n\`\`\`\n\n</Diagram>`)
        i = end
        continue
      }
    }
    if (/^\s*```/.test(line)) {
      code = true
      out.push(line)
      continue
    }
    out.push(prose(line))
  }
  return out.join('\n')
}

export function scopeToPlanMdx(scope) {
  const [title, ...sections] = scope.doc.sections
  const counter = { n: 0 }, assets = new Set()
  const lead = String(title?.body_md ?? '').split('\n\n').map((p) => p.trim()).find((p) => p && !/^[!|`<]/.test(p)) ?? ''
  const parts = [convertBody(title?.body_md ?? '', counter, assets)]
  for (const section of sections) parts.push(`## ${prose(section.heading)}\n\n${convertBody(section.body_md, counter, assets)}`)
  const mdx = `---\ntitle: ${JSON.stringify(scope.title || title?.heading || scope.slug)}\nbrief: ${JSON.stringify(lead.slice(0, 300))}\n---\n\n${parts.join('\n\n').trim()}\n`
    .replace(/asset:(?=([^\s"')\\]*))/g, (match, ref) => ([...assets].some((id) => ref.startsWith(id)) ? match : 'asset\u200b:'))
  return { mdx, assets: [...assets] }
}

export function planQuestions(scope) {
  return (scope.threads ?? [])
    .filter((thread) => thread.kind === 'question' && thread.status === 'open' && thread.anchor?.quote && thread.recommendation)
    .map((thread) => ({
      quote: thread.anchor.quote,
      question: thread.messages?.[0]?.text ?? '',
      rec: thread.recommendation,
      ...(thread.why ? { context: thread.why } : {}),
      ...(Array.isArray(thread.options) && thread.options.length ? { options: thread.options.map((o) => (typeof o === 'string' ? o : o.text)).filter(Boolean) } : {}),
    }))
}
