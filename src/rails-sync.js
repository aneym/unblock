import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadOrCreateRailsSyncSecret } from './daemon.js'

const PROTOCOL = '2025-06-18'
const FIELD_NAME = /^[a-z][a-z0-9_]{0,47}$/
const MIRROR_TYPES = new Set(['text', 'choice', 'confirm', 'paste'])
const TTL_MAX = 2592000

function defaultLog(message) {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`)
}

function clip(value, max) {
  return String(value).slice(0, max)
}

function flat(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

function assertHostedUrl(hostedUrl) {
  let url
  try { url = new URL(hostedUrl) } catch { throw new Error('hostedUrl must be https') }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return
  throw new Error('hostedUrl must be https')
}

function mirrorable(ask) {
  const fields = Array.isArray(ask.fields) ? ask.fields : []
  return fields.every((field) => field?.type !== 'secret' && FIELD_NAME.test(field?.name || ''))
}

function mapPurpose(ask) {
  const fields = Array.isArray(ask.fields) ? ask.fields : []
  const decisionTypes = new Set(['text', 'choice', 'confirm'])
  if (ask.purpose === 'decision' && fields.every((field) => field.recommend) && fields.every((field) => decisionTypes.has(field.type))) return 'decision'
  if (ask.purpose === 'blocker' && fields.every((field) => !field.recommend) && fields.some((field) => field.type === 'confirm' || field.type === 'paste')) return 'blocker'
  return 'question'
}

function objectLine(label, value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parts = []
  for (const key of keys) {
    if (value[key] == null || value[key] === '') continue
    const text = Array.isArray(value[key]) ? value[key].map(flat).filter(Boolean).join(', ') : flat(value[key])
    if (text) parts.push(`${key} ${text}`)
  }
  return parts.length ? `${label}: ${parts.join(', ')}` : null
}

function mapWhy(ask) {
  const lines = [typeof ask.why === 'string' ? ask.why : '']
  if (ask.only_you) lines.push(`Only you: ${flat(ask.only_you)}`)
  if (ask.blocks != null && ask.blocks !== '') {
    const blocks = Array.isArray(ask.blocks) ? ask.blocks.map(flat).filter(Boolean).join(', ') : flat(ask.blocks)
    if (blocks) lines.push(`Blocks: ${blocks}`)
  }
  if (ask.level) lines.push(`Level: ${flat(ask.level)}`)
  if (ask.minutes != null && ask.minutes !== '') lines.push(`About ${ask.minutes} min`)
  if (ask.after) lines.push(`After: ${flat(ask.after)}`)
  if (ask.summary) lines.push(`Summary: ${flat(ask.summary)}`)
  const message = objectLine('Message', ask.message, ['to', 'via', 'subject', 'text'])
  const spend = objectLine('Spend', ask.spend, ['item', 'vendor', 'amount_cents', 'currency'])
  const plan = objectLine('Plan', ask.plan, ['site', 'start_url', 'changes'])
  const permission = objectLine('Permission', ask.permission, ['tool', 'summary', 'command'])
  for (const line of [message, spend, plan, permission]) if (line) lines.push(line)
  return lines.filter((line) => line != null && line !== '').join('\n').slice(0, 2000)
}

function mapChoice(choice) {
  if (typeof choice === 'string') return clip(choice, 200)
  if (choice && typeof choice === 'object') {
    const value = clip(choice.value ?? '', 200)
    return { value, label: clip(choice.label ?? value, 200) }
  }
  return clip(choice, 200)
}

function mapFields(ask) {
  const source = Array.isArray(ask.fields) ? ask.fields : []
  const fields = []
  for (const field of source) {
    if (fields.length >= 12) break
    if (!MIRROR_TYPES.has(field.type)) continue
    const mapped = {
      name: field.name,
      type: field.type,
      label: clip(field.label ?? field.name, 120),
    }
    if (typeof field.help === 'string' && field.help) mapped.help = clip(field.help, 600)
    if (typeof field.required === 'boolean') mapped.required = field.required
    if (field.type === 'choice' && Array.isArray(field.choices)) mapped.choices = field.choices.slice(0, 12).map(mapChoice)
    if (typeof field.multi === 'boolean') mapped.multi = field.multi
    if (typeof field.multiline === 'boolean') mapped.multiline = field.multiline
    if (typeof field.placeholder === 'string' && field.placeholder) mapped.placeholder = clip(field.placeholder, 200)
    if (typeof field.command === 'string' && field.command) mapped.command = clip(field.command, 1000)
    if (typeof field.url === 'string' && field.url) mapped.url = clip(field.url, 2000)
    if (typeof field.must_decide === 'boolean') mapped.must_decide = field.must_decide
    if (field.recommend && typeof field.recommend === 'object') {
      mapped.recommend = {
        value: field.recommend.value,
        why: typeof field.recommend.why === 'string' ? clip(field.recommend.why, 200) : '',
      }
    }
    fields.push(mapped)
  }
  if (!fields.length) return [{ name: 'verdict', type: 'choice', label: 'Approve?', choices: ['approve', 'reject'] }]
  return fields
}

function mapSteps(ask) {
  const steps = []
  for (const step of ask.steps || []) {
    if (steps.length >= 20) break
    if (typeof step === 'string' && step) steps.push(clip(step, 2000))
  }
  for (const line of ask.tried || []) {
    if (steps.length >= 20) break
    if (typeof line === 'string' && line) steps.push(clip(`Tried: ${line}`, 2000))
  }
  return steps
}

function mapLinks(ask, publicOrigin) {
  const links = []
  const room = publicOrigin ? 19 : 20
  for (const link of ask.links || []) {
    if (links.length >= room) break
    if (!link?.url) continue
    links.push({ label: clip(link.label || link.url, 120), url: clip(link.url, 2000) })
  }
  if (publicOrigin) links.push({ label: 'Open on Studio', url: `${String(publicOrigin).replace(/\/+$/, '')}/` })
  return links.slice(0, 20)
}

function mapFrom(ask, host) {
  const from = {}
  if (typeof ask.origin?.agent === 'string' && ask.origin.agent) from.agent = clip(ask.origin.agent, 40)
  if (typeof ask.origin?.pane_id === 'string' && ask.origin.pane_id) from.pane = ask.origin.pane_id
  if (typeof host === 'string' && host) from.host = host
  if (typeof ask.origin?.lane === 'string' && ask.origin.lane) from.lane = ask.origin.lane
  return from
}

function mapFile(ask, host, publicOrigin) {
  const args = {
    request_id: ask.ticket,
    purpose: mapPurpose(ask),
    title: clip(ask.title || '', 90),
    why: mapWhy(ask),
    fields: mapFields(ask),
  }
  if (typeof ask.project === 'string' && ask.project) args.project = clip(ask.project, 120)
  const steps = mapSteps(ask)
  if (steps.length) args.steps = steps
  const links = mapLinks(ask, publicOrigin)
  if (links.length) args.links = links
  if (Number.isFinite(ask.expires_at)) {
    const seconds = Math.ceil((ask.expires_at - Date.now()) / 1000)
    args.ttl_seconds = Math.min(TTL_MAX, Math.max(1, seconds))
  }
  const from = mapFrom(ask, host)
  if (Object.keys(from).length) args.from = from
  return args
}

function quarantineState(statePath) {
  try {
    renameSync(statePath, join(dirname(statePath), `rails-sync.json.corrupt-${process.pid}`))
  } catch { /* start empty either way */ }
}

function loadState(statePath, log) {
  let text
  try {
    text = readFileSync(statePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    quarantineState(statePath)
    log('rails-sync state unreadable')
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('state')
    return parsed
  } catch {
    quarantineState(statePath)
    log('rails-sync state unreadable')
    return {}
  }
}

function saveState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const tmp = `${statePath}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  renameSync(tmp, statePath)
}

function parseSse(text) {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.startsWith('data:'))
  if (!lines.length) throw new Error('rails event stream had no data')
  return JSON.parse(lines.at(-1).slice(5).trim())
}

function refusal(result) {
  const code = result._meta?.['so.rails/refusal']?.code || result.structuredContent?.code
  const error = new Error(code ? String(code) : 'rails refusal')
  error.refusal = true
  if (code) error.code = code
  return error
}

export function createRailsSync({ daemonOrigin, daemonToken, hostedUrl, accessToken, statePath, host, syncToken = loadOrCreateRailsSyncSecret(), log = defaultLog }) {
  assertHostedUrl(hostedUrl)
  const origin = String(daemonOrigin).replace(/\/+$/, '')
  let sessionId = null
  let sessionReady = false
  let token = null
  let nextId = 0

  async function bearer(refresh) {
    if (refresh || token == null) token = await accessToken(refresh ? { refresh: true } : {})
    return token
  }

  async function post(method, params, notify) {
    const headers = {
      Authorization: `Bearer ${await bearer(false)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
    }
    if (method !== 'initialize' && sessionId) headers['Mcp-Session-Id'] = sessionId
    const payload = { jsonrpc: '2.0', method }
    if (!notify) payload.id = ++nextId
    if (params !== undefined) payload.params = params
    const response = await fetch(hostedUrl, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const text = await response.text()
    return { response, text }
  }

  async function call(method, params, { notify = false, recover = true, auth = true } = {}) {
    const { response, text } = await post(method, params, notify)
    if (response.status === 401 && auth) {
      token = await accessToken({ refresh: true })
      return call(method, params, { notify, recover, auth: false })
    }
    if (response.status === 404 && recover && method !== 'initialize') {
      await openSession()
      return call(method, params, { notify, recover: false, auth })
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`rails ${method} failed (${response.status})`)
      error.status = response.status
      throw error
    }
    if (method === 'initialize') {
      const id = response.headers.get('mcp-session-id')
      if (id) sessionId = id
    }
    if (!text.trim()) return null
    const type = (response.headers.get('content-type') || '').toLowerCase()
    const message = type.includes('text/event-stream') ? parseSse(text) : JSON.parse(text)
    if (message?.error) throw new Error(message.error.message || `rails ${method} failed`)
    return message
  }

  async function openSession() {
    sessionId = null
    sessionReady = false
    await call('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'unblock-rails-sync', version: '1' },
    }, { recover: false })
    await call('notifications/initialized', undefined, { notify: true, recover: false })
    sessionReady = true
  }

  async function tool(name, args) {
    if (!sessionReady) await openSession()
    const message = await call('tools/call', { name, arguments: args })
    const result = message?.result
    if (!result) throw new Error(`rails ${name} returned no result`)
    if (result.isError) throw refusal(result)
    const text = result.structuredContent?.blocks?.[0]?.text
    if (typeof text !== 'string') throw new Error(`rails ${name} returned no data`)
    return JSON.parse(text)
  }

  function failLine(error) {
    return String(error?.code || error?.message || 'failed').split('\n')[0].slice(0, 180)
  }

  async function daemonRequest(method, path, body, { sync = false } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${daemonToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(sync ? { 'x-unblock-rails-sync': syncToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    let json = null
    if (text) {
      try { json = JSON.parse(text) } catch { json = null }
    }
    return { status: response.status, json }
  }

  async function daemon(method, path, body) {
    const result = await daemonRequest(method, path, body)
    if (result.status < 200 || result.status >= 300) {
      const error = new Error(`daemon ${method} ${path} failed (${result.status})`)
      error.status = result.status
      throw error
    }
    return result.json
  }

  async function applyPending(state, localTicket, entry) {
    let result
    try {
      result = await daemonRequest('POST', `/api/asks/${encodeURIComponent(localTicket)}/answer`, entry.pending_apply, { sync: true })
    } catch {
      log(`apply ${localTicket} failed`)
      return
    }
    if (result.status >= 200 && result.status < 300) {
      delete entry.pending_apply
      entry.status = 'settled'
      saveState(statePath, state)
      return
    }
    // Auth, proof, timeout and rate-limit refusals are about this sidecar, not the answer: keep it and retry.
    if (result.status >= 500 || [401, 403, 408, 429].includes(result.status)) {
      log(`apply ${localTicket} failed ${result.status}`)
      return
    }
    const code = (typeof result.json?.code === 'string' && result.json.code) || String(result.status)
    delete entry.pending_apply
    entry.status = 'settled'
    entry.conflict = code
    saveState(statePath, state)
    log(`conflict ${localTicket} ${code}`)
  }

  async function once() {
    const listed = await daemon('GET', '/api/asks?includeClosed=true')
    const health = await daemon('GET', '/api/health')
    const publicOrigin = health?.public_origin || null
    const asks = Array.isArray(listed?.asks) ? listed.asks : []
    const byTicket = new Map(asks.map((ask) => [ask.ticket, ask]))
    const state = loadState(statePath, log)

    for (const ask of asks) {
      if (ask.status !== 'open' || !mirrorable(ask)) continue
      const entry = state[ask.ticket]
      const retry = entry?.status === 'skipped' && entry.revision !== ask.revision
      if (entry && !retry) continue
      try {
        const filed = await tool('ask.file', mapFile(ask, host, publicOrigin))
        if (!filed?.ticket) throw new Error('rails ask.file returned no ticket')
        state[ask.ticket] = { hosted: filed.ticket, revision: ask.revision, status: 'open' }
      } catch (error) {
        if (error.status === 401) throw error
        if (!error.refusal) {
          log(`file ${ask.ticket} ${failLine(error)}`)
          continue
        }
        const code = error.code || 'refused'
        state[ask.ticket] = { revision: ask.revision, status: 'skipped', code }
        log(`skipped ${code}`)
      }
      saveState(statePath, state)
    }

    for (const ask of asks) {
      const entry = state[ask.ticket]
      if (ask.status !== 'open' || entry?.status !== 'open' || !entry.hosted) continue
      if (!(ask.revision > entry.revision)) continue
      try {
        await tool('ask.update', { ticket: entry.hosted, why: mapWhy(ask), replace_fields: mapFields(ask) })
        entry.revision = ask.revision
        saveState(statePath, state)
      } catch (error) {
        if (error.status === 401) throw error
        if (!(error.refusal && error.code === 'invalid_state')) log(`update ${ask.ticket} ${failLine(error)}`)
      }
    }

    for (const [ticket, entry] of Object.entries(state)) {
      if (!entry?.pending_apply) continue
      try {
        await applyPending(state, ticket, entry)
      } catch (error) {
        if (error.status === 401) throw error
        log(`apply ${ticket} ${failLine(error)}`)
      }
    }

    const hostedToLocal = new Map()
    for (const [ticket, entry] of Object.entries(state)) {
      if (entry?.hosted) hostedToLocal.set(entry.hosted, ticket)
    }
    const pending = new Map()
    try {
      for (const status of ['answered', 'sent_back']) {
        const page = await tool('queue.list', { status })
        for (const item of page?.asks || []) {
          if (item?.ticket && hostedToLocal.has(item.ticket) && !pending.has(item.ticket)) pending.set(item.ticket, status)
        }
      }
    } catch (error) {
      if (error.status === 401) throw error
      log(`queue.list ${failLine(error)}`)
    }
    for (const [hostedTicket, listedStatus] of pending) {
      const localTicket = hostedToLocal.get(hostedTicket)
      const entry = state[localTicket]
      if (!entry || entry.pending_apply || entry.status === 'settled') continue
      try {
        const checked = await tool('ask.check', { ticket: hostedTicket })
        const remote = checked?.asks?.[0]
        if (!remote) {
          log(`check ${localTicket} empty`)
          continue
        }
        const kind = remote.status === 'sent_back' || remote.status === 'answered' ? remote.status : listedStatus
        if (kind !== 'answered' && kind !== 'sent_back') continue
        const local = byTicket.get(localTicket)
        const revision = local?.revision ?? entry.revision
        entry.pending_apply = kind === 'sent_back'
          ? { bounce: true, reply: remote.reply, revision, via: 'rails' }
          : { values: remote.answers ?? {}, reply: remote.reply, revision, via: 'rails' }
        saveState(statePath, state)
        await applyPending(state, localTicket, entry)
      } catch (error) {
        if (error.status === 401) throw error
        log(`apply ${localTicket} ${failLine(error)}`)
      }
    }

    for (const [ticket, entry] of Object.entries(state)) {
      if (entry?.status !== 'open' || !entry.hosted) continue
      const local = byTicket.get(ticket)
      if (local?.status === 'open') continue
      try {
        await tool('ask.cancel', { ticket: entry.hosted, reason: `Closed on Studio (${local?.status || 'missing'})` })
      } catch (error) {
        if (error.status === 401) throw error
        if (!(error.refusal && error.code === 'invalid_state')) {
          log(`cancel ${ticket} ${failLine(error)}`)
          continue
        }
      }
      entry.status = 'closed'
      saveState(statePath, state)
    }
  }

  return { once }
}
