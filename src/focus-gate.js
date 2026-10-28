/**
 * Alex, 2026-10-09 ~15:30 ET: "i dont need to see unblocks for things we didnt say were our
 * focus that day." Every filed ask passes this gate: outside today's focus it is held by the
 * command in UNBLOCK_HELD_ASKS (agent-rails scripts/held_asks.py) and surfaces when Alex makes
 * that work focus. A stated emergency (production down or broken, a security incident) and the
 * held-ask surfacer itself pass, as do permission prompts and herdr-detected waits. With no command configured the
 * ask is filed; if the command fails the ask is filed to Alex's queue, so a broken gate never hides a live ask.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

async function emptyFocus() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  try {
    const data = JSON.parse(await readFile(join(homedir(), '.agent-rails', 'focus', `${day}.json`), 'utf8'))
    return Array.isArray(data.items) && !data.items.some(item => String(item.owner ?? '').trim())
  } catch (error) {
    return error.code === 'ENOENT'
  }
}
import { laneClosed, laneForAsk } from './lane-state.js'

const GENERIC = new Set(['claude', 'cli', 'codex', 'unknown', 'agent'])

/** Names an ask can match today's focus by: project, lane, agent, pane (held_asks.ask_keys). */
export function askKeys(ask, origin = {}) {
  const values = [ask?.project, origin.owner, origin.agent, origin.lane_name, origin.pane_id]
  const keys = values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim().toLowerCase())
  return [...new Set(keys.filter((key) => !GENERIC.has(key)))]
}

export function emergencyReason(value) {
  return typeof value === 'string' && value.trim().length >= 12 ? value.trim() : null
}

export function emergencyAccepted(body, ask) {
  return Boolean(emergencyReason(body?.emergency)) && ask?.level === 'P0'
}

function run(command, args, input, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const [file, ...rest] = command.split(/\s+/)
    const child = execFile(file, [...rest, ...args], { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr.trim().split('\n').pop() || error.message.trim())))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('held asks gave no JSON')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/**
 * Decide one filing. Returns { file: true } to file it, or { held, owner, keys } once held.
 * body: the POST /api/asks body ({ ask, origin, emergency?, focus? }); ask is the validated ask.
 */
export async function focusGate(body, ask, origin, env = process.env, log = console.error) {
  const command = (env.UNBLOCK_HELD_ASKS || '').trim()
  if (!command || body?.focus === 'surface' || emergencyAccepted(body, ask)) return { file: true }
  // A permission prompt or a pane herdr saw waiting holds a live session; those reach Alex as before.
  if (ask.purpose === 'permission' || body?.origin?.detected === true) return { file: true }
  const keys = askKeys(ask, origin)
  const exempt = (env.UNBLOCK_FOCUS_EXEMPT ?? '').split(',').map((key) => key.trim().toLowerCase()).filter(Boolean)
  if (keys.some((key) => exempt.includes(key)) || (ask.kind === 'file' && await emptyFocus())) return { file: true }
  try {
    const focus = await run(command, ['in-focus', ...keys])
    if (focus.in_focus || (ask.kind === 'file' && Array.isArray(focus.focus) && !focus.focus.length)) return { file: true }
    const owner = keys[0] ?? 'unknown'
    const held = await run(command, ['hold'], JSON.stringify({
      owner, keys, kind: ask.purpose, title: ask.title, tried: ask.tried ?? [],
      reason: "not in today's focus", ask: { ...body.ask }, origin,
    }))
    return { held: held.id, owner, keys }
  } catch (error) {
    log(`unblock: focus gate unavailable, filing to Alex: ${error.message}`)
    return { file: true }
  }
}

const HELD_COUNT_TTL_MS = 60_000
const HELD_COUNT_RETRY_MS = 5_000
const HELD_COUNT_WAIT_MS = 1_500
const heldCounts = new Map()

async function heldCount(command) {
  let entry = heldCounts.get(command)
  if (!entry) heldCounts.set(command, entry = { value: null, due: 0, pending: null })
  if (!entry.pending && Date.now() >= entry.due) {
    entry.pending = run(command, ['list'], '', 120_000).then(
      rows => {
        if (Array.isArray(rows)) { entry.value = rows.length; entry.due = Date.now() + HELD_COUNT_TTL_MS } else entry.due = Date.now() + HELD_COUNT_RETRY_MS
      },
      () => { entry.due = Date.now() + HELD_COUNT_RETRY_MS },
    ).finally(() => { entry.pending = null })
  }
  if (entry.pending) {
    let timer
    await Promise.race([entry.pending, new Promise(resolve => { timer = setTimeout(resolve, HELD_COUNT_WAIT_MS) })])
    clearTimeout(timer)
  }
  return entry.value
}

export async function alexView(store, env = process.env, deadReference = async () => null) {
  const hidden = { not_focus: 0, aside: 0, held: 0, lane_closed: 0 }
  const dropped = () => store.list({ profile: '*', status: ['open'], includeAside: true })
    .filter(ask => ask.set_aside_at != null && /^(lane_closed:|settled:|duplicate_of:)/.test(ask.set_aside_reason ?? ''))
    .map(ask => ({ ticket: ask.ticket, title: ask.title, dropped_reason: ask.set_aside_reason }))
  try {
    const remaining = []
    for (const ask of store.list({ profile: '*', status: ['open'], includeAside: true })) {
      if (ask.set_aside_at != null) continue
      const lane = laneForAsk(ask)
      let reason = lane && laneClosed(lane) ? `lane_closed:${lane}` : null
      if (reason && store.freshnessExempt(ask, reason)) reason = null
      if (!reason) {
        const settled = await deadReference(ask)
        if (settled) reason = `settled:${settled}`
      }
      if (reason) store.dropFresh(ask.ticket, reason)
      if (store.get(ask.ticket).set_aside_at == null) remaining.push(ask)
    }
    const groups = new Map()
    for (const ask of remaining.sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))) {
      const title = ask.title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
      const key = JSON.stringify([ask.purpose, ask.target || title, laneForAsk(ask) || (ask.project ?? '').toLowerCase()])
      const newest = groups.get(key)
      if (newest) store.dropFresh(ask.ticket, `duplicate_of:${newest.ticket}`)
      else groups.set(key, ask)
    }
    const command = (env.UNBLOCK_HELD_ASKS || '').trim()
    let focus = null
    let failure = null
    if (command) {
      try {
        focus = new Set(((await emptyFocus()) ? [] : ((await run(command, ['in-focus'])).focus ?? [])).map(key => String(key).toLowerCase()))
      } catch (error) { failure = `focus gate unavailable, showing every open ask: ${error.message}` }
    }
    if (!focus) {
      const asks = remaining.filter((ask) => store.get(ask.ticket).set_aside_at == null && (ask.weekly_at == null || (ask.kept_at ?? 0) > ask.weekly_at))
      return { asks, hidden, focus: [], dropped: dropped(), ...(failure ? { error: failure } : {}) }
    }
    hidden.held = await heldCount(command)
    const asks = []
    for (const ask of store.list({ profile: '*', status: ['open'], includeAside: true })) {
      if (ask.set_aside_at != null || (ask.weekly_at != null && !((ask.kept_at ?? 0) > ask.weekly_at))) {
        hidden.aside += 1
        if (ask.set_aside_reason?.startsWith('lane_closed:')) hidden.lane_closed += 1
        continue
      }
      const lane = laneForAsk(ask)
      const keys = [...askKeys(ask, ask.origin), ...(lane ? [lane.toLowerCase()] : [])]
      if (ask.level === 'P0' || !focus.size || keys.some((key) => focus.has(key))) asks.push(ask)
      else hidden.not_focus += 1
    }
    return { asks, hidden, focus: [...focus], dropped: dropped() }
  } catch (error) {
    return { asks: [], hidden, focus: [], dropped: dropped(), error: `alex view unavailable: ${error.message}` }
  }
}
