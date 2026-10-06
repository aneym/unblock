// Integration at the subprocess boundary: the SSH command must preserve literal post arguments.
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { migrateV1, validateScope } from '../src/scope-doc.js'
import { scopePostCommand } from '../src/pane-notice.js'

const base = { version: 2, slug: 'host-check', title: 'Host check', pane: 'w1:p4', revision: 1,
  doc: { sections: [{ id: 'title', heading: 'Host check', body_md: 'A valid scope.' }] }, threads: [] }

test('scope pane validation accepts local and remote hosts without changing the pane', () => {
  for (const host of [undefined, 'ax42', hostname(), 'localhost']) {
    assert.deepEqual(validateScope({ ...base, ...(host === undefined ? {} : { host }) }), [])
  }
  for (const host of ['', '-oProxyCommand=bad', 'ax42;echo bad', 'user@ax42', 42, null]) {
    assert.ok(validateScope({ ...base, host }).includes('invalid host'))
  }
  assert.equal(migrateV1({ slug: 'host-check', title: 'Host check', pane: 'w1:p4', host: 'ax42', plan_md: 'Plan' }).host, 'ax42')
})

test('local post retains its executable and arguments', () => {
  const args = ['post', '--to', 'w1:p4', '--text', 'host-routing check from Studio']
  for (const host of [undefined, 'localhost', hostname()]) {
    assert.deepEqual(scopePostCommand('/local/lane-post', args, host), { bin: '/local/lane-post', args })
  }
})

test('remote SSH post preserves shell metacharacters as literal arguments', () => {
  const args = ['post', '--to', 'w1:p4', '--text', "Alex's note; $(printf injected)\nnext line"]
  const command = scopePostCommand('/local/lane-post', args, 'ax42')
  assert.equal(command.bin, 'ssh')
  assert.ok(command.args.at(-1).startsWith('"$HOME/.local/bin/lane-post" '))
  assert.deepEqual(command.args.slice(0, -1), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', 'ax42'])
  // A real shell represents SSH's remote shell, with only its external lane-post edge replaced.
  const output = execFileSync('/bin/sh', ['-c', `set -- ${command.args.at(-1)}; shift; printf '%s\\0' "$@"`])
  assert.deepEqual(output.toString().split('\0').slice(0, -1), args)
  assert.throws(() => scopePostCommand('lane-post', args, '-oProxyCommand=bad'), /invalid scope host/)
})
