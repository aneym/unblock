#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { openSync, closeSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { entryPath, log, readEntry, registryDir, remove, request } from './lib.js'

const ticket = process.argv[2]
if (!/^ub_[a-z0-9]+$/.test(ticket || '') || !readEntry(ticket)) process.exit(0)
const bin = process.env.HERDR_BIN_PATH || 'herdr'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function herdr(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill(), 5000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', () => {}) // Do not log CLI output; it may contain secrets.
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error('herdr command failed'))
    })
  })
}

async function collect() {
  await request(`/api/asks/${ticket}/collect`, {})
  remove(ticket)
}

function lockPane(pane) {
  const path = join(registryDir(), `lock-${pane.replace(/[^a-z0-9_-]/gi, '_')}`)
  try {
    const fd = openSync(path, 'wx', 0o600)
    return () => { closeSync(fd); try { unlinkSync(path) } catch {} }
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > 60000) {
        unlinkSync(path)
        return lockPane(pane)
      }
    } catch {}
    return null
  }
}

function answerLine(ask) {
  if (ask.status === 'bounced') return `[unblock ${ticket}] Alex sent your question back: ${ask.reply || 'no note'}. Ask again better, or decide yourself if you can.`
  const values = ask.fields.map((field) => {
    const value = ask.answers?.[field.name]
    return `${field.label} -> ${Array.isArray(value) ? value.join(', ') : String(value ?? '')}`
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
  const value = ask.answers?.decision
  if (ask.status === 'bounced' || !['allow_once', 'deny'].includes(value) || typeof value !== 'string') {
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
    await herdr(['pane', 'send-keys', entry.pane_id, value === 'allow_once' ? 'enter' : 'esc'])
    // Once a key was sent, never retry the key if the follow-up or collect fails.
    try {
      if (value === 'deny') {
        await sleep(1500)
        await herdr(['agent', 'prompt', entry.pane_id, `[unblock ${ticket}] Alex denied that step${ask.reply ? `: ${ask.reply}` : ''}. Find another way or ask.`])
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
