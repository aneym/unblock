#!/usr/bin/env node
import { log, permissionVerdict, readEntry, remove, request } from './lib.js'
import { promptPane as herdr, lockPane } from '../src/pane-notice.js'

const ticket = process.argv[2]
if (!/^ub_[a-z0-9]+$/.test(ticket || '') || !readEntry(ticket)) process.exit(0)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function collect() {
  await request(`/api/asks/${ticket}/collect`, {})
  remove(ticket)
}

function answerLine(ask) {
  if (ask.status === 'bounced') return `[unblock ${ticket}] Alex sent your question back: ${ask.reply || 'no note'}. Ask again better, or decide yourself if you can.`
  const values = ask.fields.map((field) => {
    const value = ask.answers?.[field.name]
    // A per-field send-back is {$bounce: note|true, value?}, not a plain value.
    if (value && typeof value === 'object' && !Array.isArray(value) && '$bounce' in value) {
      const note = typeof value.$bounce === 'string' ? value.$bounce : 'no note'
      return `${field.label} -> sent back (${note})${value.value !== undefined ? `, leaning ${value.value}` : ''}`
    }
    // null is an explicit skip: the human left it to the agent's recommendation.
    if (value === null) return `${field.label} -> skipped, go with your recommendation${field.recommend ? ` (${field.recommend.value})` : ''}`
    const allowed = field.type === 'choice' ? new Set(field.choices.map((choice) => choice.value)) : null
    const render = (item) => typeof item === 'string' && allowed && !allowed.has(item) ? `in their words: ${item}` : String(item ?? '')
    return `${field.label} -> ${Array.isArray(value) ? value.map(render).join(', ') : render(value)}`
  })
  return `[unblock ${ticket}] Alex answered: ${values.join(' | ')}${ask.reply ? ` | Note: ${ask.reply}` : ''}`
}

async function deliverQuestion(ask, pane) {
  const deadline = Date.now() + 30 * 60 * 1000
  do {
    try {
      await herdr(['agent', 'prompt', pane, answerLine(ask)])
      await collect()
      return true
    } catch {
      if (Date.now() >= deadline) { log('question delivery failed for 30 minutes'); return true }
      await sleep(10000)
    }
  } while (true)
}

async function deliverPermission(ask, entry) {
  if (ask.status === 'bounced') {
    log('permission sent back; nothing sent')
    await collect()
    return true
  }
  const value = permissionVerdict(ask)
  if (!value) {
    log('permission answer is not a valid decision; no keys sent')
    await collect()
    return true
  }
  const unlock = lockPane(entry.pane_id)
  if (!unlock) return false
  try {
    // Recheck the current prompt under the per-pane lock before any keystroke.
    let blocked = false
    let visible = ''
    try {
      const get = JSON.parse(await herdr(['pane', 'get', entry.pane_id]))
      blocked = get.result?.pane?.agent_status === 'blocked'
      if (blocked) visible = await herdr(['pane', 'read', entry.pane_id, '--source', 'visible'])
    } catch { /* Missing pane or unreadable prompt must never receive keys. */ }
    const collapsed = visible.replace(/\s+/g, ' ')
    const marker = visible.includes('Do you want to')
    const fingerprint = entry.fingerprint && collapsed.includes(entry.fingerprint)
    const yes = /❯\s*1\.\s*Yes/.test(visible)
    if (!blocked || !marker || (value === 'allow_once' && (!fingerprint || !yes))) {
      log('prompt gone or changed; nothing sent')
      await collect()
      return true
    }
    if (value === 'deny' && !fingerprint) {
      log('prompt gone or changed; nothing sent')
      await collect()
      return true
    }
    // One shot: drop the registry entry before the key, so neither this loop
    // nor a second watcher can ever press it again, even if send-keys errors
    // after the key already landed.
    remove(ticket)
    try {
      await herdr(['pane', 'send-keys', entry.pane_id, value === 'allow_once' ? 'enter' : 'esc'])
    } catch {
      log('permission key send reported failure; not retried')
      await request(`/api/asks/${ticket}/collect`, {}).catch(() => {})
      return true
    }
    // Once a key was sent, never retry the key if the follow-up or collect fails.
    try {
      if (value === 'deny') {
        await sleep(1500)
        const note = typeof ask.answers?.note === 'string' && ask.answers.note.trim() ? ask.answers.note.trim() : ask.reply
        await herdr(['agent', 'prompt', entry.pane_id, `[unblock ${ticket}] Alex denied that step${note ? `: ${note}` : ''}. Find another way or ask.`])
      }
      await collect()
    } catch {
      log('permission key sent but follow-up failed; no retry')
      remove(ticket)
    }
    return true
  } finally { unlock() }
}

const initial = readEntry(ticket)
const deadline = Date.parse(initial.created_at) + (initial.type === 'question' ? 86400000 : 3600000)
let missing = 0
while (Date.now() < deadline) {
  const entry = readEntry(ticket)
  if (!entry) break
  try {
    const ask = await request(`/api/asks/${ticket}`)
    if (['cancelled', 'expired', 'orphaned', 'collected'].includes(ask.status)) { remove(ticket); break }
    try {
      await herdr(['pane', 'get', entry.pane_id])
      missing = 0
    } catch {
      if (++missing >= 2) break
      await sleep(3000)
      continue
    }
    if (ask.status === 'answered' || ask.status === 'bounced') {
      if (entry.type === 'question') {
        await deliverQuestion(ask, entry.pane_id)
        break
      }
      if (entry.type === 'permission' && await deliverPermission(ask, entry)) break
    }
  } catch (error) {
    if (error.status === 404) { remove(ticket); break }
    log('pane watcher poll failed')
  }
  await sleep(3000)
}
