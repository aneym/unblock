import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ask, check, main, origin, sandbox, startDaemon } from './e2e-lib.mjs'

await main(async () => {
  const box = sandbox('recheck-live')
  mkdirSync(join(box.lanes, 'live'))
  writeFileSync(join(box.lanes, 'live', 'lane.json'), JSON.stringify({ lane: 'live', t3: { thread_id: 'mcp:test', host: 'studio' } }))
  mkdirSync(join(box.lanes, 'closed'))
  writeFileSync(join(box.lanes, 'closed', 'lane.json'), JSON.stringify({ lane: 'closed', t3: { thread_id: 'mcp:old', host: 'studio' }, closed_at: '2026-10-01T00:00:00Z' }))
  const posts = join(box.root, 'posts.log')
  const stub = join(box.root, 'lane-post')
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${posts}'\ncase "$3" in pane-*) exit 1 ;; esac\nexit 0\n`)
  chmodSync(stub, 0o755)
  const daemon = await startDaemon(box, { UNBLOCK_HELD_ASKS: '', UNBLOCK_LANE_POST_BIN: stub, UNBLOCK_RECHECK_AFTER_MS: '300', UNBLOCK_SWEEP_MS: '300' })
  try {
    const file = async (title, lane, pane) => {
      const filed = await daemon.api('/api/asks', { ask: ask(title, { purpose: 'question', fields: [{ name: 'answer', type: 'text', label: 'Answer' }] }), origin: origin(box, lane, { pane_id: pane }) })
      check(filed.status === 201, `${title} filed (${filed.status} ${JSON.stringify(filed.body?.error ?? '')})`)
      return filed.body.ticket
    }
    const live = await file('Live lane call', 'live', 'pane-live')
    const closed = await file('Closed lane call', 'closed', 'pane-closed')
    const gone = await file('Gone lane call', 'gone', 'pane-gone')
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const get = async (ticket) => (await daemon.api(`/api/asks/${ticket}`)).body
    const liveAsk = await get(live)
    check(liveAsk.set_aside_at == null && liveAsk.rechecked_at != null, `live lane ask stays with Alex and is rechecked (${liveAsk.set_aside_reason})`)
    const log = readFileSync(posts, 'utf8')
    check(log.includes('--to pane-live') && log.includes('--to live '), 'recheck tried the pane, then the lane t3 binding')
    const closedAsk = await get(closed)
    check(closedAsk.set_aside_at != null, `closed lane ask is set aside (${closedAsk.set_aside_reason})`)
    check((await get(gone)).set_aside_reason === 'origin_unreachable', 'ask with no lane.json is set aside')
    const view = JSON.parse((await daemon.cli(['list', '--alex', '--json'])).stdout)
    check(view.asks.some((a) => a.ticket === live), 'live lane ask is in unblock list --alex')
  } finally {
    await daemon.stop()
  }
})
