import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-05T12:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'The question is still open.' },
]
const mistaken = 'Published by mistake; question still open'
const initial = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections },
  threads: [{
    id: 'T1', anchor: anchorInSection(sections[1], 'question'), author: 'agent', kind: 'question', status: 'open',
    messages: [{ from: 'agent', text: mistaken, at }, { from: 'alex', text: mistaken, at },
      { from: 'agent', text: mistaken, at }, { from: 'agent', text: `${mistaken}.`, at },
      { from: 'agent', text: mistaken, at }], created_at: at,
  }],
}

function cli(h, ...args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], {
      env: { ...process.env, UNBLOCK_PORT: String(h.port) },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => done({ status, stdout, stderr }))
  })
}

// Real HTTP and CLI boundaries: publishing must not silently settle a lane's open questions.
test('lane publish refuses scopes and requires explicit closure for other docs; human publishing is unchanged', async () => {
  const h = await startScopeHarness(initial)
  const read = async () => (await h.request('/api/scope/demo', { headers: human })).json.scope
  const publish = (body, headers = h.bearer) => h.request('/api/scope/demo/publish', { method: 'POST', headers, body })
  try {
    for (const kind of [undefined, 'scope']) {
      h.writeScope({ ...initial, ...(kind ? { kind } : {}) })
      const refused = await publish({ revision: 2 })
      assert.equal(refused.status, 409, refused.text)
      assert.equal(refused.json.error, 'a scope is agreed with approve, not published; push the doc with `unblock scope doc`')
      assert.equal((await read()).threads[0].status, 'open')
      assert.equal((await read()).versions, undefined)
    }
    h.writeScope({ ...initial, kind: 'draft' })
    const refused = await publish({ revision: 2 })
    assert.equal(refused.status, 409, refused.text)
    assert.equal(refused.json.error, '1 open threads; pass --close-open to close them on publish')
    assert.equal((await read()).threads[0].status, 'open')
    const invalid = await publish({ revision: 2, close_open: 'true' })
    assert.equal(invalid.status, 400, invalid.text)
    const done = await cli(h, 'scope', 'publish', 'demo', '--close-open', '--json')
    assert.equal(done.status, 0, done.stderr)
    assert.deepEqual(JSON.parse(done.stdout).closed, ['T1'])
    assert.equal((await read()).threads[0].resolution.by, 'agent')
    h.writeScope({ ...initial, kind: 'draft', versions: (await read()).versions })
    const humanNext = await publish({ revision: 2 }, human)
    assert.equal(humanNext.status, 200, humanNext.text)
    assert.deepEqual(humanNext.json.closed, ['T1'])
    assert.equal((await read()).threads[0].resolution.by, 'alex')
  } finally { await h.close() }
})

// Exact removal is observable on the persisted thread, including duplicate replies and protected messages.
test('unsay removes only exact agent replies, never the first message or human messages', async () => {
  const h = await startScopeHarness(initial)
  const read = async () => (await h.request('/api/scope/demo', { headers: human })).json.scope.threads[0]
  const unsay = (body, headers = h.bearer) => h.request('/api/scope/demo/threads/T1/unsay', { method: 'POST', headers, body })
  try {
    const removed = await cli(h, 'scope', 'unsay', 'demo', 'T1', '--text', mistaken, '--json')
    assert.equal(removed.status, 0, removed.stderr)
    assert.equal(JSON.parse(removed.stdout).removed, 2)
    assert.deepEqual((await read()).messages.map(({ from, text }) => ({ from, text })), [
      { from: 'agent', text: mistaken }, { from: 'alex', text: mistaken }, { from: 'agent', text: `${mistaken}.` },
    ])
    const protectedOnly = await unsay({ text: mistaken })
    assert.equal(protectedOnly.status, 404, protectedOnly.text)
    assert.equal((await read()).messages.length, 3)
    const noText = await unsay({})
    assert.equal(noText.status, 400, noText.text)
    const humanRemoval = await unsay({ text: `${mistaken}.` }, human)
    assert.equal(humanRemoval.status, 403, humanRemoval.text)
    assert.equal((await read()).messages.length, 3)
  } finally { await h.close() }
})
