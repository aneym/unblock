import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ask, check, main, origin, sandbox, setFocus, startDaemon } from './e2e-lib.mjs'

await main(async () => {
  const box = sandbox('kept-asks')
  setFocus(box, ['recruiter'])
  mkdirSync(join(box.lanes, 'recruiter'))
  writeFileSync(join(box.lanes, 'recruiter', 'lane.json'), JSON.stringify({ closed_at: '2026-10-01T00:00:00Z' }))
  const daemon = await startDaemon(box)
  try {
    const filed = await daemon.api('/api/asks', { ask: ask('Closed-lane sign-in'), origin: origin(box, 'recruiter'), focus: 'surface' })
    check(filed.status === 201, `ask filed for a closed lane (${filed.status})`)
    const first = JSON.parse((await daemon.cli(['list', '--alex', '--json'])).stdout)
    check(!first.asks.some(a => a.ticket === filed.body.ticket), 'closed-lane ask leaves Alex view')
    const kept = await daemon.cli(['keep', filed.body.ticket])
    check(kept.status === 0, `unblock keep succeeds: ${kept.stdout.trim()}`)
    const plain = JSON.parse((await daemon.cli(['list', '--json'])).stdout)
    check(plain.asks.some(a => a.ticket === filed.body.ticket), 'kept ask shows in plain list')
    const again = JSON.parse((await daemon.cli(['list', '--alex', '--json'])).stdout)
    check(again.asks.some(a => a.ticket === filed.body.ticket), 'kept ask stays in Alex view after the closed-lane recheck')
    const sweep = await daemon.cli(['list', '--alex', '--json'])
    check(JSON.parse(sweep.stdout).asks.some(a => a.ticket === filed.body.ticket), 'kept ask survives a second Alex view')

    const weekly = await daemon.api('/api/asks', { ask: ask('Weekly-parked call'), origin: origin(box, 'recruiter') })
    check(weekly.status === 201, 'focus ask filed')
    execFileSync('sqlite3', [join(box.state, 'queue.db'), `UPDATE asks SET weekly_at = ${Date.now() - 1000} WHERE ticket = '${weekly.body.ticket}'`])
    const hiddenList = JSON.parse((await daemon.cli(['list', '--json'])).stdout)
    check(!hiddenList.asks.some(a => a.ticket === weekly.body.ticket), 'weekly-parked ask is out of plain list')
    const weeklyKeep = await daemon.cli(['keep', weekly.body.ticket])
    check(weeklyKeep.status === 0, 'keep the weekly-parked ask')
    const shown = JSON.parse((await daemon.cli(['list', '--json'])).stdout)
    check(shown.asks.some(a => a.ticket === weekly.body.ticket), 'kept weekly-parked ask is back in plain list')
  } finally {
    await daemon.stop()
  }

  const second = sandbox('kept-recheck')
  setFocus(second, ['recruiter'])
  const quick = await startDaemon(second, { UNBLOCK_SWEEP_MS: '300', UNBLOCK_RECHECK_AFTER_MS: '1000' })
  try {
    const filed = await quick.api('/api/asks', { ask: ask('Unreachable-origin call'), origin: origin(second, 'recruiter'), focus: 'surface' })
    const state = async () => (await quick.api('/api/asks?includeAside=1')).body.asks.find(a => a.ticket === filed.body.ticket)
    const until = async (done, ms) => {
      for (const end = Date.now() + ms; Date.now() < end;) { if (done(await state())) return true; await new Promise(r => setTimeout(r, 250)) }
      return false
    }
    check((await quick.api(`/api/asks/${filed.body.ticket}/aside`, { reason: 'not_focus' })).status === 200, 'ask is set aside before its recheck is due')
    check((await quick.cli(['keep', filed.body.ticket])).status === 0, 'keep brings it back')
    check(!(await until(a => a.set_aside_at, 4000)), 'a kept ask with no live filer pane is not set aside by the later recheck')
    const view = JSON.parse((await quick.cli(['list', '--alex', '--json'])).stdout)
    check(view.asks.some(a => a.ticket === filed.body.ticket), 'kept ask is in Alex view')
  } finally {
    await quick.stop()
  }
})
