import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HELD, ask, check, held, main, origin, sandbox, setFocus, startDaemon } from './e2e-lib.mjs'

await main(async () => {
  const box = sandbox('alex-view')
  const focus = setFocus(box, ['recruiter'])
  const daemon = await startDaemon(box)
  try {
    const focused = await daemon.api('/api/asks', { ask: ask('Recruiter pricing call'), origin: origin(box, 'recruiter') })
    check(focused.status === 201, `focus ask filed (${focused.status})`)
    const off = await daemon.api('/api/asks', { ask: ask('Factory quota call'), origin: origin(box, 'factory') })
    check(off.status === 202 && off.body.held, `off-focus ask held (${off.status})`)
    const aside = await daemon.api('/api/asks', { ask: ask('Recruiter copy call'), origin: origin(box, 'recruiter') })
    await daemon.api(`/api/asks/${aside.body.ticket}/aside`, { reason: 'not_focus' })
    const surfaced = await daemon.api('/api/asks', { ask: ask('Factory disk call'), origin: origin(box, 'factory'), focus: 'surface' })
    check(surfaced.status === 201, 'an off-focus ask that bypassed the gate is in the store')

    const view = await daemon.api('/api/asks?view=alex')
    check(view.body.asks.length === 1 && view.body.asks[0].ticket === focused.body.ticket, `view=alex returns only the focus ask: ${view.body.asks.map((a) => a.title)}`)
    check(view.body.hidden.not_focus === 1 && view.body.hidden.aside === 1 && view.body.hidden.held === 1,
      `hidden counts not_focus/aside/held = 1/1/1: ${JSON.stringify(view.body.hidden)}`)
    const raw = await daemon.api('/api/asks')
    check(!raw.body.asks.some((a) => a.ticket === aside.body.ticket), 'plain GET /api/asks omits the set-aside ask')
    const withAside = await daemon.api('/api/asks?includeAside=1')
    check(withAside.body.asks.some((a) => a.ticket === aside.body.ticket), 'includeAside=1 returns it')
    const cli = await daemon.cli(['list', '--alex'])
    check(cli.status === 0 && cli.stdout.startsWith('1 for today; 1 held, 1 set aside'), `unblock list --alex: ${cli.stdout.split('\n')[0]}`)
    check((await held(box, ['list'])).stdout.includes('Factory quota call'), 'held list still has the inventory row for agents')

    rmSync(focus)
    const filed = await daemon.api('/api/asks', { ask: ask('Choose tomorrow’s work', { kind: 'file' }), origin: origin(box, 'factory') })
    check(filed.status === 201 && !filed.body.set_aside_at, 'empty focus files a normal ask without setting it aside')
    const empty = await daemon.api('/api/asks?view=alex')
    check(empty.body.asks.length === 3 && empty.body.asks.some(a => a.ticket === filed.body.ticket), 'empty focus shows all three active file asks')
    check(!empty.body.asks.some(a => a.ticket === aside.body.ticket), 'empty focus still hides an explicitly set-aside ask')
    const json = JSON.parse((await daemon.cli(['list', '--alex', '--json'])).stdout)
    check(json.asks.length === 3 && json.asks.some(a => a.ticket === filed.body.ticket), 'CLI shows the new file ask with empty focus')
    const cancelled = await daemon.api(`/api/asks/${filed.body.ticket}/cancel`, { reason: 'verification finished' })
    check(cancelled.status === 200, 'verification ask cancels successfully')
    const after = await daemon.api('/api/asks?view=alex')
    check(!after.body.asks.some(a => a.ticket === filed.body.ticket), 'cancelled verification ask leaves the visible queue')
  } finally {
    await daemon.stop()
  }
})

await main(async () => {
  const box = sandbox('alex-view-slow')
  setFocus(box, ['recruiter'])
  const flag = join(box.root, 'slow')
  const wrapper = join(box.root, 'held-slow.sh')
  writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = in-focus ] && [ -e "${flag}" ]; then exec sleep 20; fi\nexec python3 ${HELD} "$@"\n`)
  chmodSync(wrapper, 0o755)
  const daemon = await startDaemon(box, { UNBLOCK_HELD_ASKS: `env HOME=${box.home} AGENT_RAILS_LANES=${box.lanes} ${wrapper}` })
  try {
    const filed = await daemon.api('/api/asks', { ask: ask('Recruiter slow-view call'), origin: origin(box, 'recruiter') })
    check(filed.status === 201, `ask filed while the held command is fast (${filed.status})`)
    writeFileSync(flag, '')
    let started = Date.now()
    const first = await daemon.cli(['list', '--alex', '--json'])
    let took = Date.now() - started
    const partial = JSON.parse(first.stdout)
    check(first.status === 0 && took < 5000, `slow in-focus, no prior view: exit ${first.status} in ${took} ms`)
    check(partial.partial === true && partial.error === 'focus and held checks still running' && partial.asks.length === 1 && partial.asks[0].ticket === filed.body.ticket,
      `first call is partial from the store: ${JSON.stringify({ partial: partial.partial, error: partial.error, asks: partial.asks.length })}`)
    const text = await daemon.cli(['list', '--alex'])
    check(text.stdout.includes('(partial: focus and held checks still running)'), 'text output names the partial view')

    await new Promise((resolve) => setTimeout(resolve, 11000))
    rmSync(flag)
    const fresh = await daemon.api('/api/asks?view=alex')
    check(fresh.status === 200 && !fresh.body.partial && !fresh.body.stale && fresh.body.asks.length === 1, 'one completed fresh view once the command is fast again')

    writeFileSync(flag, '')
    started = Date.now()
    const second = await daemon.cli(['list', '--alex', '--json'])
    took = Date.now() - started
    const stale = JSON.parse(second.stdout)
    check(second.status === 0 && took < 5000, `slow round after a good view: exit ${second.status} in ${took} ms`)
    check(stale.stale === true && typeof stale.computed_at === 'number' && stale.asks.length === 1 && stale.asks[0].ticket === filed.body.ticket,
      `second call is the stale previous view: ${JSON.stringify({ stale: stale.stale, asks: stale.asks.length })}`)
    const staleText = await daemon.cli(['list', '--alex'])
    check(/\(stale view from \d+[smhd]\)/.test(staleText.stdout), 'text output names the stale view age')
  } finally {
    await daemon.stop()
  }
})
