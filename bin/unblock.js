#!/usr/bin/env node
/** The CLI is a local client. Only reveal resolves a secret, and only here. */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, extname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { IMAGE_LINE } from '../src/scope-assets.js'
import { lintDoc } from '../src/scope-lint.js'

import { daemon, authToken, stateDir } from '../plugin/paths.js'
import { SecretStore } from '../src/secrets.js'
import { quoteSnippet } from '../src/scope-anchor.js'
import { docFromMarkdown, docToMarkdown, orderThreads, headingOf, THREAD_ID } from '../src/scope-doc.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const [command = 'list', ...input] = process.argv.slice(2)
let json = false

function fail(message, code = 2) {
  const text = String(message)
  console.error(json ? JSON.stringify({ error: text, code }) : text)
  process.exit(code)
}
function output(value, text) {
  console.log(json ? JSON.stringify(value) : text)
}
function age(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
function project(ask) {
  return ask.project ?? ask.origin?.workspace_name ?? ask.origin?.repo ?? 'other'
}
function stable(health, ticket) {
  return health.public_origin ? `${health.public_origin.replace(/\/$/, '')}/#ask=${ticket}` : null
}
function kindWord(ask) { return ask.purpose === 'blocker' ? (ask.fields?.some((field) => field.type === 'secret') ? 'key' : 'click') : ask.purpose }
function required(ask) {
  return (ask.fields ?? []).filter((field) => field.required && ask.missing?.includes(field.name))
}
function safe(ask) {
  const copy = structuredClone(ask)
  for (const field of copy.fields ?? []) {
    if (field.type !== 'secret') continue
    if (Object.hasOwn(copy.answers ?? {}, field.name)) copy.answers[field.name] = { stored: true }
    if (Object.hasOwn(copy.draft ?? {}, field.name)) copy.draft[field.name] = { stored: true }
  }
  return copy
}
function title(text, width) {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
}
function wrap(text, width = 80, prefix = '') {
  const words = String(text).split(/\s+/)
  const lines = []
  let line = prefix
  for (const word of words) {
    if (line.trim() && line.length + word.length + 1 > width) {
      lines.push(line)
      line = prefix + word
    } else line += (line === prefix ? '' : ' ') + word
  }
  lines.push(line)
  return lines.join('\n')
}

function lintOutput({ findings = [], warnings = [] }) {
  for (const finding of findings) console.error(`${finding.section ? `§${finding.section}` : finding.field} ${finding.rule}: "${finding.match}" -> ${finding.hint}`)
  for (const warning of warnings) console.error(`§${warning.section}: ${warning.count} words (limit 120). Say it with a picture or cut it.`)
  if (findings.length) {
    console.error('Run /unslop over the doc (or fix these) and publish again. Keep a real name with --keep "<term>".')
    process.exit(2)
  }
}

async function request(path, body, { start = true, method } = {}) {
  let base
  try { base = await daemon({ start }) } catch (error) { fail(error.message, 1) }
  let response
  try {
    response = await fetch(base + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authToken() ? { authorization: `Bearer ${authToken()}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
  } catch (error) { fail(error.message, 1) }
  let data
  try { data = await response.json() } catch { fail(`invalid response from queue`, 1) }
  if (!response.ok) {
    if (response.status === 422 && data.error === 'unslop') lintOutput(data)
    const message = data.error || `HTTP ${response.status}`
    if (['ASK_NOT_OPEN', 'PAY_NOT_ALLOWED', 'RECEIPT_NOT_ALLOWED'].includes(data.code)) fail(message, 5)
    if (response.status === 404) fail(message, 3)
    if (response.status === 400 || response.status === 409 || response.status === 422) {
      if (data.code === 'ALREADY_OPEN' && data.ticket) {
        const health = await request('/api/health')
        fail(`already open as ${data.ticket}${stable(health, data.ticket) ? `\n${stable(health, data.ticket)}` : ''}`, 4)
      }
      fail(`${message}${data.path && !message.includes(data.path) ? ` (${data.path})` : ''}`, 4)
    }
    fail(message, 1)
  }
  return data
}

function flags(args, allowed) {
  const rest = []
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') { json = true; continue }
    if (arg in allowed) {
      const value = allowed[arg] ? args[++i] : true
      if (value === undefined) fail(`${arg} needs a value`)
      if (arg === '--keep') (opts[arg] ??= []).push(value)
      else opts[arg] = value
    } else if (arg.startsWith('--')) fail(`unknown option: ${arg}`)
    else rest.push(arg)
  }
  return { rest, opts }
}
function count(n) { return `${n} ${n === 1 ? 'question' : 'questions'}` }

async function list(args) {
  const { rest, opts } = flags(args, { '--all': false, '--project': true })
  if (rest.length) fail('usage: unblock list [--all] [--project P] [--json]')
  const { asks } = await request(`/api/asks?profile=*&includeClosed=${opts['--all'] ? 'true' : 'false'}`)
  const cutoff = Date.now() - 7 * 86400000
  const shown = asks.filter((ask) =>
    (ask.status === 'open' || (opts['--all'] && ['answered', 'cancelled'].includes(ask.status) &&
      (ask.closed_at ?? ask.answered_at ?? 0) >= cutoff)) &&
    (!opts['--project'] || project(ask) === opts['--project']))
    // Open asks lead; closed ones under --all are context, not work.
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1))
  const health = await request('/api/health')
  if (json) return output({ asks: shown.map((ask) => ({ ...safe(ask), link: stable(health, ask.ticket) })) })
  const open = shown.filter((ask) => ask.status === 'open').length
  console.log(open ? `${open} waiting on you` : 'Nothing is waiting on you.')
  const groups = new Map()
  for (const ask of shown) {
    const name = project(ask)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(ask)
  }
  for (const [name, group] of groups) {
    console.log(`\n${name}`)
    for (const ask of group) {
      const prefix = `  ${ask.ticket}  `
      console.log(prefix + title(ask.title, Math.max(1, (process.stdout.columns || 100) - prefix.length)))
      console.log(`             ${[ask.status === 'open' ? null : ask.status, kindWord(ask),
        ask.kind === 'park' && ask.status === 'open' ? 'agent stopped' : null,
        ask.status === 'open' ? count(required(ask).length) : null, age(ask.created_at), ask.origin?.agent].filter(Boolean).join(' · ')}`)
      if (ask.minutes) console.log(`             ~${ask.minutes} min`)
      if (ask.blocks) console.log(`             unblocks: ${ask.blocks}`)
      const link = stable(health, ask.ticket)
      if (link) console.log(`             ${link}`)
    }
  }
}
const reasons = {
  credential: 'needs your sign-in or key',
  their_account: 'a click in your own account',
  spend: 'spends money or opens an account',
  message: 'a message to a real person',
  judgment: 'a product or taste call',
}
const types = { text: 'text', paste: 'paste output', choice: 'choose one', confirm: 'confirm', secret: 'secret' }
async function show(args) {
  const { rest } = flags(args, {})
  if (rest.length !== 1) fail('usage: unblock show <ticket> [--json]')
  const ask = await request(`/api/asks/${encodeURIComponent(rest[0])}`)
  if (json) return output(safe(ask))
  const health = await request('/api/health')
  console.log(ask.title)
  console.log([ask.status, kindWord(ask), project(ask), age(ask.created_at), ask.origin?.agent,
    ask.origin?.pane_id && `pane ${ask.origin.pane_id}`].filter(Boolean).join(' · '))
  const link = stable(health, ask.ticket)
  if (link) console.log(link)
  console.log(`\nWhy\n${wrap(ask.why)}`)
  if (ask.summary) console.log(`\nSummary: ${ask.summary}`)
  if (ask.minutes) console.log(`Time: ~${ask.minutes} min`)
  if (ask.after) console.log(`Then: ${ask.after}`)
  if (ask.blocks) console.log(`Unblocks: ${ask.blocks}`)
  if (ask.only_you) console.log(`\nOnly you: ${reasons[ask.only_you] ?? ask.only_you}`)
  if (ask.tried?.length) console.log(`\nTried:\n${ask.tried.map((s) => `  - ${s}`).join('\n')}`)
  if (ask.steps?.length) console.log(`\nSteps:\n${ask.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`)
  if (ask.links?.length) console.log(`\nLinks:\n${ask.links.map((l) => `  ${l.label} — ${l.url}`).join('\n')}`)
  for (const [i, field] of ask.fields.entries()) {
    console.log(`\n${i + 1}. ${field.label} · ${types[field.type] ?? field.type}`)
    if (field.help) console.log(wrap(field.help, 80, '   '))
    for (const choice of field.choices ?? []) {
      const recommend = !field.must_decide && field.recommend?.value === choice.value
      console.log(`   - ${choice.label}${recommend ? ` (recommended: ${field.recommend.why})` : ''}`)
    }
    if (Object.hasOwn(ask.answers ?? {}, field.name))
      console.log(`   Answer: ${field.type === 'secret' ? 'stored secret' : JSON.stringify(ask.answers[field.name])}`)
    else if (Object.hasOwn(ask.draft ?? {}, field.name))
      console.log(`   Draft: ${field.type === 'secret' ? 'stored secret' : JSON.stringify(ask.draft[field.name])}`)
  }
}
function parseValue(field, raw) {
  if (field.type === 'secret') fail('type secrets in the queue page, not the shell history')
  if (field.type === 'choice') {
    const choice = field.choices.find((c) =>
      c.value.toLowerCase() === raw.toLowerCase() || c.label.toLowerCase() === raw.toLowerCase())
    if (!choice) fail(`valid choices for ${field.label}: ${field.choices.map((c) => c.label).join(', ')}`)
    return field.multi ? [choice.value] : choice.value
  }
  if (field.type === 'confirm') {
    if (['yes', 'y', 'true', 'done', '1'].includes(raw.toLowerCase())) return true
    if (['no', 'false', '0'].includes(raw.toLowerCase())) return false
    fail(`${field.label}: use yes or no`)
  }
  return raw
}
async function answer(args) {
  const { rest } = flags(args, {})
  const [ticket, ...pairs] = rest
  if (!ticket || !pairs.length) fail('usage: unblock answer <ticket> <value|name=value ...>')
  const ask = await request(`/api/asks/${encodeURIComponent(ticket)}`)
  if (['consent', 'spend', 'message'].includes(ask.purpose)) fail('answer this on the page', 4)
  if (ask.status !== 'open') fail(`ask ${ticket} is ${ask.status}, not open`, 5)
  const values = {}
  if (pairs.length === 1 && !pairs[0].includes('=')) {
    const missing = required(ask)
    if (missing.length !== 1) fail(`answer by name: ${missing.map((f) => `${f.name} (${f.label})`).join(', ')}`)
    values[missing[0].name] = parseValue(missing[0], pairs[0])
  } else {
    for (const pair of pairs) {
      const i = pair.indexOf('=')
      if (i < 1) fail(`expected name=value for every answer after the first; use ${ask.fields.map((f) => f.name).join(', ')}`)
      const name = pair.slice(0, i)
      const field = ask.fields.find((f) => f.name === name)
      if (!field) fail(`unknown question: ${name}; use ${ask.fields.map((f) => f.name).join(', ')}`)
      values[name] = parseValue(field, pair.slice(i + 1))
    }
  }
  const result = await request(`/api/asks/${encodeURIComponent(ticket)}/answer`, { values })
  const text = result.complete
    ? (ask.kind === 'park' ? `answered · waking ${ask.origin?.agent ?? 'agent'}` : 'answered')
    : `saved · still needs: ${required(result.ask).map((f) => f.label).join(', ')}`
  output({ ...result, ask: safe(result.ask) }, text)
}
async function receipt(args) {
  const { rest, opts } = flags(args, { '--before': true, '--after': true, '--url': true })
  if (rest.length !== 1) fail('usage: unblock receipt <ticket> [--before a.png] [--after b.png] [--url U] [--json]')
  const ticket = rest[0]
  const ask = await request(`/api/asks/${encodeURIComponent(ticket)}`)
  if (ask.purpose !== 'consent' || !['answered', 'collected', 'orphaned'].includes(ask.status) || ask.answers.verdict !== 'approve') fail('receipt not allowed', 5)
  const result = await request(`/api/asks/${encodeURIComponent(ticket)}/receipt`, {
    ...(opts['--before'] ? { before: resolve(opts['--before']) } : {}),
    ...(opts['--after'] ? { after: resolve(opts['--after']) } : {}),
    ...(opts['--url'] ? { final_url: opts['--url'] } : {}),
  })
  output(result, `receipt saved for ${ticket}`)
}

async function pay(args) {
  const { rest, opts } = flags(args, { '--payment-method': true })
  if (rest.length !== 1) fail('usage: unblock pay <ticket> [--payment-method <id>] [--json]')
  const ticket = rest[0]
  const ask = await request(`/api/asks/${encodeURIComponent(ticket)}`)
  if (ask.purpose !== 'spend' || !['answered', 'collected', 'orphaned'].includes(ask.status) || ask.answers.verdict !== 'approve' || ask.receipt?.spend_request_id) fail('payment not allowed', 5)
  if (ask.spend.amount_cents > ask.spend.cap_cents || ask.spend.amount_cents > 50000) fail('amount exceeds cap or Link limit', 4)
  if (opts['--payment-method'] && !/^[A-Za-z0-9_]+$/.test(opts['--payment-method'])) fail('invalid payment method', 4)
  const { pay_key } = await request(`/api/asks/${encodeURIComponent(ticket)}/pay-claim`, {})
  const details = ask.spend
  const context = `Payment for ${details.item} at ${details.vendor}: ${details.why}. Requested through Unblock ticket ${ticket}. Human approval is required in the Link app before the payment can proceed.`
  const parameters = ['spend-request', 'create', `--merchant-name=${details.vendor}`, `--merchant-url=${details.vendor_url}`,
    `--amount=${details.amount_cents}`, `--currency=${details.currency}`, `--context=${context}`,
    `--line-item=name:${details.item},unit_amount:${details.amount_cents},quantity:1`, '--request-approval',
    `--idempotency-key=${pay_key}`, '--format=json']
  if (opts['--payment-method']) parameters.push(`--payment-method-id=${opts['--payment-method']}`)
  let data
  try {
    const result = await promisify(execFile)(process.env.UNBLOCK_LINK_CLI || 'link-cli', parameters, { maxBuffer: 256 * 1024 })
    data = JSON.parse(result.stdout)
    if (typeof data.id !== 'string' || !/^[-a-zA-Z0-9_]{1,120}$/.test(data.id) || typeof data.status !== 'string' || !/^[-a-zA-Z0-9_]{1,80}$/.test(data.status)) throw new Error('invalid response')
  } catch (error) {
    if (typeof error.code === 'number') fail(`link-cli failed (exit ${error.code}). Run \`link-cli spend-request create --help\` yourself to see why.`, 1)
    fail('link-cli failed. Run `link-cli spend-request create --help` yourself to see why.', 1)
  }
  let recorded = false
  const base = await daemon()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}/api/asks/${encodeURIComponent(ticket)}/receipt`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken()}` },
        body: JSON.stringify({ spend_request_id: data.id, spend_status: data.status }),
        signal: AbortSignal.timeout(5000),
      })
      if (response.ok) { recorded = true; break }
      if (response.status >= 400 && response.status < 500) break
    } catch { /* retry recording, never rerun link-cli */ }
  }
  if (!recorded) fail('payment request created but receipt could not be recorded; retry pay with the same key', 1)
  output({ id: data.id, status: data.status }, `${data.id} · ${data.status}\nApprove the push in your Link app; then get the card with: link-cli spend-request retrieve ${data.id} --include card --output-file <path>`)
}

async function close(args) {
  const { rest } = flags(args, {})
  const [ticket, ...reason] = rest
  if (!ticket || !reason.join(' ').trim()) fail('usage: unblock close <ticket> <reason...>')
  const result = await request(`/api/asks/${encodeURIComponent(ticket)}/cancel`, { note: reason.join(' ') })
  output({ ask: safe(result.ask) }, `closed ${ticket}`)
}
async function readBody(path) {
  let text
  try { text = path && path !== '-' ? readFileSync(path, 'utf8') : await new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  }) } catch (error) { fail(error.message) }
  try { return JSON.parse(text) } catch { fail('expected JSON input') }
}
async function file(args) {
  const { rest } = flags(args, {})
  if (rest.length > 1) fail('usage: unblock file [path|-]')
  // Same JSON the MCP tool takes. A body already shaped {ask, origin} passes through.
  const body = await readBody(rest[0])
  const ask = await request('/api/asks', body && typeof body === 'object' && 'ask' in body ? body : {
    ask: body,
    origin: {
      agent: process.env.UNBLOCK_AGENT || 'cli',
      pane_id: process.env.HERDR_PANE_ID,
      tab_id: process.env.HERDR_TAB_ID,
      workspace_id: process.env.HERDR_WORKSPACE_ID,
      cwd: process.cwd(),
      kind: process.env.UNBLOCK_ORIGIN_KIND,
    },
  })
  const link = stable(await request('/api/health'), ask.ticket)
  output({ ...safe(ask), link }, [ask.ticket, link].filter(Boolean).join('\n'))
}
async function update(args) {
  const { rest } = flags(args, {})
  if (!rest[0] || rest.length > 2) fail('usage: unblock update <ticket> [path|-]')
  const { ask } = await request(`/api/asks/${encodeURIComponent(rest[0])}/update`, await readBody(rest[1]))
  output({ ask: safe(ask) }, `updated ${rest[0]}`)
}
async function link(args) {
  const { rest, opts } = flags(args, { '--share': false })
  if (rest.length !== 1) fail('usage: unblock link <ticket> [--share]')
  const ticket = rest[0]
  if (!opts['--share']) {
    await request(`/api/asks/${encodeURIComponent(ticket)}`)
    const url = stable(await request('/api/health'), ticket)
    if (url) return output({ url }, url)
  }
  const data = await request('/api/links', { ticket, ttl_seconds: 900 })
  output(data, `${data.url}\nexpires in ${Math.max(1, Math.round((data.expires_at - Date.now()) / 60000))}m`)
}
const assetMime = (file) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.html': 'text/html', '.htm': 'text/html', '.mp4': 'video/mp4', '.webm': 'video/webm', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' })[extname(file).toLowerCase()] || 'application/octet-stream'
const localUrl = (url) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)
function localFile(base, url) { return resolve(base, decodeURIComponent(url.split(/[?#]/)[0])) }
function dataUri(base, url) {
  const file = localFile(base, url)
  return `data:${assetMime(file)};base64,${readFileSync(file).toString('base64')}`
}
function inlineMock(file) {
  const cssUrls = (css, base) => css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi, (all, double, single, bare) => {
    const url = (double ?? single ?? bare).trim()
    return url && localUrl(url) ? `url("${dataUri(base, url)}")` : all
  })
  const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((value) => value !== undefined)
  let html = readFileSync(file, 'utf8')
  if (!(html.match(/<meta\b[^>]*>/gi) ?? []).some((tag) => attribute(tag, 'name')?.toLowerCase() === 'viewport')) {
    const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">'
    if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (tag) => tag + viewport)
    else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, (tag) => tag + viewport)
    else if (/^\s*<!doctype\b[^>]*>/i.test(html)) html = html.replace(/^\s*<!doctype\b[^>]*>/i, (tag) => tag + viewport)
    else html = viewport + html
  }
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = attribute(tag, 'href')
    if (!href || !localUrl(href) || !(attribute(tag, 'rel') ?? '').split(/\s+/).includes('stylesheet')) return tag
    const cssFile = localFile(dirname(file), href)
    return `<style>${cssUrls(readFileSync(cssFile, 'utf8'), dirname(cssFile)).replace(/<\/style/gi, '<\\/style')}</style>`
  })
  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (all, attrs, css) => `<style${attrs}>${cssUrls(css, dirname(file))}</style>`)
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attribute(tag, 'src')
    return src && localUrl(src) ? tag.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` src="${dataUri(dirname(file), src)}"`) : tag
  })
  return html
}
async function uploadScopeAsset(slug, bytes, type) {
  const base = await daemon(), token = authToken()
  const response = await fetch(`${base}/api/scope/${encodeURIComponent(slug)}/assets`, {
    method: 'POST', headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: bytes,
    signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `asset upload: HTTP ${response.status}`)
  return data
}
async function uploadDocImages(slug, doc, source) {
  for (const section of Array.isArray(doc) ? doc : doc.sections ?? []) {
    if (typeof section.body_md !== 'string') continue
    const lines = section.body_md.split('\n')
    let fence = null
    for (let i = 0; i < lines.length; i++) {
      if (fence !== null) {
        if (/^```\s*$/.test(lines[i])) { fence = null; continue }
        if (['demo', 'video'].includes(fence)) {
          const pair = lines[i].match(/^\s*(src|poster):\s*(.*?)\s*$/)
          if (pair && (pair[1] === 'src' || fence === 'video') && !/^(?:https?:\/\/|asset:)/i.test(pair[2])) {
            const file = localFile(dirname(resolve(source)), pair[2])
            const type = assetMime(file)
            if (!['text/html', 'video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(type)) throw new Error(`unsupported asset file ${file}`)
            const bytes = type === 'text/html' ? Buffer.from(inlineMock(file)) : readFileSync(file)
            const asset = await uploadScopeAsset(slug, bytes, type)
            lines[i] = `${pair[1]}: asset:${asset.id}`
          }
        }
        continue
      }
      if (/^```/.test(lines[i])) { fence = lines[i].match(/^```(demo|video)\s*$/)?.[1] ?? ''; continue }
      const image = lines[i].match(IMAGE_LINE)
      if (!image || image[2].startsWith('asset:')) continue
      if (image[3] !== undefined && image[3] !== 'phone') throw new Error('image title must be "phone"')
      if (!localUrl(image[2])) throw new Error(`image ${image[1]} must be a local file or asset: ref`)
      const file = localFile(dirname(resolve(source)), image[2])
      let asset
      if (extname(file).toLowerCase() === '.html') {
        const html = inlineMock(file)
        const uploaded = await uploadScopeAsset(slug, Buffer.from(html), 'text/html')
        const temp = mkdtempSync(join(tmpdir(), 'unblock-mock-'))
        try {
          const page = join(temp, 'mock.html')
          writeFileSync(page, html)
          const frame = image[3] === 'phone' ? 'phone' : 'desktop'
          const args = [pathToFileURL(page).href, '--widths', frame === 'phone' ? '390' : '1280', '--themes', 'light,dark', '--out', temp, ...(frame === 'phone' ? ['--touch'] : [])]
          let stdout = '', stderr = '', ran = false, light, dark, lightBytes, darkBytes
          try {
            const result = await promisify(execFile)(process.env.UNBLOCK_PAGE_SHOT || join(homedir(), '.local', 'bin', 'page-shot'), args, { timeout: 120_000, maxBuffer: 1024 * 1024 })
            ran = true
            stdout = result.stdout
            stderr = result.stderr
            const rendered = JSON.parse(stdout)
            if (!rendered?.ok) throw new Error('page-shot failed')
            light = rendered.shots?.find((shot) => shot.theme === 'light')
            dark = rendered.shots?.find((shot) => shot.theme === 'dark')
            if (!light?.file || !dark?.file) throw new Error('page-shot did not return light and dark files')
            lightBytes = readFileSync(light.file)
            darkBytes = readFileSync(dark.file)
          } catch (error) {
            const missing = !ran && ['ENOENT', 'EACCES', 'EPERM'].includes(error.code)
            const tail = [error.stderr ?? stderr, error.stdout ?? stdout].filter(Boolean).join('\n').trim().split('\n').slice(-10).join('\n')
            throw new Error(`can't render ${file}: page-shot ${missing ? 'not found' : 'failed'} (render it to PNG yourself and reference the PNG)${!missing && tail ? `\n${tail}` : ''}`)
          }
          const lightAsset = await uploadScopeAsset(slug, lightBytes, assetMime(light.file))
          const darkAsset = await uploadScopeAsset(slug, darkBytes, assetMime(dark.file))
          asset = await uploadScopeAsset(slug, Buffer.from(JSON.stringify({ kind: 'mock', html: uploaded.id, light: lightAsset.id, dark: darkAsset.id, frame })), 'application/json')
        } finally { rmSync(temp, { recursive: true, force: true }) }
      } else asset = await uploadScopeAsset(slug, readFileSync(file), assetMime(file))
      lines[i] = `![${image[1]}](asset:${asset.id}${image[3] === 'phone' ? ' "phone"' : ''})`
    }
    section.body_md = lines.join('\n')
  }
}

async function scope(args) {
  const usage = 'usage: unblock scope list | url <slug> | notes <slug> [--since N] | ask <slug> --section <id> --quote <quote> [--rec text] [--why text] [--option text ...] <question...> | reply <slug> [T#] [--rec "text"] [--why "text"] [--option "text" ...] <text...> | edit <slug> T# [--section id --quote "text"] [--option "text" ...] [--text "text"] [--json] | resolve <slug> T# [--decision text] | doc <slug> [--from <file>] | patch <slug> <id> --from <file> [--keep term ...] | lint <slug> --from <file> [--keep term ...] | threads <slug> [--open] [--json]; writes accept --keep term (repeatable)'
  const [sub = 'list', slug, ...words] = args
  if (['ask', 'reply', 'resolve', 'edit'].includes(sub)) {
    if (words.at(-1) === '--json') { json = true; words.pop() }
    const opts = {}
    const allowed = sub === 'ask' ? ['--section', '--quote', '--rec', '--why', '--option'] : sub === 'edit' ? ['--section', '--quote', '--option', '--text'] : sub === 'resolve' ? ['--decision'] : ['--rec', '--why', '--option']
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== '--keep') continue
      if (words[i + 1] === undefined) fail('--keep needs a value')
      ;(opts['--keep'] ??= []).push(words[i + 1])
      words.splice(i, 2)
      i--
    }
    let threadId
    if (sub !== 'ask' && THREAD_ID.test(words[0] ?? '')) threadId = words.shift()
    while (allowed.includes(words[0])) {
      const option = words.shift(), value = words.shift()
      if (value === undefined) fail(`${option} needs a value`)
      if (option === '--option' || option === '--keep') (opts[option] ??= []).push(value)
      else opts[option] = value
    }
    if (!slug) fail(usage)
    const base = `/api/scope/${encodeURIComponent(slug)}`
    const keep = opts['--keep'] !== undefined ? { keep: opts['--keep'] } : {}
    const options = { ...keep, ...(opts['--option'] !== undefined ? { options: opts['--option'] } : {}) }
    if (sub === 'edit') {
      if (!threadId || words.length || !Object.keys(opts).length || (!!opts['--section'] !== !!opts['--quote'])) fail(usage)
      const data = await request(`${base}/threads/${threadId}/edit`, { ...(opts['--section'] !== undefined ? { section: opts['--section'], quote: opts['--quote'] } : {}), ...options, ...(opts['--text'] !== undefined ? { text: opts['--text'] } : {}) })
      return output(data, `edited ${data.thread.id}`)
    }
    if (sub === 'ask') {
      if (!opts['--section'] || !opts['--quote'] || !words.length) fail(usage)
      const data = await request(`${base}/threads`, { section: opts['--section'], quote: opts['--quote'], text: words.join(' '), ...options, ...(opts['--rec'] !== undefined ? { recommendation: opts['--rec'] } : {}), ...(opts['--why'] !== undefined ? { why: opts['--why'] } : {}) })
      return output(data, `asked ${data.thread.id} on §${opts['--section']}`)
    }
    if (sub === 'resolve') {
      if (!threadId || words.length) fail(usage)
      const data = await request(`${base}/threads/${threadId}/resolve`, { ...keep, ...(opts['--decision'] !== undefined ? { decision: opts['--decision'] } : {}) })
      return output(data, `resolved ${data.thread.id}`)
    }
    if (!words.length || words[0] === '--to') fail(usage)
    let data
    if (threadId) data = await request(`${base}/threads/${threadId}/reply`, { text: words.join(' '), ...options, ...(opts['--rec'] !== undefined ? { recommendation: opts['--rec'] } : {}), ...(opts['--why'] !== undefined ? { why: opts['--why'] } : {}) })
    else {
      if (opts['--option'] !== undefined) fail(usage)
      const { scope } = await request(base)
      data = await request(`${base}/threads`, { section: 'title', quote: scope.title, kind: 'comment', text: words.join(' '), ...keep })
    }
    return output(data, `replied ${data.thread.id}`)
  }
  const { rest, opts } = flags(args, { '--since': true, '--from': true, '--open': false, '--keep': true })
  const [verb = 'list', name, ...extra] = rest
  if (verb === 'list' && !name && !extra.length && !Object.keys(opts).length) {
    const { scopes } = await request('/api/scope')
    const health = await request('/api/health')
    const base = health.public_origin?.replace(/\/$/, '') || `http://127.0.0.1:${new URL(await daemon()).port}`
    const listed = scopes.map((item) => ({ ...item, url: `${base}/s/${item.slug}` }))
    return output({ scopes: listed }, listed.map((item) => `${item.slug}  ${item.open} open  ${item.title}  ${item.url}`).join('\n'))
  }
  if (verb === 'patch') {
    if (!name || extra.length !== 1 || !opts['--from'] || opts['--since'] || opts['--open']) fail(usage)
    let section
    try {
      const raw = readFileSync(opts['--from'], 'utf8').trim()
      const heading = raw.match(/^#{1,3}[ \t]+(.+?)(?:[ \t]+\{#[^}]+\})?[ \t]*(?:\r?\n|$)/)
      section = { body_md: (heading ? raw.slice(heading[0].length) : raw).trim(), ...(heading ? { heading: heading[1] } : {}) }
      await uploadDocImages(name, [section], opts['--from'])
    } catch (error) { fail(error.message, 1) }
    const data = await request(`/api/scope/${encodeURIComponent(name)}/sections/${encodeURIComponent(extra[0])}`, { ...section, ...(opts['--keep'] ? { keep: opts['--keep'] } : {}) }, { method: 'PUT' })
    lintOutput(data)
    return output(data, `revision ${data.revision}${data.detached.length ? `\ndetached: ${data.detached.join(', ')}` : ''}`)
  }
  if (!name || extra.length) fail(usage)
  if (verb === 'url' && !Object.keys(opts).length) {
    const health = await request('/api/health')
    const base = health.public_origin?.replace(/\/$/, '') || `http://127.0.0.1:${new URL(await daemon()).port}`
    const url = `${base}/s/${encodeURIComponent(name)}`
    return output({ url }, url)
  }
  if (opts['--keep'] && !['doc', 'lint'].includes(verb)) fail(usage)
  if (verb === 'doc' || verb === 'lint') {
    if (opts['--since'] || opts['--open']) fail(usage)
    if (verb === 'lint' && !opts['--from']) fail(usage)
    if (!opts['--from']) {
      if (opts['--keep']) fail(usage)
      const { scope } = await request(`/api/scope/${encodeURIComponent(name)}`)
      return output({ revision: scope.revision, sections: scope.doc.sections }, docToMarkdown(scope.doc))
    }
    let doc
    try {
      const raw = readFileSync(opts['--from'], 'utf8')
      doc = opts['--from'].endsWith('.json') ? JSON.parse(raw) : docFromMarkdown(raw)
    } catch (error) { fail(error.message) }
    if (verb === 'lint') {
      let sections = Array.isArray(doc) ? doc : doc.sections
      try {
        const base = await daemon({ start: false }), token = authToken()
        const response = await fetch(`${base}/api/scope/${encodeURIComponent(name)}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const { scope } = await response.json()
        const stored = scope.doc.sections
        // Publishing turns local image refs into asset: refs, and image lines are never linted.
        const text = (md) => String(md).split('\n').filter((line) => !IMAGE_LINE.test(line)).join('\n')
        sections = sections.filter((section) => {
          const old = stored.find((item) => item.id === section.id)
          return !old || old.heading !== section.heading || text(old.body_md) !== text(section.body_md)
        })
      } catch { console.error('Could not read the current scope; linting every section.') }
      const result = lintDoc(sections, { keep: opts['--keep'] })
      lintOutput(result)
      return output(result, 'No unslop findings.')
    }
    try { await uploadDocImages(name, doc, opts['--from']) } catch (error) { fail(error.message, 1) }
    const data = await request(`/api/scope/${encodeURIComponent(name)}/doc`, { sections: Array.isArray(doc) ? doc : doc.sections, ...(opts['--keep'] ? { keep: opts['--keep'] } : {}) }, { method: 'PUT' })
    lintOutput(data)
    return output(data, `revision ${data.revision}${data.detached.length ? `\ndetached: ${data.detached.join(', ')}` : ''}`)
  }
  if (verb === 'threads') {
    if (opts['--from'] || opts['--since']) fail(usage)
    const { scope } = await request(`/api/scope/${encodeURIComponent(name)}`)
    const threads = orderThreads(scope).filter((t) => !opts['--open'] || t.status === 'open')
    return output({ threads }, threads.map((t) => `${t.id} ${t.status} ${t.kind} §${headingOf(scope, t.anchor.section)} "${quoteSnippet(t.anchor.quote)}": ${t.messages[0].text}${t.recommendation ? ` [rec: ${t.recommendation}]` : ''}${t.options ? ` [options: ${t.options.join(' | ')}]` : ''}${t.status === 'resolved' ? ` → ${t.resolution.decision}${t.resolution.by === 'alex' && !t.resolution.confirmed_at ? ' (unconfirmed)' : ''}` : ''}`).join('\n'))
  }
  if (verb === 'notes') {
    if (opts['--open']) fail(usage)
    if (opts['--since'] !== undefined && !/^\d+$/.test(opts['--since'])) fail('--since must be a nonnegative integer')
    if (opts['--from'] && !['alex', 'agent'].includes(opts['--from'])) fail('--from must be alex or agent')
    const query = new URLSearchParams()
    if (opts['--since'] !== undefined) query.set('since', opts['--since'])
    if (opts['--from']) query.set('from', opts['--from'])
    const data = await request(`/api/scope/${encodeURIComponent(name)}/notes?${query}`)
    return output(data, data.notes.map((note) => `#${note.id} ${note.at} ${note.from}${note.via === 'voice' ? ' (voice)' : ''} ${note.thread ?? ''} ${note.event ?? ''} ${note.text}`).join('\n'))
  }
  fail(usage)
}
async function peek(args) {
  const { rest } = flags(args, {})
  if (rest.length !== 1) fail('usage: unblock peek <ticket>')
  const ask = await request(`/api/asks/${encodeURIComponent(rest[0])}`)
  if (json) return output(safe(ask))
  console.log(`${ask.ticket}  ${ask.title}  [${ask.status}]`)
  for (const field of ask.fields) {
    const value = ask.draft?.[field.name]
    const note = ask.field_context?.[field.name]
    console.log(`  ${field.name}: ${value === undefined ? '—' : field.type === 'secret' ? 'stored secret' : JSON.stringify(value)}`)
    if (note) console.log(`      context: ${note}`)
  }
  if (ask.draft_reply) console.log(`  reply: ${ask.draft_reply}`)
  console.log(ask.draft_updated_at ? `  last typed ${age(ask.draft_updated_at)} ago` : '  nothing typed yet')
}
/** Local only. Never expose this through HTTP or MCP. */
async function reveal(args) {
  if (args.includes('--json')) fail('reveal does not support --json')
  const [ticket, field] = args
  if (!ticket || !field || args.length !== 2) fail('usage: unblock reveal <ticket> <field>')
  const ask = await request(`/api/asks/${encodeURIComponent(ticket)}`)
  const record = ask.answers?.[field]
  if (!record) fail(`no answer recorded for ${field}`, 1)
  if (typeof record !== 'object' || !record.store) fail(`${field} is not a secret`, 1)
  if (process.stdout.isTTY) console.error(`# ${field} from ${ticket} — piping this is safer than printing it`)
  process.stdout.write(await new SecretStore().reveal(record))
  if (process.stdout.isTTY) process.stdout.write('\n')
}
async function mirror(args) {
  const { rest } = flags(args, {})
  if (rest.length > 1) fail('usage: unblock mirror [path]')
  const path = resolve(rest[0] ?? 'docs/unblock/BLOCKERS.md')
  const { asks } = await request('/api/asks?profile=*')
  const open = asks.filter((a) => a.status === 'open')
  const groups = new Map()
  for (const ask of open) {
    const key = ask.origin.workspace_name ?? ask.origin.repo ?? 'elsewhere'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(ask)
  }
  const out = ['# Blockers', '', '<!-- Generated by `unblock mirror`. Do not edit; answer in the queue instead. -->',
    `<!-- ${new Date().toISOString()} -->`, '']
  if (!open.length) out.push('Nothing is waiting on you.', '')
  for (const [workspace, group] of groups) {
    out.push(`## ${workspace}`, '')
    for (const [i, ask] of group.entries()) {
      const tags = [ask.gating ? 'gating' : 'filed', ask.origin.agent, age(ask.created_at)].filter(Boolean).join(' · ')
      out.push(`### ${i + 1}. ${ask.title} — ${ask.why} [${tags}]`, '')
      for (const step of ask.steps ?? []) out.push(`- ${step}`)
      for (const l of ask.links ?? []) out.push(`- ${l.url}`)
      if (ask.missing.length) out.push(`- Needs: ${ask.missing.join(', ')}`)
      out.push(`- Answer: \`unblock answer ${ask.ticket} ...\` or open the queue`, '')
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, out.join('\n'))
  output({ path }, path)
}
function pidInfo() {
  try { return JSON.parse(readFileSync(join(stateDir(), 'daemon.json'), 'utf8')) } catch { return {} }
}
async function daemonCmd(args) {
  const { rest } = flags(args, {})
  const [sub = 'status'] = rest
  if (rest.length > 1 || !['start', 'stop', 'restart', 'status'].includes(sub)) fail('usage: unblock daemon start|stop|restart|status')
  if (sub === 'stop' || sub === 'restart') {
    const old = pidInfo().pid
    const label = process.env.UNBLOCK_LAUNCHD_LABEL || 'com.aneyman.unblock'
    const job = `gui/${process.getuid()}/${label}`
    const loaded = sub === 'restart' && spawnSync('launchctl', ['print', job], { stdio: 'ignore' }).status === 0
    if (loaded) {
      const kicked = spawnSync('launchctl', ['kickstart', '-k', job], { stdio: 'ignore' })
      if (kicked.status !== 0) fail(`could not restart launchd job; check ${join(stateDir(), 'daemon.log')}`, 1)
    } else {
      if (old) {
        try { process.kill(old, 'SIGTERM') } catch { /* already stopped */ }
      }
      if (sub === 'stop') {
        try { unlinkSync(join(stateDir(), 'daemon.json')) } catch { /* already gone */ }
        return output({ running: false }, old ? `stopped (pid ${old})` : 'not running')
      }
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (!loaded) {
        try { await daemon({ timeoutMs: 1500 }) } catch { /* retry until deadline */ }
      }
      const current = pidInfo().pid
      if (current && current !== old) {
        try {
          const base = await daemon({ start: false })
          await request('/api/health', undefined, { start: false })
          return output({ running: true, base, pid: current }, `restarted (pid ${current}) · ${base}`)
        } catch { /* retry */ }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    fail(`daemon did not restart; check ${join(stateDir(), 'daemon.log')}`, 1)
  }
  if (sub === 'start') {
    const base = await daemon().catch((error) => fail(error.message, 1))
    return output({ running: true, base, pid: pidInfo().pid }, `unblock daemon at ${base}`)
  }
  try {
    const base = await daemon({ start: false })
    const health = await request('/api/health', undefined, { start: false })
    output({ running: true, base, pid: pidInfo().pid, backend: health.backend,
      public_origin: health.public_origin }, `running at ${base} · secrets: ${health.backend}`)
  } catch {
    output({ running: false, base: null, pid: null, backend: null, public_origin: null }, 'not running')
  }
}
function help() {
  console.log(`unblock [list] [--all] [--project P] [--json]   what is waiting, grouped by project
unblock show <ticket> [--json]                   one ask in full (never secret values)
unblock answer <ticket> <value>                  answer a one-question ask in one line
unblock answer <ticket> name=value ...           answer by question name
unblock receipt <ticket> [--before a.png] [--after b.png] [--url U]
unblock pay <ticket> [--payment-method <id>]
unblock close <ticket> <reason...>               withdraw an open ask with a one-line reason
unblock file [path|-]                            file an ask from JSON (same shape as the MCP tool)
unblock update <ticket> [path|-]                 revise an open ask from a JSON patch
unblock link <ticket> [--share]                  the stable queue link; --share mints a 15-minute link
unblock peek <ticket>                            what they have typed so far
unblock reveal <ticket> <field>                  print a stored secret (this machine only)
unblock mirror [path]                            write BLOCKERS.md from the queue
unblock scope [list|url|notes|threads]           scoping docs and anchored threads
unblock scope ask <slug> --section <id> --quote "text" [--rec "text"] [--why "text"] [--option "text" ...] <question...>
unblock scope reply <slug> [T#] [--rec "text"] [--why "text"] [--option "text" ...] <text...>
unblock scope edit <slug> T# [--section id --quote "text"] [--option "text" ...] [--text "text"] [--json]
unblock scope resolve <slug> T# [--decision "text"]
unblock scope doc <slug> [--from <file.md|file.json>] [--keep "term" ...]
unblock scope patch <slug> <id> --from <section.md> [--keep "term" ...]
unblock scope lint <slug> --from <file.md|file.json> [--keep "term" ...]
  ask, reply, edit and resolve also accept --keep "term" (repeatable).
  --from uploads local image lines and renders HTML mocks ("phone" = 390px).
unblock ui                                       interactive queue in the terminal
unblock daemon start|stop|restart|status
unblock mcp                                      run the MCP server

--json works on every command except reveal, ui and mcp.
Exit codes: 0 ok · 1 daemon unreachable or unexpected error · 2 usage error · 3 no such ask · 4 rejected by the queue · 5 ask is not open.`)
}
try {
  if (['help', '-h', '--help'].includes(command)) help()
  else if (command === 'list') await list(input)
  else if (command === 'show') await show(input)
  else if (command === 'answer') await answer(input)
  else if (command === 'receipt') await receipt(input)
  else if (command === 'pay') await pay(input)
  else if (command === 'close') await close(input)
  else if (command === 'file') await file(input)
  else if (command === 'update') await update(input)
  else if (command === 'link') await link(input)
  else if (command === 'peek') await peek(input)
  else if (command === 'reveal') await reveal(input)
  else if (command === 'mirror') await mirror(input)
  else if (command === 'scope') await scope(input)
  else if (command === 'daemon') await daemonCmd(input)
  else if (command === 'ui' || command === 'mcp') {
    if (input.includes('--json')) fail(`${command} does not support --json`)
    const path = command === 'ui' ? join(ROOT, 'plugin', 'tui.js') : join(ROOT, 'src', 'mcp.js')
    spawn(process.execPath, [path, ...input], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0))
  } else fail(`unknown command: ${command}\nTry: unblock help`)
} catch (error) { fail(error.message, 1) }
