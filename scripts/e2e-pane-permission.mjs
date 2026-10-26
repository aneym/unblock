import { join } from 'node:path'
import { check, main, REPO, run, sandbox, startDaemon } from './e2e-lib.mjs'

const input = (command, extra = {}) => ({
  cwd: '/workspace/house', hook_event_name: 'PermissionRequest', tool_name: 'Bash',
  tool_input: { command }, ...extra,
})

const decision = (result) => result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.decision : null

await main(async () => {
  const box = sandbox('pane-permission')
  const daemon = await startDaemon(box)
  const env = { ...daemon.env, HERDR_PANE_ID: 'test:p1', HERDR_SOCKET_PATH: join(box.root, 'missing.sock'), UNBLOCK_ALLOW_DIALOG: '0' }
  const hook = (value, overrides = {}) => run(process.execPath, [join(REPO, 'hooks', 'claude-permission.js')], value, { ...env, ...overrides })
  try {
    const denied = await hook(JSON.stringify(input('touch subagent-step', { agent_id: 'sub-1', permission_mode: 'default' })))
    check(denied.status === 0, 'pane permission hook exits cleanly')
    check(decision(denied)?.behavior === 'deny', 'pane denies an unsafe command')
    check(/rework the step/i.test(decision(denied)?.message ?? ''), 'pane denial tells the agent to rework the step')
    const asks = await daemon.api('/api/asks?profile=*&includeAside=1')
    check(asks.status === 200 && asks.body.asks.length === 0, 'denied pane command files no ask')

    const allowed = await hook(JSON.stringify(input('printf safe', { permission_mode: 'bypassPermissions' })))
    check(decision(allowed)?.behavior === 'allow', 'bypass-safe command is allowed in a pane')

    const outside = await hook(JSON.stringify(input('touch outside-step')), { HERDR_PANE_ID: '' })
    check(outside.status === 0 && outside.stdout === '', 'outside a pane the prompt is deferred')

    const failed = await hook('{')
    check(decision(failed)?.behavior === 'deny', 'hook failure denies in a pane')
    check(/rework the step/i.test(decision(failed)?.message ?? ''), 'hook failure uses the rework note')
  } finally {
    await daemon.stop()
  }
})
