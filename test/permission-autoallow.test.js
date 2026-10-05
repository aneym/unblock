import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ALLOW } from '../hooks/bypass-allow.js'

const state = mkdtempSync(join(tmpdir(), 'unblock-autoallow-'))
// An isolated repos root holding a main checkout (.git dir), and a symlink into it whose `..`
// lands on the checkout physically but on the harmless state dir lexically.
const repos = join(state, 'deep')
for (const d of ['jobs/.git', 'jobs/web']) mkdirSync(join(repos, d), { recursive: true })
symlinkSync(join(repos, 'jobs/web'), join(state, 'link'))
const env = { ...process.env, UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: join(state, 'config'), UNBLOCK_REPOS_ROOT: repos }
delete env.HERDR_PANE_ID
const UNBLOCK = '/Volumes/StudioExt/repos/personal/unblock'
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
  assert.equal(allowed('rm -rf "$X" ${W}/tmp', { cwd: UNBLOCK }), true)
  assert.equal(allowed('cd x && node -e "1"', { agent_id: 'sub-1' }), true)
  assert.equal(allowed('rm -rf /Volumes/StudioExt/repos/agent-rails-wt/foo'), true)
  assert.equal(allowed('T=$(mktemp -d); find "$T" -name x -delete; rm -f -- "$T"/a b/c'), true)
  assert.equal(allowed('ls -la && git status && echo done'), true)
})

test('roots, main checkouts and Claude settings still ask, however written', () => {
  const s = '/'
  for (const c of ['rm -rf /Volumes/StudioExt/repos/agent-rails', 'rm -rf ~', 'rm -rf "$HOME"/*', `cd x && rm -rf ${s}`,
    'rm -r /Users/aneyman/.claude', '"rm" -rf /Users', '"rmdir" /Users', "bash -c 'rm -rf /Users'",
    'true && (rm -rf /Users)', 'echo $(rm -rf /Users)', 'rm -rf /Users& wait', 'rm -rf \\/Users',
    'rm -rf /Volumes//StudioExt/repos/agent-rails', "printf '/Users\\n' | xargs rm -rf",
    'cd /Volumes/StudioExt/repos && rm -rf agent-rails', 'rm -rf ${HOME}',
    'echo x > ~/.claude/settings.json', 'echo x > ~/.claude/"settings.json"', 'cp a ~/.claude/"hooks"/x.js',
    'cp a /Users/aneyman/.claude/hooks/x.js', 'rm -rf /Volumes/StudioExt/repos/personal/unblock/hooks',
    '/bin/rm -rf /Users', '/usr/bin/env rm -rf /Users', 'command rm -rf /Users', '\\rm -rf /Users',
    'echo x > ./.claude/settings.json']) {
    assert.equal(allowed(c), false, c)
  }
  assert.equal(allowed('cp a .claude/hooks/x.js', { cwd: '/Users/aneyman' }), false)
})

test('dot segments, nested checkouts and paths relative to cwd are resolved before the check', () => {
  for (const c of ['rm -rf /Users/./aneyman', 'echo x > .claude/./settings.json', 'echo x >> hooks/bypass-allow.js']) {
    assert.equal(allowed(c, { cwd: UNBLOCK }), false, c)
  }
  for (const c of [`rm -rf ${repos}/jobs`, `rm -rf ${repos}/jobs/.git`, 'rm -rf ..', 'rm -rf ../../jobs', 'git clean -fdx ..']) {
    assert.equal(allowed(c, { cwd: `${repos}/jobs/web` }), false, c)
  }
  assert.equal(allowed('rm -rf build && git clean -fdx', { cwd: `${repos}/jobs/web` }), true)
})

test('anything the hook cannot resolve with certainty asks', () => {
  for (const c of ['rm -rf /Users/a\\neyman', 'echo x > .claude/./se\\ttings.json', 'rm -rf /Users/{aneyman,other}',
    `rm -rf ${state}/link/..`, 'rm -rf link/..', 'rm -rf /Volumes/StudioExt/repos/../../jobs', 'rm -rf *', 'rm -rf "$HOME"',
    'X=/Users/aneyman; rm -rf "$X"', 'X=$HOME; rm -rf $X', 'rm -rf "${X:-/Users}"', 'for X in /Users; do rm -rf "$X"; done',
    'echo /Users | while read X; do rm -rf "$X"; done', 'set -- /Users; rm -rf "$1"', 'R=rm; $R -rf /Users',
    "bash -c 'rm -rf /Users/{a,b}'", 'find /Users -delete', 'ls | xargs rm', 'cd "$D" && rm -rf x', 'pushd x; rm y; popd',
    "echo x > $'\\x2e'claude/settings.json", 'rm -rf /users/ANEYMAN', 'git -C /Volumes/StudioExt/repos/agent-rails clean -fdx']) {
    assert.equal(allowed(c), false, c)
  }
  for (const c of ['cd .claude && echo x > settings.json', 'cd .claude', 'cd ~/.claude/hooks']) {
    assert.equal(allowed(c, { cwd: process.env.HOME }), false, c)
  }
  assert.equal(allowed('cd "$X" && echo x > settings.json'), false)
})

test('other modes and tools are unchanged', () => {
  assert.equal(allowed('ls', { permission_mode: 'default' }), false)
  assert.equal(allowed('ls', { permission_mode: 'acceptEdits' }), false)
  assert.equal(allowed('x', { tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }), false)
})
