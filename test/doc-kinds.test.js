// Owner: Opus (explainers lane for w5H:p0M, 2026-10-03). Implementers make it pass and never edit it.
// Alex (2026-10-03): scoping, review, explainer and writing-studio docs all share one system. A doc's kind
// (scope | explainer | review | draft | report) comes from one registry (src/doc-kinds.js) that declares the kind's
// actions and whether the answerer is on; everything else (sections, anchors, comments, live items) is shared.
// Contract: every registered kind validates, lists as itself, and is creatable from the CLI; a kind without approval
// refuses an approve; the answerer follows the kind's default unless the doc sets answerer on/off.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { anchorInSection, validateScope } from '../src/scope-doc.js'
import { KIND_IDS, kindOf } from '../src/doc-kinds.js'
import { human, startScopeHarness } from './scope-harness.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-03T23:00:00Z'
const sections = [
  { id: 'title', heading: 'A doc', body_md: 'One doc of some kind.' },
  { id: 'body', heading: 'Body', body_md: 'The runner ships first. Voice comes last.' },
]
const doc = (slug, extra = {}) => ({ version: 2, slug, title: 'A doc', pane: 'w5H:pQA', revision: 1, updated_at: at, doc: { sections }, threads: [], ...extra })

test('the registry names the five kinds, and an unknown or missing kind reads as scope', () => {
  assert.deepEqual([...KIND_IDS].sort(), ['draft', 'explainer', 'report', 'review', 'scope'])
  assert.equal(kindOf({ kind: 'review' }), 'review')
  assert.equal(kindOf({}), 'scope')
  assert.equal(kindOf({ kind: 'memo' }), 'scope')
})

test('every registered kind validates; anything else is refused', () => {
  // validateScope returns the list of problems (callers answer 400 with the first one); it never throws.
  for (const kind of KIND_IDS) assert.deepEqual(validateScope(doc(`k-${kind}`, { kind })), [], kind)
  assert.deepEqual(validateScope(doc('k-memo', { kind: 'memo' })), ['invalid kind'])
})

async function boot(scope) {
  const h = await startScopeHarness(scope)
  const dir = dirname(process.env.HERDR_BIN_PATH)
  const runs = join(dir, 'answer-runs')
  mkdirSync(runs, { recursive: true })
  const answerer = join(dir, 'answerer-stub')
  writeFileSync(answerer, `#!/bin/sh\ntouch '${runs}'/run-$$\ncat >/dev/null\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Stub answer."}'\n`)
  chmodSync(answerer, 0o700)
  const lanePost = join(dir, 'lane-post-stub')
  writeFileSync(lanePost, `#!/bin/sh\necho "b-20261003230000-$$"\n`)
  chmodSync(lanePost, 0o700)
  Object.assign(process.env, { UNBLOCK_ANSWERER_BIN: answerer, UNBLOCK_LANE_POST_BIN: lanePost, UNBLOCK_SUPERVISED: '1' })
  const ask = (text) => h.request(`/api/scope/${scope.slug}/threads`, { method: 'POST', headers: human,
    body: { text, client_id: `c-${Date.now()}`, anchor: anchorInSection(sections[1], 'Voice comes last') } })
  const spawned = () => readdirSync(runs).length
  const get = async () => (await h.request(`/api/scope/${scope.slug}`, { headers: human })).json.scope
  return { h, ask, spawned, get }
}
const settle = () => new Promise((r) => setTimeout(r, 1500))

test('a review doc lists as review, takes comments the lane way, and spawns no answerer', async () => {
  const t = await boot(doc('a-review', { kind: 'review' }))
  try {
    const listed = (await t.h.request('/api/scope', { headers: human })).json
    const rows = Array.isArray(listed) ? listed : listed.scopes
    assert.equal(rows.find((r) => r.slug === 'a-review').kind, 'review')
    assert.ok([200, 201].includes((await t.ask('Why last?')).status))
    await settle()
    assert.equal(t.spawned(), 0, 'no answerer for a review doc by default')
    assert.ok(!(await t.get()).threads[0].messages.some((m) => m.answerer), 'no Answering… message')
  } finally { await t.h.close() }
})

test('a report doc with answerer on gets answers: the seam works for any kind', async () => {
  const t = await boot(doc('a-report', { kind: 'report', answerer: 'on', sources: [tmpdir()] }))
  try {
    assert.ok([200, 201].includes((await t.ask('What ships first?')).status))
    const end = Date.now() + 8000
    while (Date.now() < end && !(await t.get()).threads[0].messages.some((m) => m.answerer && !m.pending)) await new Promise((r) => setTimeout(r, 50))
    assert.equal(t.spawned(), 1)
    assert.equal((await t.get()).threads[0].messages.find((m) => m.answerer && !m.pending)?.text, 'Stub answer.')
  } finally { await t.h.close() }
})

test('a kind without approval refuses an approve and leaves the doc unapproved', async () => {
  for (const kind of ['explainer', 'review']) {
    const t = await boot(doc(`no-approve-${kind}`, { kind, ...(kind === 'explainer' ? { sources: [tmpdir()] } : {}) }))
    try {
      const r = await t.h.request(`/api/scope/no-approve-${kind}/approve`, { method: 'POST', headers: human, body: { mode: 'approve' } })
      assert.ok(r.status >= 400 && r.status < 500, `${kind}: ${r.status} ${r.text}`)
      assert.ok(!(await t.get()).approval, `${kind}: still unapproved`)
    } finally { await t.h.close() }
  }
})

test('scope new --kind makes any registered kind, and an unknown kind is refused', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'unblock-kinds-cli-'))
  const scopes = join(temp, 'scopes')
  mkdirSync(scopes)
  const env = { ...process.env, UNBLOCK_STATE_DIR: join(temp, 'state'), UNBLOCK_CONFIG_DIR: join(temp, 'config'), UNBLOCK_PORT: '9', UNBLOCK_SCOPING_DIR: scopes, UNBLOCK_SECRET_BACKEND: 'env' }
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd: temp })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('close', (status) => resolve({ status, out, err }))
  })
  const made = await run(['scope', 'new', 'weekly-report', '--pane', 'w5H:pQA', '--kind', 'report'])
  assert.equal(made.status, 0, made.err)
  assert.equal(JSON.parse(readFileSync(join(scopes, 'weekly-report', 'scope.json'), 'utf8')).kind, 'report')
  const review = await run(['scope', 'new', 'pr-review', '--pane', 'w5H:pQA', '--kind', 'review'])
  assert.equal(review.status, 0, review.err)
  const bad = await run(['scope', 'new', 'a-memo', '--pane', 'w5H:pQA', '--kind', 'memo'])
  assert.notEqual(bad.status, 0)
  assert.ok(!existsSync(join(scopes, 'a-memo', 'scope.json')), 'nothing written for an unknown kind')
})
