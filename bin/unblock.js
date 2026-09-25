#!/usr/bin/env node
/** The CLI is a local client. Only reveal resolves a secret, and only here. */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'

import { daemon, authToken, stateDir } from '../plugin/paths.js'
import { SecretStore } from '../src/secrets.js'

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

async function request(path, body, { start = true } = {}) {
  let base
  try { base = await daemon({ start }) } catch (error) { fail(error.message, 1) }
  let response
  try {
    response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
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
    const message = data.error || `HTTP ${response.status}`
    if (data.code === 'ASK_NOT_OPEN') fail(message, 5)
    if (response.status === 404) fail(message, 3)
    if (response.status === 400 || response.status === 409 || response.status === 422) {
      if (data.ticket) {
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
      opts[arg] = allowed[arg] ? args[++i] : true
      if (opts[arg] === undefined) fail(`${arg} needs a value`)
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
  if (json) return output({ asks: shown.map((ask) => ({ ...ask, link: stable(health, ask.ticket) })) })
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
      console.log(`             ${[ask.status === 'open' ? null : ask.status, ask.purpose ?? 'blocker',
        ask.kind === 'park' && ask.status === 'open' ? 'agent stopped' : null,
        ask.status === 'open' ? count(required(ask).length) : null, age(ask.created_at), ask.origin?.agent].filter(Boolean).join(' · ')}`)
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
  console.log([ask.status, ask.purpose ?? 'blocker', project(ask), age(ask.created_at), ask.origin?.agent,
    ask.origin?.pane_id && `pane ${ask.origin.pane_id}`].filter(Boolean).join(' · '))
  const link = stable(health, ask.ticket)
  if (link) console.log(link)
  console.log(`\nWhy\n${wrap(ask.why)}`)
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
  if (ask.status !== 'open') fail(`ask ${ticket} is ${ask.status}, not open`, 5)
  const values = {}
  if (pairs.length === 1 && !pairs[0].includes('=')) {
    const missing = required(ask)
    if (missing.length !== 1) fail(`answer by name: ${missing.map((f) => `${f.name} (${f.label})`).join(', ')}`)
    values[missing[0].name] = parseValue(missing[0], pairs[0])
  } else {
    for (const pair of pairs) {
      const i = pair.indexOf('=')
      if (i < 1) fail(`expected name=value, got: ${pair}`)
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
unblock close <ticket> <reason...>               withdraw an open ask with a one-line reason
unblock file [path|-]                            file an ask from JSON (same shape as the MCP tool)
unblock update <ticket> [path|-]                 revise an open ask from a JSON patch
unblock link <ticket> [--share]                  the stable queue link; --share mints a 15-minute link
unblock peek <ticket>                            what they have typed so far
unblock reveal <ticket> <field>                  print a stored secret (this machine only)
unblock mirror [path]                            write BLOCKERS.md from the queue
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
  else if (command === 'close') await close(input)
  else if (command === 'file') await file(input)
  else if (command === 'update') await update(input)
  else if (command === 'link') await link(input)
  else if (command === 'peek') await peek(input)
  else if (command === 'reveal') await reveal(input)
  else if (command === 'mirror') await mirror(input)
  else if (command === 'daemon') await daemonCmd(input)
  else if (command === 'ui' || command === 'mcp') {
    if (input.includes('--json')) fail(`${command} does not support --json`)
    const path = command === 'ui' ? join(ROOT, 'plugin', 'tui.js') : join(ROOT, 'src', 'mcp.js')
    spawn(process.execPath, [path, ...input], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0))
  } else fail(`unknown command: ${command}\nTry: unblock help`)
} catch (error) { fail(error.message, 1) }
