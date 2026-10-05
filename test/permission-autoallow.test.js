import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ALLOW } from '../hooks/bypass-allow.js'

const state = mkdtempSync(join(tmpdir(), 'unblock-autoallow-'))
const env = { ...process.env, UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: join(state, 'config') }
delete env.HERDR_PANE_ID
const EXPECTED = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'

// The real hook boundary: stdin JSON in, exactly the decision JSON (or nothing) out.
function allowed(command, extra = {}) {
  const input = { permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command }, cwd: state, ...extra }
  const out = spawnSync(process.execPath, ['hooks/claude-permission.js'], { input: JSON.stringify(input), env, encoding: 'utf8' })
  assert.equal(out.status, 0)
  assert.ok(out.stdout === '' || out.stdout === EXPECTED + '\n', `unexpected stdout: ${out.stdout}`)
  return out.stdout === EXPECTED + '\n'
}

test('the decision is the full PermissionRequest allow shape', () => assert.equal(ALLOW, EXPECTED))

test('bypass allows variable-target deletes and subagent commands', () => {
  assert.equal(allowed('D=$(mktemp -d); touch $D/a; rm -rf "$D"/*'), true)
  assert.equal(allowed('S=$(mktemp -d); rm -f $S/{w18,c36,t2}-seat.*'), true)
  assert.equal(allowed('rm -rf "${T:?}"'), true)
  assert.equal(allowed('cd x && node -e "1"', { agent_id: 'sub-1' }), true)
  assert.equal(allowed('rm -rf /Volumes/StudioExt/repos/agent-rails-wt/foo'), true)
})

test('roots, main checkouts and Claude settings still ask, however written', () => {
  const s = '/'
  for (const c of ['rm -rf /Volumes/StudioExt/repos/agent-rails', 'rm -rf ~', 'rm -rf "$HOME"/*', `cd x && rm -rf ${s}`,
    'rm -r /Users/aneyman/.claude', '"rm" -rf /Users', '"rmdir" /Users', "bash -c 'rm -rf /Users'",
    'true && (rm -rf /Users)', 'echo $(rm -rf /Users)', 'rm -rf /Users& wait', 'rm -rf \\/Users',
    'rm -rf /Volumes//StudioExt/repos/agent-rails', "printf '/Users\\n' | xargs rm -rf",
    'cd /Volumes/StudioExt/repos && rm -rf agent-rails', 'rm -rf ${HOME}',
    'echo x > ~/.claude/settings.json', 'echo x > ~/.claude/"settings.json"', 'cp a ~/.claude/"hooks"/x.js',
    'cp a /Users/aneyman/.claude/hooks/x.js', 'rm -rf /Volumes/StudioExt/repos/personal/unblock/hooks']) {
    assert.equal(allowed(c), false, c)
  }
  assert.equal(allowed('cp a .claude/hooks/x.js', { cwd: '/Users/aneyman' }), false)
})

test('other modes and tools are unchanged', () => {
  assert.equal(allowed('ls', { permission_mode: 'default' }), false)
  assert.equal(allowed('ls', { permission_mode: 'acceptEdits' }), false)
  assert.equal(allowed('x', { tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }), false)
})
