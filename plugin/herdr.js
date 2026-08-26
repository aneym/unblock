/**
 * Herdr socket client.
 *
 * One request per connection; the server closes after replying. The exception
 * is events.subscribe, which streams.
 *
 * Two methods this plugin leans on are FORK features on the author's build
 * (profile.switch / profile.list). Everything here degrades when they are
 * missing, so the plugin still works on a stock herdr — you just lose the
 * profile filter and see every ask.
 */

import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'

const SOCKET = process.env.HERDR_SOCKET_PATH

export class HerdrUnavailable extends Error {}

export function call(method, params = {}, { timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new HerdrUnavailable('HERDR_SOCKET_PATH is not set'))
    const socket = connect(SOCKET)
    let buf = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`herdr ${method} timed out`))
    }, timeout)

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params })}\n`)
    })
    socket.on('data', (d) => (buf += d))
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(new HerdrUnavailable(err.message))
    })
    socket.on('close', () => {
      clearTimeout(timer)
      const line = buf.split('\n').find((l) => l.trim())
      if (!line) return reject(new Error(`herdr ${method} returned nothing`))
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return reject(new Error(`herdr ${method} returned malformed JSON`))
      }
      if (msg.error) {
        const err = new Error(msg.error.message || `herdr ${method} failed`)
        err.code = msg.error.code
        return reject(err)
      }
      resolve(msg.result)
    })
  })
}

/**
 * The active profile, or undefined on a stock build without the fork's profile
 * methods — in which case the queue shows everything rather than nothing.
 *
 * Verified shape: {"type":"profile_list","active":"next","profiles":["personal","next"]}
 * Note this is the in-app profile, NOT the named herdr session. A session is a
 * separate server; a profile is a tag filter inside one.
 */
export async function activeProfile() {
  try {
    const res = await call('profile.list')
    if (typeof res?.active === 'string') return res.active
    // Tolerate an object-shaped list, in case the fork's response changes.
    const list = Array.isArray(res?.profiles) ? res.profiles : []
    const active = list.find((p) => p && typeof p === 'object' && (p.active || p.focused))
    return active?.name ?? undefined
  } catch {
    return undefined
  }
}

/** All known profile names, for the scope cycler. */
export async function listProfiles() {
  try {
    const res = await call('profile.list')
    const list = Array.isArray(res?.profiles) ? res.profiles : []
    return list.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Everything the queue needs to label and filter an ask: which workspace a pane
 * lives in, and the profile tags that apply to it. A pane's own tags override
 * its workspace's, matching herdr's sidebar behaviour.
 */
export async function paneOrigin(paneId) {
  const origin = { pane_id: paneId }
  try {
    const panes = (await call('pane.list'))?.panes ?? []
    const pane = panes.find((p) => p.pane_id === paneId)
    if (!pane) return origin
    origin.tab_id = pane.tab_id
    origin.workspace_id = pane.workspace_id
    origin.cwd = pane.foreground_cwd || pane.cwd
    const paneProfiles = pane.profiles ?? []

    const workspaces = (await call('workspace.list'))?.workspaces ?? []
    const ws = workspaces.find((w) => w.workspace_id === pane.workspace_id || w.id === pane.workspace_id)
    if (ws) {
      origin.workspace_name = ws.label ?? ws.name ?? ws.custom_name
      origin.profiles = paneProfiles.length ? paneProfiles : (ws.profiles ?? [])
    } else {
      origin.profiles = paneProfiles
    }
  } catch {
    // A stock build, or herdr is down. The ask still lands, just less labelled.
  }
  return origin
}

/** Every agent herdr currently considers Blocked — the second tier of the queue. */
export async function blockedAgents() {
  try {
    const res = await call('agent.list')
    return (res?.agents ?? []).filter((a) => a.agent_status === 'blocked')
  } catch {
    return []
  }
}

/** Wake a parked agent by typing the answer into its pane. */
export function wake(target, text) {
  return call('agent.prompt', { target, text }, { timeout: 15000 })
}

export function notify(title, body, { sound = 'request' } = {}) {
  return call('notification.show', { title, body, sound }).catch(() => {})
}

export function openQueuePane() {
  return call('plugin.pane.open', { plugin_id: 'unblock', entrypoint: 'queue' })
}
