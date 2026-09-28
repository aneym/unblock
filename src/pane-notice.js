/** The question watcher and daemon both deliver through the same pane transport. */
import { spawn } from 'node:child_process'
import { openSync, closeSync, statSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
