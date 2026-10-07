/** The question watcher and daemon both deliver through the same pane transport. */
import { spawn } from 'node:child_process'
import { openSync, closeSync, statSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { validScopeHost } from './scope-doc.js'

export function promptPane(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.HERDR_BIN_PATH || 'herdr', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill(), 5000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', () => {}) // May include secrets; never log it.
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error('herdr command failed'))
    })
  })
}

/** Share the permission watcher's per-pane lock and prompt re-check. */
export function lockPane(pane) {
  const state = process.env.UNBLOCK_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')
  const directory = join(state, 'pane-asks')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `lock-${pane.replace(/[^a-z0-9_-]/gi, '_')}`)
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

/** Only send when the pane exists and is not showing a permission prompt. */
export async function guardedAnswerNotice(pane, ticket) {
  const unlock = lockPane(pane)
  if (!unlock) return 'busy'
  try {
    let details
    try {
      details = JSON.parse(await promptPane(['pane', 'get', pane]))
    } catch {
      // A disconnected herdr server is not proof that the pane is gone.
      return 'busy'
    }
    if (!details.result?.pane) return 'missing'
    // Busy or blocked panes may display permission controls; never prompt them.
    if (details.result.pane.agent_status !== 'idle') return 'busy'
    let visible
    try {
      visible = await promptPane(['pane', 'read', pane, '--source', 'visible'])
    } catch {
      return 'busy'
    }
    if (visible.includes('Do you want to')) return 'busy'
    try {
      await promptPane(['agent', 'prompt', pane, `[unblock ${ticket}] Your answer is ready. Call unblock_check to collect it.`])
      return 'sent'
    } catch {
      return 'busy'
    }
  } finally { unlock() }
}

/** Return a stale open ask to its filing lane through hook delivery. */
export async function recheckNotice(ask, afterMs = 30 * 60 * 1000) {
  const age = afterMs < 3600000 ? `${Math.max(1, Math.round(afterMs / 60000))} min` : `${Math.round(afterMs / 3600000)} h`
  const text = `[unblock ${ask.ticket}] "${ask.title}" has waited ${age} for Alex. If it is still needed, run: unblock keep ${ask.ticket}. If it is handled or moot, close it with unblock_cancel (or: unblock close ${ask.ticket} <reason>). If his past answers settle it, quote his answer and its date in the note.`
  return postNotice(ask.origin.pane_id, 'unblock-recheck', text)
}

export async function originFinishedNotice(ask) {
  const answers = ask.fields.filter((field) => Object.hasOwn(ask.answers, field.name)).map((field) =>
    field.type === 'secret' ? `${field.label}: (secret; collect with unblock_check ${ask.ticket})` : `${field.label}: ${typeof ask.answers[field.name] === 'string' ? ask.answers[field.name] : JSON.stringify(ask.answers[field.name])}`)
  const text = `[unblock ${ask.ticket}] Alex answered "${ask.title}" after the lane that filed it finished (origin finished; act or drop): ${answers.join('; ')}`.slice(0, 700)
  return postNotice(ask.origin.pane_id, 'unblock-origin-finished', text)
}

function postNotice(pane, topic, text) {
  return new Promise((resolve) => {
    const child = spawn(process.env.UNBLOCK_LANE_POST_BIN || 'lane-post',
      ['post', '--to', pane, '--from', 'unblock', '--kind', 'task',
        '--topic', topic, '--wake', 'auto', text],
      { stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('failed')
    }, 5000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve('failed')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? 'sent' : 'failed')
    })
  })
}

export function remoteScopeHost(host) {
  if (!validScopeHost(host)) throw new Error('invalid scope host')
  return host !== undefined && !['localhost', hostname(), hostname().split('.')[0]].includes(host)
}

/** SSH runs a shell remotely, so quote every argument rather than joining raw text. */
export function scopePostCommand(bin, args, host) {
  if (!remoteScopeHost(host)) return { bin, args }
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
  const bulletinHome = process.env.UNBLOCK_REMOTE_BULLETIN_HOME
  const prefix = bulletinHome ? `env LANE_BULLETIN_HOME=${quote(bulletinHome)} ` : ''
  return { bin: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, prefix + '"$HOME/.local/bin/lane-post" ' + args.map(quote).join(' ')] }
}
