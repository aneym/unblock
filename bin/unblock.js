#!/usr/bin/env node
/** The CLI is a local client. Only reveal resolves a secret, and only here. */
import { randomUUID } from 'node:crypto'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, extname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync, renameSync, statSync } from 'node:fs'
import { IMAGE_LINE } from '../src/scope-assets.js'
import { filerPid } from '../src/origin-process.js'
import { lintDoc } from '../src/scope-lint.js'

import { daemon, authToken, stateDir } from '../plugin/paths.js'
import { SecretStore } from '../src/secrets.js'
import { quoteSnippet } from '../src/scope-anchor.js'
import { kindOf } from '../src/doc-kinds.js'
import { docFromMarkdown, docToMarkdown, orderThreads, headingOf, THREAD_ID, APPS, validateScope, DOC_KINDS, DOC_WHERES } from '../src/scope-doc.js'
import { connect as railsConnect, railsAccessToken, railsResource, railsSecretIn } from '../src/rails-auth.js'

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
  const { rest, opts } = flags(args, { '--all': false, '--aside': false, '--project': true })
  if (rest.length) fail('usage: unblock list [--all] [--project P] [--json]')
  const { asks } = await request(`/api/asks?profile=*&includeClosed=${opts['--all'] ? 'true' : 'false'}`)
  const cutoff = Date.now() - 7 * 86400000
  const shown = asks.filter((ask) =>
    (ask.status === 'open' || (opts['--all'] && ['answered', 'cancelled'].includes(ask.status) &&
      (ask.closed_at ?? ask.answered_at ?? 0) >= cutoff)) &&
    (opts['--aside'] ? ask.set_aside_at != null : ask.set_aside_at == null && ask.weekly_at == null) &&
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
        ask.set_aside_at ? `set aside: ${ask.set_aside_reason}` : null,
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
  console.log([ask.status, ask.set_aside_at ? `set aside: ${ask.set_aside_reason}` : null, kindWord(ask), project(ask), age(ask.created_at), ask.origin?.agent,
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

async function keep(args) {
  const { rest } = flags(args, {})
  if (rest.length !== 1) fail('usage: unblock keep <ticket>')
  const result = await request(`/api/asks/${encodeURIComponent(rest[0])}/keep`, { pid: filerPid() })
  output({ ask: safe(result.ask) }, `kept ${rest[0]}`)
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
      pid: filerPid(),
      session_id: process.env.HERDR_SESSION_ID || process.env.CLAUDE_SESSION_ID,
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

async function scopeLinks(health, slug) {
  const base = health.public_origin?.replace(/\/$/, '') || `http://127.0.0.1:${new URL(await daemon()).port}`
  const encoded = encodeURIComponent(slug)
  const studio_url = `${base}/s/${encoded}`
  const url = health.scope_link_template ? health.scope_link_template.replaceAll('{slug}', encoded) : studio_url
  return { url, studio_url }
}

const SCOPE_USAGE = `unblock scope [list|url|notes|threads]           scoping docs and anchored threads
unblock scope new <slug> --pane <pane> [--app recruiter|closer|rails-admin] [--title "text"] [--kind scope|explainer|review|draft|writing|report] [--parent <slug>] [--sources <dir>...] [--answerer on|off]
unblock scope ask <slug> --section <id> --quote "text" [--rec "text"] [--why "text"] [--option "text" ...] <question...>
unblock scope ask <slug> --from <questions.json> [--keep "term" ...]
unblock scope reply <slug> [T#] [--rec "text"] [--why "text"] [--option "text" ...] <text...>
unblock scope edit <slug> T# [--section id --quote "text"] [--option "text" ...] [--text "text"] [--json]
unblock scope typing <slug> T# [--doing <text>] [--link <url>]
unblock scope reply <slug> T# --stream
unblock scope react <slug> T# [--clear]
unblock scope resolve <slug> T# [--decision "text"]
unblock scope reopen <slug> T# [--reason "text"]
unblock scope approve <slug> --by alex --quote "<verbatim>" [--at <iso>]
unblock scope unapprove <slug> --reason "<why>"
unblock scope publish <slug> [--where published|sent|posted|submitted] [--target "text"]
unblock scope destination <slug> --where published|sent|posted|submitted [--target "text"]
unblock scope app <slug> recruiter|closer|rails-admin
unblock scope kpi <slug> set --from <file.json>
unblock scope kpi <slug> list [--json]
unblock scope doc <slug> [--from <file.md|file.json>] [--keep "term" ...]
unblock scope patch <slug> <id> --from <section.md> [--keep "term" ...]
unblock scope lint <slug> --from <file.md|file.json> [--keep "term" ...]
unblock explain [list|url|notes|threads|doc|patch|lint|ask|reply|edit|resolve|reopen]
unblock explain new <slug> --pane <pane> [--title "text"] --sources <dir> [<dir>...] [--answerer on|off]`

function scopeNew(args, usage, mode = 'scope') {
  const slugRe = /^[a-z0-9][a-z0-9-]{0,63}$/
  const paneRe = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
  let pane, app, title, kind = mode === 'explain' ? 'explainer' : undefined, answerer, parent
  const sources = []
  const words = []
  for (let i = 1; i < args.length; i++) {
    const word = args[i]
    if (word === '--json') { json = true; continue }
    if (word === '--sources') {
      while (args[i + 1] && !args[i + 1].startsWith('--')) sources.push(args[++i])
      if (!sources.length) fail(usage)
      continue
    }
    if (word === '--pane' || word === '--app' || word === '--title' || word === '--kind' || word === '--answerer' || word === '--parent') {
      const value = args[++i]
      if (value === undefined) fail(usage)
      if (word === '--pane') pane = value
      else if (word === '--app') app = value
      else if (word === '--kind') kind = value
      else if (word === '--answerer') answerer = value
      else if (word === '--parent') parent = value
      else title = value
    } else if (word.startsWith('-')) fail(usage)
    else words.push(word)
  }
  const slug = words[0]
  if (words.length !== 1 || !slugRe.test(slug ?? '') || !paneRe.test(pane ?? '') || (app !== undefined && !APPS.includes(app))) fail(usage)
  if (kind !== undefined && !DOC_KINDS.includes(kind)) fail(usage)
  if (parent !== undefined && !slugRe.test(parent)) fail(usage)
  if (answerer !== undefined && answerer !== 'on' && answerer !== 'off') fail(usage)
  const resolved = sources.map((dir) => {
    const abs = resolve(dir)
    let stat
    try { stat = statSync(abs) } catch { fail(`no such source dir: ${abs}`) }
    if (!stat.isDirectory()) fail(`no such source dir: ${abs}`)
    return abs
  })
  if (resolved.length > 8) fail(usage)
  if (kind === 'explainer' && !resolved.length) fail(usage)
  const root = process.env.UNBLOCK_SCOPING_DIR || join(homedir(), '.agent-rails', 'scoping')
  const dir = join(root, slug)
  const path = join(dir, 'scope.json')
  if (existsSync(path)) fail(`${path} exists`, 4)
  const heading = title ?? slug
  const scope = { version: 2, slug, title: heading, pane, ...(app ? { app } : {}), ...(kind ? { kind } : {}), ...(parent ? { parent } : {}), ...(answerer ? { answerer } : {}), ...(resolved.length ? { sources: resolved } : {}), revision: 1, updated_at: new Date().toISOString(), doc: { sections: [{ id: 'title', heading, body_md: '' }] }, threads: [] }
  const problems = validateScope(scope)
  if (problems.length) fail(problems.join('\n'), 1)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'scope.json.tmp'), JSON.stringify(scope, null, 2))
  renameSync(join(dir, 'scope.json.tmp'), path)
  output({ slug, path }, `created ${slug} at ${path}`)
}

async function scope(args, mode = 'scope') {
  const usage = SCOPE_USAGE
  if (!args.length || ['--help', '-h', 'help'].includes(args[0])) {
    console.log(usage)
    return
  }
  if (args[0] === 'new') return scopeNew(args, usage, mode)
  const [sub = 'list', slug, ...words] = args
  if (sub === 'typing') {
    const { rest, opts } = flags(args, { '--doing': true, '--link': true })
    const [, name, threadId, ...extra] = rest
    if (!name || !THREAD_ID.test(threadId ?? '') || extra.length) fail(usage)
    const link = opts['--link']?.trim()
    if (link === '' || /[\x00-\x1f\x7f]/.test(link)) fail('invalid link')
    const data = await request(`/api/scope/${encodeURIComponent(name)}/threads/${threadId}/typing`, {
      ...(opts['--doing'] !== undefined ? { doing: opts['--doing'] } : {}),
      ...(link !== undefined ? { link } : {}),
    })
    return output(data, `typing ${threadId}`)
  }
  if (sub === 'reply' && words.includes('--stream')) {
    if (!slug || words.length !== 2 || !THREAD_ID.test(words[0] ?? '') || words[1] !== '--stream') fail(usage)
    const base = `/api/scope/${encodeURIComponent(slug)}/threads/${words[0]}`
    let whole = '', pending = '', lastAt = 0, ended = false, wake
    process.stdin.setEncoding('utf8')
    const ready = () => { wake?.(); wake = undefined }
    const onData = (chunk) => { whole += chunk; pending += chunk; ready() }
    const onEnd = () => { ended = true; ready() }
    let inputError
    const onError = (error) => { inputError = error; ended = true; ready() }
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('error', onError)
    try {
      while (!ended || pending) {
        if (!pending) { await new Promise(resolve => { wake = resolve }); continue }
        const wait = 100 - (Date.now() - lastAt)
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
        let size = Math.min(4000, pending.length)
        if (size < pending.length && /[\uD800-\uDBFF]/.test(pending[size - 1])) size--
        const chunk = pending.slice(0, size)
        pending = pending.slice(size)
        lastAt = Date.now()
        await request(`${base}/stream`, { chunk })
      }
      if (inputError) throw inputError
      if (!whole.trim()) fail('empty stdin')
      const data = await request(`${base}/reply`, { text: whole })
      return output(data, `replied ${data.thread.id}`)
    } finally {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
    }
  }
  if (sub === 'react') {
    const { rest, opts } = flags(args, { '--clear': false })
    const [, name, threadId, ...extra] = rest
    if (!name || !THREAD_ID.test(threadId ?? '') || extra.length) fail(usage)
    const data = await request(`/api/scope/${encodeURIComponent(name)}/threads/${threadId}/react`, { emoji: opts['--clear'] ? null : '👀' })
    return output(data, `${opts['--clear'] ? 'cleared' : 'seen'} ${data.thread.id}`)
  }
  if (sub === 'approve' || sub === 'unapprove') {
    if (!slug) fail(usage)
    const allowed = sub === 'approve' ? ['--by', '--quote', '--at'] : ['--reason']
    const opts = {}
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (word === '--json') { json = true; continue }
      if (!allowed.includes(word)) fail(usage)
      const value = words[++i]
      if (value === undefined) fail(usage)
      opts[word] = value
    }
    if (sub === 'approve') {
      const quote = opts['--quote']
      if (opts['--by'] === undefined || quote === undefined || opts['--by'] !== 'alex' || !String(quote).trim()) fail(usage)
      const data = await request(`/api/scope/${encodeURIComponent(slug)}/pm-approve`, { by: 'alex', quote, ...(opts['--at'] !== undefined ? { at: opts['--at'] } : {}), ...(process.env.HERDR_PANE_ID ? { pane: process.env.HERDR_PANE_ID } : {}) })
      return output(data, `approved ${slug} r${data.revision} (${data.approval.at_et}, ${data.approval.open} open)`)
    }
    const reason = opts['--reason']
    if (reason === undefined || !String(reason).trim()) fail(usage)
    const data = await request(`/api/scope/${encodeURIComponent(slug)}/unapprove`, { reason, ...(process.env.HERDR_PANE_ID ? { pane: process.env.HERDR_PANE_ID } : {}) })
    return output(data, `unapproved ${slug}`)
  }
  if (sub === 'publish' || sub === 'destination') {
    if (!slug) fail(usage)
    const opts = {}
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (word === '--json') { json = true; continue }
      if (word !== '--where' && word !== '--target') fail(usage)
      const value = words[++i]
      if (value === undefined) fail(usage)
      opts[word] = value
    }
    const where = opts['--where'], target = opts['--target']
    if ((where !== undefined && !DOC_WHERES.includes(where)) || (sub === 'destination' && where === undefined)) fail(usage)
    const base = `/api/scope/${encodeURIComponent(slug)}`
    if (sub === 'destination') {
      const data = await request(`${base}/destination`, { where, ...(target !== undefined ? { target } : {}) }, { method: 'PUT' })
      return output(data, `destination ${data.destination.where}${data.destination.target ? ` ${data.destination.target}` : ''}`)
    }
    const { scope: current } = await request(base)
    const data = await request(`${base}/publish`, { revision: current.revision, client_id: randomUUID(), ...(where !== undefined ? { where } : {}), ...(target !== undefined ? { target } : {}) })
    return output(data, `published v${data.version}`)
  }
  if (['ask', 'reply', 'resolve', 'reopen', 'edit'].includes(sub)) {
    if (words.at(-1) === '--json') { json = true; words.pop() }
    const opts = {}
    const allowed = sub === 'ask' ? ['--section', '--quote', '--rec', '--why', '--option'] : sub === 'edit' ? ['--section', '--quote', '--option', '--text'] : sub === 'resolve' ? ['--decision'] : sub === 'reopen' ? ['--reason'] : ['--rec', '--why', '--option']
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
      const from = words.indexOf('--from')
      if (from >= 0) {
        const file = words[from + 1]
        if (file === undefined || opts['--section'] || opts['--quote'] || opts['--rec'] || opts['--why'] || opts['--option'] || words.filter((_, index) => index !== from && index !== from + 1).length) fail(usage)
        let parsed
        try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { fail(error.message) }
        const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.questions : null
        if (!Array.isArray(list)) fail('invalid questions')
        const questions = list.map((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.section !== 'string' || !item.section.trim() || typeof item.quote !== 'string' || !item.quote.trim() || typeof item.question !== 'string' || !item.question.trim()) fail(`question ${index + 1}: missing section, quote or question`)
          return { section: item.section, quote: item.quote, text: item.question, ...(item.rec !== undefined ? { recommendation: item.rec } : {}), ...(item.why !== undefined ? { why: item.why } : {}), ...(item.options !== undefined ? { options: item.options } : {}) }
        })
        const data = await request(`${base}/threads/batch`, { questions, ...keep })
        return output(data, data.threads.map((thread) => `asked ${thread.id} on §${thread.anchor.section}`).join('\n'))
      }
      if (!opts['--section'] || !opts['--quote'] || !words.length) fail(usage)
      const data = await request(`${base}/threads`, { section: opts['--section'], quote: opts['--quote'], text: words.join(' '), ...options, ...(opts['--rec'] !== undefined ? { recommendation: opts['--rec'] } : {}), ...(opts['--why'] !== undefined ? { why: opts['--why'] } : {}) })
      return output(data, `asked ${data.thread.id} on §${opts['--section']}`)
    }
    if (sub === 'resolve') {
      if (!threadId || words.length) fail(usage)
      const data = await request(`${base}/threads/${threadId}/resolve`, { ...keep, ...(opts['--decision'] !== undefined ? { decision: opts['--decision'] } : {}) })
      return output(data, `resolved ${data.thread.id}`)
    }
    if (sub === 'reopen') {
      if (!threadId || words.length) fail(usage)
      const data = await request(`${base}/threads/${threadId}/reopen`, opts['--reason'] !== undefined ? { text: opts['--reason'] } : {})
      return output(data, `reopened ${data.thread.id}`)
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
    const want = mode === 'explain' ? 'explainer' : 'scope'
    const health = await request('/api/health')
    const listed = await Promise.all(scopes.filter((item) => (item.kind === 'writing' ? 'writing' : kindOf(item)) === want).map(async (item) => ({ ...item, ...await scopeLinks(health, item.slug) })))
    return output({ scopes: listed }, listed.map((item) => want === 'explainer' ? `${item.slug}  ${item.title}  ${item.url}` : `${item.slug}  ${item.app}  ${item.open} open  ${item.title}  ${item.url}`).join('\n'))
  }
  if (verb === 'app') {
    if (!APPS.includes(extra[0])) fail('app must be recruiter, closer or rails-admin')
    if (!name || extra.length !== 1 || Object.keys(opts).length) fail(usage)
    const data = await request(`/api/scope/${encodeURIComponent(name)}/app`, { app: extra[0] }, { method: 'PUT' })
    return output(data, `app ${data.app}`)
  }
  if (verb === 'kpi') {
    const line = (kpi) => `${kpi.id}  ${kpi.name}  ${kpi.direction} ${kpi.target}  ${kpi.source}  ${kpi.window_days}d`
    const action = extra[0]
    if (!name || extra.length !== 1 || !['set', 'list'].includes(action)) fail(usage)
    if (action === 'list') {
      if (Object.keys(opts).length) fail(usage)
      const { scope: current } = await request(`/api/scope/${encodeURIComponent(name)}`)
      const kpis = current.kpis ?? []
      return output({ kpis }, kpis.map(line).join('\n'))
    }
    if (!opts['--from'] || opts['--since'] !== undefined || opts['--open'] || opts['--keep']) fail(usage)
    let parsed
    try { parsed = JSON.parse(readFileSync(opts['--from'], 'utf8')) } catch (error) { fail(error.message, 1) }
    const kpis = Array.isArray(parsed) ? parsed : parsed?.kpis
    const data = await request(`/api/scope/${encodeURIComponent(name)}/kpis`, { kpis }, { method: 'PUT' })
    return output(data, data.kpis.map(line).join('\n'))
  }
  if (verb === 'patch') {
    if (!name || extra.length !== 1 || !opts['--from'] || opts['--since'] || opts['--open']) fail(usage)
    let section
    try {
      const raw = readFileSync(opts['--from'], 'utf8').trim()
      const heading = raw.match(/^#{1,3}[ \t]+(.+?)(?:[ \t]+\{#([^}]+)\})?[ \t]*(?:\r?\n|$)/)
      if (heading?.[2] && heading[2] !== extra[0]) fail(`${opts['--from']} is headed {#${heading[2]}}, which names §${heading[2]}, not §${extra[0]}. Fix the id or patch §${heading[2]}.`, 1)
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
    const links = await scopeLinks(health, name)
    return output(links, links.url)
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
        if (response.status !== 404) {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const { scope } = await response.json()
          const stored = scope.doc.sections
          // Publishing turns local image refs into asset: refs, and image lines are never linted.
          const text = (md) => String(md).split('\n').filter((line) => !IMAGE_LINE.test(line)).join('\n')
          sections = sections.filter((section) => {
            const old = stored.find((item) => item.id === section.id)
            return !old || old.heading !== section.heading || text(old.body_md) !== text(section.body_md)
          })
        }
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
    return output({ threads }, threads.map((t) => `${t.id} ${t.status} ${t.kind} §${headingOf(scope, t.anchor.section)} "${quoteSnippet(t.anchor.quote)}": ${t.messages[0].text}${t.recommendation ? ` [rec: ${t.recommendation}]` : ''}${t.options ? ` [options: ${t.options.join(' | ')}]` : ''}${t.status === 'resolved' ? ` → ${t.resolution.decision}${t.resolution.by === 'alex' && t.resolution.how === 'own' && t.resolution.alex_words?.includes('?') ? ` (his answer is a question: unblock scope reopen ${name} ${t.id}, then answer)` : t.resolution.by === 'alex' && !t.resolution.confirmed_at ? ' (unconfirmed)' : ''}` : ''}`).join('\n'))
  }
  if (verb === 'notes') {
    if (opts['--open']) fail(usage)
    if (opts['--since'] !== undefined && !/^\d+$/.test(opts['--since'])) fail('--since must be a nonnegative integer')
    if (opts['--from'] && !['alex', 'agent'].includes(opts['--from'])) fail('--from must be alex or agent')
    const query = new URLSearchParams()
    if (opts['--since'] !== undefined) query.set('since', opts['--since'])
    if (opts['--from']) query.set('from', opts['--from'])
    const data = await request(`/api/scope/${encodeURIComponent(name)}/notes?${query}`)
    return output(data, data.notes.map((note) => `#${note.id} ${note.at} ${note.from}${note.via === 'voice' ? ' (voice)' : ''} ${note.thread ?? ''} ${note.event ?? ''} ${note.text}${(note.images ?? []).map(path => `\n  ${path}`).join('')}`).join('\n'))
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
const MCP_PROTOCOL = '2025-06-18'

function mcpErrorCode(body, status, token) {
  const raw = typeof body?.error === 'string'
    ? body.error
    : body?.error?.message || body?.error?.code || `HTTP_${status}`
  const text = String(raw).split('\n')[0]
  if ((token && text.includes(token)) || railsSecretIn(text)) return 'error'
  return text || 'error'
}

function parseMcpBody(type, text) {
  if (!text) return null
  if (String(type || '').includes('text/event-stream')) {
    const events = []
    let data = []
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      else if (line === '' && data.length) { events.push(data.join('\n')); data = [] }
    }
    if (data.length) events.push(data.join('\n'))
    const last = events.at(-1)
    return last ? JSON.parse(last) : null
  }
  return JSON.parse(text)
}

function openAsks(result) {
  const piles = [result?.structuredContent, result]
  for (const pile of piles) {
    if (pile && typeof pile.open === 'number') return pile.open
  }
  const text = Array.isArray(result?.content) ? result.content.map((part) => part?.text || '').join('\n') : ''
  if (text) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed.open === 'number') return parsed.open
    } catch { /* plain text */ }
    const match = text.match(/(\d+)\s+open asks/)
    if (match) return Number(match[1])
  }
  const error = new Error('summary_unavailable')
  error.code = 'summary_unavailable'
  throw error
}

async function mcpPost(resource, token, message, sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
  }
  if (sessionId) {
    headers['mcp-session-id'] = sessionId
    headers['mcp-protocol-version'] = MCP_PROTOCOL
  }
  const response = await fetch(resource, {
    method: 'POST', headers, body: JSON.stringify(message), redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let body
  try { body = parseMcpBody(response.headers.get('content-type'), text) } catch { body = null }
  if (!response.ok || body?.error) {
    const error = new Error(mcpErrorCode(body, response.status, token))
    error.code = error.message
    throw error
  }
  return { body, sessionId: response.headers.get('mcp-session-id') || sessionId }
}

async function hostedOpenAsks(resource, token) {
  const initialized = await mcpPost(resource, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'unblock', version: '0.1.0' } },
  })
  await mcpPost(resource, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, initialized.sessionId).catch((error) => {
    if (error.code === 'HTTP_400' || error.message === 'HTTP_400') return null
    throw error
  })
  const called = await mcpPost(resource, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'queue.summary', arguments: {} },
  }, initialized.sessionId)
  const result = called.body?.result
  if (result?.isError) {
    const error = new Error('tool_error')
    error.code = 'tool_error'
    throw error
  }
  return openAsks(result)
}

// Approving from the Book or a phone needs a callback those devices can reach: tailscale serve on
// Studio forwards this https address to the loopback port connect listens on.
const TAILNET_CALLBACK = 'https://studio.tailf266ac.ts.net:8490/callback'
const TAILNET_PORT = 4490

function tailnetConnect(opts) {
  const hours = opts['--timeout-hours'] === undefined ? 24 : Number(opts['--timeout-hours'])
  if (!Number.isFinite(hours) || hours <= 0 || hours > 72) fail('--timeout-hours must be more than 0 and at most 72')
  const portText = process.env.UNBLOCK_RAILS_CALLBACK_PORT
  const port = portText === undefined ? TAILNET_PORT : Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('UNBLOCK_RAILS_CALLBACK_PORT must be a port number')
  return railsConnect({
    redirectUri: process.env.UNBLOCK_RAILS_CALLBACK || TAILNET_CALLBACK,
    port,
    timeoutMs: Math.round(hours * 3_600_000),
    // The URL holds a state value and a PKCE challenge, no secret; the file lets another tab hand it on.
    openUrl: (url) => {
      console.error('Open this URL and approve:')
      console.error(url)
      const dir = stateDir()
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, 'rails-connect-url')
      rmSync(file, { force: true })
      writeFileSync(file, `${url}\n`, { mode: 0o600, flag: 'wx' })
    },
  })
}

async function rails(args) {
  const { rest, opts } = flags(args, { '--tailnet': false, '--timeout-hours': true })
  const [sub] = rest
  if (rest.length !== 1 || !['connect', 'status'].includes(sub)) fail('usage: unblock rails connect [--tailnet [--timeout-hours N]]|status')
  if ((opts['--tailnet'] || opts['--timeout-hours'] !== undefined) && sub !== 'connect') fail('--tailnet is for rails connect')
  if (opts['--timeout-hours'] !== undefined && !opts['--tailnet']) fail('--timeout-hours needs --tailnet')
  if (sub === 'connect') {
    const result = await (opts['--tailnet'] ? tailnetConnect(opts) : railsConnect())
    return output({ client_id: result.client_id }, `Connected as client ${result.client_id.slice(0, 8)}…`)
  }
  const token = await railsAccessToken()
  const open = await hostedOpenAsks(await railsResource(), token)
  output({ open }, `Hosted Unblock: connected, ${open} open asks`)
}

// Rails errors can carry server text; only a plain code reaches stderr.
function railsErrorCode(error) {
  const code = String(error?.code || error?.message || '')
  return /^[a-z_]{1,40}$/.test(code) ? code : 'rails_error'
}

function help() {
  console.log(`unblock [list] [--aside] [--all] [--project P] [--json]   what is waiting, grouped by project
unblock show <ticket> [--json]                   one ask in full (never secret values)
unblock answer <ticket> <value>                  answer a one-question ask in one line
unblock answer <ticket> name=value ...           answer by question name
unblock receipt <ticket> [--before a.png] [--after b.png] [--url U]
unblock pay <ticket> [--payment-method <id>]
unblock keep <ticket>                            keep an ask in today’s queue
unblock close <ticket> <reason...>               withdraw an open ask with a one-line reason
unblock file [path|-]                            file an ask from JSON (same shape as the MCP tool)
unblock update <ticket> [path|-]                 revise an open ask from a JSON patch
unblock link <ticket> [--share]                  the stable queue link; --share mints a 15-minute link
unblock peek <ticket>                            what they have typed so far
unblock reveal <ticket> <field>                  print a stored secret (this machine only)
unblock mirror [path]                            write BLOCKERS.md from the queue
${SCOPE_USAGE}
  ask, reply, edit and resolve also accept --keep "term" (repeatable).
  --from uploads local image lines and renders HTML mocks ("phone" = 390px).
unblock ui                                       interactive queue in the terminal
unblock daemon start|stop|restart|status
unblock rails connect                            approve once on rails.so
unblock rails connect --tailnet [--timeout-hours N]   approve from another device via Studio's tailnet callback
unblock rails status                             hosted Unblock connection and open asks
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
  else if (command === 'keep') await keep(input)
  else if (command === 'close') await close(input)
  else if (command === 'file') await file(input)
  else if (command === 'update') await update(input)
  else if (command === 'link') await link(input)
  else if (command === 'peek') await peek(input)
  else if (command === 'reveal') await reveal(input)
  else if (command === 'mirror') await mirror(input)
  else if (command === 'scope') await scope(input)
  else if (command === 'explain') await scope(input, 'explain')
  else if (command === 'daemon') await daemonCmd(input)
  else if (command === 'rails') await rails(input)
  else if (command === 'ui' || command === 'mcp') {
    if (input.includes('--json')) fail(`${command} does not support --json`)
    const path = command === 'ui' ? join(ROOT, 'plugin', 'tui.js') : join(ROOT, 'src', 'mcp.js')
    spawn(process.execPath, [path, ...input], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0))
  } else fail(`unknown command: ${command}\nTry: unblock help`)
} catch (error) { fail(command === 'rails' ? railsErrorCode(error) : error.message, 1) }
