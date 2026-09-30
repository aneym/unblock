// Owner: Opus (r20, review advisories from r12, r16 and r17). Implementers make it pass and never edit it.
// 1. Voice explain passes Alex's question words to alex-said after '--', so a word like "-h" or "--full" is a search
//    word, never a flag. 2. A voice lane note reaches the pane as one compact line of at most 700 characters, like a
//    comment line. 3. `unblock scope patch` refuses a file whose heading names a different section id.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-30T01:00:00Z'
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [
    { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
    { id: 'plan', heading: 'The plan', body_md: 'We ship the page first.' },
    { id: 'later', heading: 'Later', body_md: 'Settings wait for the second pass.' },
  ] },
  threads: [],
}

test('question words reach alex-said after --, never as flags', async () => {
  const work = mkdtempSync(join(tmpdir(), 'scope-r20-'))
  const said = join(work, 'alex-said'), saidLog = join(work, 'alex-said.log')
  writeFileSync(said, `#!/bin/sh\nprintf '%s\\n' "$@" > '${saidLog}'\nprintf '[]'\n`)
  chmodSync(said, 0o755)
  process.env.UNBLOCK_ALEX_SAID = said
  const h = await startScopeHarness(scope)
  try {
    const got = await h.request(`/api/scope/demo/context?q=${encodeURIComponent('-h --full gate')}`, { headers: human })
    assert.equal(got.status, 200, got.text)
    const args = readFileSync(saidLog, 'utf8').trim().split('\n')
    const dash = args.indexOf('--')
    assert.ok(dash >= 0, `argv has --: ${args.join(' ')}`)
    assert.ok(args.slice(0, dash).includes('--json'), 'flags come before --')
    assert.ok(args.slice(dash + 1).includes('gate'), 'words come after --')
    assert.ok(!args.slice(0, dash).some((a) => a === '-h' || a === '--full'), 'his words are never before --')
  } finally { await h.close(); delete process.env.UNBLOCK_ALEX_SAID }
})

test('a voice lane note reaches the pane as one compact line of at most 700 characters', async () => {
  const h = await startScopeHarness(scope)
  try {
    const long = 'Alex asked   what the gate is.\n\nThe gate section should say who approves. ' + 'More detail here. '.repeat(45)
    assert.ok(long.length > 700 && long.length <= 1000)
    const res = await h.request('/api/scope/demo/lane-note', { method: 'POST', headers: human, body: { text: long, via: 'voice' } })
    assert.equal(res.status, 200, res.text)
    const deadline = Date.now() + 5000
    const line = () => h.paneLines().split('\n').find((l) => l.includes("Note from Alex's voice call"))
    while (!line() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    const text = line()?.replace(/^agent prompt \S+ /, '')
    assert.ok(text, 'the note reached the pane')
    assert.ok(text.startsWith("[scoping demo] Note from Alex's voice call (not a comment): Alex asked what the gate is. The gate section"), text.slice(0, 120))
    assert.ok(text.length <= 700, `line is ${text.length} chars`)
    assert.ok(text.endsWith('…'), 'a cut note ends with an ellipsis')
    assert.ok(!h.paneLines().split('\n').some((l) => l.startsWith('The gate section') || l.startsWith('More detail')), 'no line breaks inside the note')
  } finally { await h.close() }
})

test('scope patch refuses a heading {#id} that names another section; nothing is published', async () => {
  const h = await startScopeHarness(scope)
  try {
    const work = mkdtempSync(join(tmpdir(), 'scope-r20-patch-'))
    const cli = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { cwd: work, env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    writeFileSync(join(work, 'wrong.md'), '## The plan, again {#plan}\n\nSettings come second.\n')
    const refused = await cli('scope', 'patch', 'demo', 'later', '--from', join(work, 'wrong.md'))
    assert.equal(refused.status, 1, refused.stdout + refused.stderr)
    assert.match(refused.stderr, /§plan/)
    assert.match(refused.stderr, /§later/)
    const after = (await h.request('/api/scope/demo', { headers: human })).json.scope
    assert.equal(after.revision, 1, 'nothing was published')
    writeFileSync(join(work, 'right.md'), '## Later, after phones {#later}\n\nSettings come second.\n')
    assert.equal((await cli('scope', 'patch', 'demo', 'later', '--from', join(work, 'right.md'))).status, 0, 'a matching id still works')
  } finally { await h.close() }
})
