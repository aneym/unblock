/** Hot event path: pane.agent_status_changed and pane.exited.
 *  Two jobs — notify on a new gating ask, and file a second-tier entry for an
 *  agent herdr detected as blocked that never declared one. Exits fast. */
import { readFileSync } from 'node:fs'
import { api } from './paths.js'
import { paneOrigin, notify } from './herdr.js'

const event = readEvent()
const paneId = event?.pane_id ?? event?.pane?.pane_id ?? process.env.HERDR_PANE_ID
if (!paneId) process.exit(0)

const status = event?.agent_status ?? event?.pane?.agent_status
const kind = event?.type ?? event?.event ?? ''

try {
  if (kind.includes('exited')) {
    // The agent is gone. Keep its answers — a later agent can claim them by
    // ticket — but stop showing asks nobody will ever collect as live.
    const { asks } = await api('/api/asks?profile=*')
    for (const ask of asks.filter((a) => a.origin?.pane_id === String(paneId))) {
      await api(`/api/asks/${ask.ticket}/cancel`, { note: 'pane exited' }).catch(() => {})
    }
    process.exit(0)
  }

  if (status !== 'blocked') process.exit(0)

  const { asks } = await api('/api/asks?profile=*')
  const mine = asks.filter((a) => a.origin?.pane_id === String(paneId) && a.status === 'open')

  if (mine.some((a) => a.gating)) {
    // It declared an ask. That is the good path — just make sure it is seen.
    const gating = mine.find((a) => a.gating)
    await notify('unblock', gating.title)
    process.exit(0)
  }
  if (mine.length > 0) process.exit(0) // already has something filed; do not pile on

  const origin = await paneOrigin(String(paneId))
  const where = origin.workspace_name ? `in ${origin.workspace_name}` : `in pane ${paneId}`
  const agent = event?.agent ?? origin.agent ?? 'An agent'
  await api('/api/asks', {
    ask: {
      kind: 'file',
      title: `${agent} is waiting ${where}`,
      why:
        'Detected by herdr, not declared by the agent, so there is no structured ask to read. ' +
        'Open the pane to see what it wants.',
      fields: [{ name: 'acknowledged', type: 'confirm', label: 'Handled', help: 'Dealt with' }],
      ttl_seconds: 60 * 60 * 12,
    },
    origin: { ...origin, agent, detected: true },
  })
} catch {
  // Never let a hook failure disturb the session.
}
process.exit(0)

function readEvent() {
  for (const source of [stdinJson(), process.env.HERDR_PLUGIN_CONTEXT_JSON]) {
    if (!source) continue
    try {
      return typeof source === 'string' ? JSON.parse(source) : source
    } catch {
      /* try the next one */
    }
  }
  return null
}

function stdinJson() {
  try {
    const text = readFileSync(0, 'utf8').trim()
    return text || null
  } catch {
    return null
  }
}
