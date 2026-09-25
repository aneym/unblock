/** Hot event path: notify on declared asks, or file a second-tier entry for an
 * agent herdr detected as blocked without declaring one. Never block herdr. */
import { readFileSync } from 'node:fs'
import { api } from './paths.js'
import { paneOrigin, notify } from './herdr.js'
import { entries, plainify, register, remove, request } from '../hooks/lib.js'
import { validateAsk } from '../src/schema.js'

const event = readEvent()
const paneId = event?.pane_id ?? event?.pane?.pane_id ?? process.env.HERDR_PANE_ID
if (!paneId) process.exit(0)

const status = event?.agent_status ?? event?.pane?.agent_status
const kind = event?.type ?? event?.event ?? ''

try {
  if (kind.includes('exited')) {
    // Leave answers claimable, but stop showing asks for a pane that is gone.
    const { asks } = await api('/api/asks?profile=*')
    for (const ask of asks.filter((a) => a.origin?.pane_id === String(paneId))) {
      await api(`/api/asks/${ask.ticket}/cancel`, { note: 'pane exited' }).catch(() => {})
    }
    for (const entry of entries(String(paneId))) remove(entry.ticket)
    process.exit(0)
  }

  if (status !== 'blocked') {
    for (const entry of entries(String(paneId)).filter((e) => ['permission', 'detected'].includes(e.type))) {
      // Hook filing precedes herdr's blocked event; do not race that update.
      if (Date.now() - Date.parse(entry.created_at) < 10000) continue
      try {
        const ask = await request(`/api/asks/${entry.ticket}`)
        if (ask.status === 'open') await request(`/api/asks/${entry.ticket}/cancel`, { note: 'the agent is no longer waiting' })
      } catch { /* missing ask or daemon */ }
      remove(entry.ticket)
    }
    process.exit(0)
  }

  const { asks } = await api('/api/asks?profile=*')
  const mine = asks.filter((a) => a.origin?.pane_id === String(paneId) && a.status === 'open')

  if (mine.some((a) => a.gating)) {
    const gating = mine.find((a) => a.gating)
    await notify('unblock', gating.title)
    process.exit(0)
  }
  if (mine.length > 0) process.exit(0)
  // A hook may just have filed its entry before the queue listing updated.
  for (const entry of entries(String(paneId))) {
    const ask = await request(`/api/asks/${entry.ticket}`).catch(() => null)
    if (ask?.status === 'open') process.exit(0)
  }

  const origin = await paneOrigin(String(paneId))
  const workspace = origin.workspace_name || `pane ${paneId}`
  const agent = event?.agent ?? origin.agent ?? 'An agent'
  const ask = {
    kind: 'file', purpose: 'decision', only_you: 'judgment', project: origin.workspace_name || 'herdr',
    title: plainify(`${agent} is waiting in ${workspace}`).slice(0, 90),
    why: 'Detected by herdr, not declared by the agent, so there is no structured ask to read. Open the pane from the link on this card.',
    tried: ['Herdr saw this agent stop and wait without filing a question, so there is nothing structured to show here.'],
    fields: [{ name: 'handled', type: 'confirm', label: 'Handled in the pane', recommend: { value: true, why: 'Mark it once you have dealt with it in the pane.' } }],
    ttl_seconds: 60 * 60 * 12,
  }
  validateAsk(ask)
  const filed = await api('/api/asks', { ask, origin: { ...origin, agent, detected: true } })
  register(filed.ticket, String(paneId), 'detected')
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
