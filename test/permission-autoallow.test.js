import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const state = mkdtempSync(join(tmpdir(), 'unblock-autoallow-'))
const env = { ...process.env, UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: join(state, 'config') }
delete env.HERDR_PANE_ID

// The real hook boundary: stdin JSON in, decision JSON (or nothing) out.
function allowed(command, extra = {}) {
  const input = { permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command }, cwd: state, ...extra }
  const out = spawnSync(process.execPath, ['hooks/claude-permission.js'], { input: JSON.stringify(input), env, encoding: 'utf8' })
  return out.stdout.includes('"behavior":"allow"')
}

test('bypass allows variable-target deletes and subagent commands', () => {
  assert.equal(allowed('D=$(mktemp -d); touch $D/a; rm -rf "$D"/*'), true)
  assert.equal(allowed('rm -rf "${T:?}"'), true)
  assert.equal(allowed('cd x && node -e "1"', { agent_id: 'sub-1' }), true)
  assert.equal(allowed('rm -rf /Volumes/StudioExt/repos/agent-rails-wt/foo'), true)
})

test('roots, main checkouts and Claude settings still ask', () => {
  const slash = '/'
  for (const c of ['rm -rf /Volumes/StudioExt/repos/agent-rails', 'rm -rf ~', 'rm -rf "$HOME"/*', `cd x && rm -rf ${slash}`,
    'rm -r /Users/aneyman/.claude', 'echo x > ~/.claude/settings.json', 'cp a /Users/aneyman/.claude/hooks/x.js']) {
    assert.equal(allowed(c), false, c)
  }
})

test('other modes and tools are unchanged', () => {
  assert.equal(allowed('ls', { permission_mode: 'default' }), false)
  assert.equal(allowed('ls', { permission_mode: 'acceptEdits' }), false)
  assert.equal(allowed('x', { tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }), false)
})
