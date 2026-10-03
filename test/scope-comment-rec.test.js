import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-03T19:00:00Z'
const sections = [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'plan', heading: 'The plan', body_md: 'We build the page first.' }]
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections },
  threads: ['open', 'resolved', 'parked'].map((status, i) => ({
    id: `T${i + 1}`, anchor: anchorInSection(sections[1], 'We build the page first'),
    author: 'alex', kind: 'comment', status, messages: [{ from: 'alex', text: 'Add a review step.', at }], created_at: at,
    ...(status === 'resolved' ? { resolution: { decision: 'Settled', alex_words: null, by: 'agent', at, confirmed_at: at, revision: 1 } } : {}),
  })),
}

function reply(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), 'scope', 'reply', 'demo', 'T1', '--rec', 'Review before shipping', '--why', 'Catch layout errors', 'I will add a review step.'], { env: { ...process.env, UNBLOCK_PORT: String(port) } })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('a comment accepts a CLI recommendation, rejects it, then takes a replacement and tells the lane to edit', async () => {
  const h = await startScopeHarness(scope)
  const post = (id, verb, body, headers = human) => h.request(`/api/scope/demo/threads/${id}/${verb}`, { method: 'POST', headers, body })
  try {
    const cli = await reply(h.port)
    assert.equal(cli.status, 0, cli.stderr)
    let r = await h.request('/api/scope/demo', { headers: human })
    let thread = r.json.scope.threads[0]
    assert.equal(thread.kind, 'comment')
    assert.equal(thread.recommendation, 'Review before shipping')
    assert.equal(thread.why, 'Catch layout errors')
    assert.equal(thread.messages.at(-1).kind, 'option')
    assert.equal(thread.messages.at(-1).recommendation, thread.recommendation)

    r = await post('T1', 'pick', { text: 'yes' })
    assert.equal(r.status, 200, r.text)
    r = await post('T1', 'reject', { text: 'Review the demo too.' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.thread.status, 'open')
    assert.ok(r.json.thread.rejected_at)
    assert.equal(r.json.thread.messages.at(-1).kind, 'reject')
    await h.until(() => h.paneLines().includes('rejected the recommendation on T1'), 'reject bulletin')

    r = await post('T1', 'reply', { text: 'I will review both.', recommendation: 'Review page and demo' }, h.bearer)
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.thread.rejected_at, undefined)
    assert.equal(r.json.thread.why, undefined)
    r = await post('T1', 'resolve', { decision: 'Review page and demo', alex_words: 'Take the recommendation', how: 'take' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.thread.status, 'resolved')
    assert.equal(r.json.thread.resolution.how, 'take')
    assert.equal(r.json.thread.resolution.decision, 'Review page and demo')
    await h.until(() => h.paneLines().includes('took the recommendation on T1'), 'take bulletin')
    assert.match(h.paneLines(), /Edit §The plan to say so, then run: unblock scope resolve demo T1/)
    const notes = (await h.request('/api/scope/demo/notes', { headers: human })).json.notes
    assert.ok(notes.some(note => note.event === 'take' && note.thread === 'T1' && note.text === 'Review page and demo'))
  } finally { await h.close() }
})

test('comment recommendations require an open thread and comments still cannot have options', async () => {
  const h = await startScopeHarness(scope)
  try {
    for (const id of ['T2', 'T3']) {
      const r = await h.request(`/api/scope/demo/threads/${id}/reply`, { method: 'POST', headers: h.bearer, body: { text: 'A plan', recommendation: 'Review first' } })
      assert.equal(r.status, 400, r.text)
      assert.match(r.json.error, /only open comments/)
    }
    const r = await h.request('/api/scope/demo/threads/T1/reply', { method: 'POST', headers: h.bearer, body: { text: 'A plan', recommendation: 'Review first', options: ['Review first', 'Ship first'] } })
    assert.equal(r.status, 400, r.text)
    assert.equal(r.json.error, 'only questions have options')
    const thread = (await h.request('/api/scope/demo', { headers: human })).json.scope.threads[0]
    assert.equal(thread.recommendation, undefined)
    assert.equal(thread.messages.length, 1)
  } finally { await h.close() }
})
