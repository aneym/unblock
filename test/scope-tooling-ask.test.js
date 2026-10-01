// Owner: Opus (pHY, scoping tooling 2026-10-01). Implementers make it pass and never edit it.
// pZZ (vertical-agents, 2026-10-01 ~16:58 ET):
// "`scope ask` can't anchor on table text ('quote not found'). Table-heavy docs need an extra prose sentence per question."
// "`--option` #1 must repeat `--rec` verbatim or the ask fails. Default option[0] to rec."
// "One call per question: 7 questions took 9 calls ... Add `scope ask --from questions.json` (batch, one approval, one ping to Alex)."
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'
import { locateAnchor } from '../src/scope-anchor.js'
import { sectionPlain } from '../src/scope-doc.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-01T21:00:00Z'
const table = [
  'Who does what today.',
  '',
  '| Option | Cost | Notes |',
  '|---|---|---|',
  '| **Grok** medium | $0.02 | fast, see [the docs](https://example.com/grok) |',
  '| Sonnet | `$2` | slow but careful |',
  '| rails orchestrator → the owning lane | shared | routed by hand |',
].join('\n')
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [
    { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
    { id: 'plan', heading: 'The plan', body_md: 'We ship the page first.' },
    { id: 'seats', heading: 'Seats', body_md: table },
  ] },
  threads: [],
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill(), 15000)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

// Counts every SSE event the scope page would see.
function listen(port, slug) {
  const events = []
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/scope/${slug}/events`, headers: human }, (res) => {
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = frame.match(/^event: (.+)$/m)?.[1]
          if (event) events.push(event)
        }
      })
      resolve({ events, close: () => { req.destroy(); res.destroy() } })
    })
    req.on('error', reject)
    req.end()
  })
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

test('scope ask anchors on table cell text, including quotes copied from the markdown source', async () => {
  const h = await startScopeHarness(v2)
  const env = { ...process.env, UNBLOCK_PORT: String(h.port) }
  try {
    for (const quote of ['Grok medium', '**Grok** medium', 'Sonnet | `$2`', 'fast, see [the docs](https://example.com/grok)', 'slow but careful', 'rails orchestrator → the owning lane', 'Option | Cost | Notes']) {
      const r = await run(['scope', 'ask', 'demo', '--section', 'seats', '--quote', quote, '--rec', 'Grok first', 'Which seat goes first?'], env)
      assert.equal(r.status, 0, `${quote}: ${r.stderr}`)
    }
    const missing = await run(['scope', 'ask', 'demo', '--section', 'seats', '--quote', 'Opus high', 'Which seat?'], env)
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /quote not found/)
    const { scope } = (await h.request('/api/scope/demo', { headers: human })).json
    const seats = scope.doc.sections.find((s) => s.id === 'seats')
    assert.equal(scope.threads.length, 7)
    for (const thread of scope.threads) assert.ok(locateAnchor(sectionPlain(seats), thread.anchor), `T${thread.id} stays attached: ${thread.anchor.quote}`)
  } finally { await h.close() }
})

test('--option puts the recommendation first when it is not listed, and moves it first when it is', async () => {
  const h = await startScopeHarness(v2)
  const env = { ...process.env, UNBLOCK_PORT: String(h.port) }
  const ask = (...args) => run(['scope', 'ask', 'demo', '--section', 'plan', '--quote', 'We ship the page first', ...args], env)
  try {
    assert.equal((await ask('--rec', 'Page first', '--option', 'Doc first', '--option', 'Both', 'Which goes first?')).status, 0)
    assert.equal((await ask('--rec', 'Page first', '--option', 'Doc first', '--option', 'Page first', 'Order?')).status, 0)
    assert.equal((await ask('--rec', 'Page first', '--option', 'Doc first', 'One other?')).status, 0)
    const listed = await ask('--rec', 'Page first', '--option', 'Page first', '--option', 'Doc first', 'Already first?')
    assert.equal(listed.status, 0, listed.stderr)
    const { scope } = (await h.request('/api/scope/demo', { headers: human })).json
    assert.deepEqual(scope.threads.map((t) => t.options), [
      ['Page first', 'Doc first', 'Both'],
      ['Page first', 'Doc first'],
      ['Page first', 'Doc first'],
      ['Page first', 'Doc first'],
    ])
    for (const t of scope.threads) assert.equal(t.recommendation, 'Page first')

    // A reply that changes the recommendation gets the same default.
    const reply = await run(['scope', 'reply', 'demo', 'T1', '--rec', 'Both', '--option', 'Doc first', 'Changed my mind.'], env)
    assert.equal(reply.status, 0, reply.stderr)
    const after = (await h.request('/api/scope/demo', { headers: human })).json.scope.threads.find((t) => t.id === 'T1')
    assert.equal(after.recommendation, 'Both')
    assert.deepEqual(after.options, ['Both', 'Doc first'])
  } finally { await h.close() }
})

test('scope ask --from asks a batch in one write and one page update, or none of it', async () => {
  const h = await startScopeHarness(v2)
  const env = { ...process.env, UNBLOCK_PORT: String(h.port) }
  const work = mkdtempSync(join(tmpdir(), 'unblock-batch-'))
  try {
    const page = await listen(h.port, 'demo')
    await pause(300)
    const baseline = page.events.length
    writeFileSync(join(work, 'q.json'), JSON.stringify([
      { section: 'plan', quote: 'We ship the page first', question: 'Page or doc first?', rec: 'Page first', why: 'Alex reads the page.', options: ['Doc first'] },
      { section: 'seats', quote: '**Grok** medium', question: 'Grok first?', rec: 'Yes' },
      { section: 'seats', quote: 'Sonnet', question: 'Keep Sonnet as reserve?' },
    ]))
    const r = await run(['scope', 'ask', 'demo', '--from', join(work, 'q.json')], env)
    assert.equal(r.status, 0, r.stderr)
    for (const id of ['T1', 'T2', 'T3']) assert.match(r.stdout, new RegExp(`\\b${id}\\b`))
    await pause(500)
    const { scope } = (await h.request('/api/scope/demo', { headers: human })).json
    assert.deepEqual(scope.threads.map((t) => [t.id, t.anchor.section, t.messages[0].text]), [
      ['T1', 'plan', 'Page or doc first?'], ['T2', 'seats', 'Grok first?'], ['T3', 'seats', 'Keep Sonnet as reserve?'],
    ])
    assert.deepEqual(scope.threads[0].options, ['Page first', 'Doc first'])
    assert.equal(scope.threads[0].why, 'Alex reads the page.')
    assert.equal(scope.threads[1].recommendation, 'Yes')
    assert.equal(scope.threads[2].recommendation, undefined)
    assert.equal(page.events.slice(baseline).filter((e) => e === 'scope').length, 1, `one page update for the batch: ${page.events.slice(baseline)}`)

    // {questions: [...]} works too. One bad quote refuses the whole batch and names it.
    writeFileSync(join(work, 'bad.json'), JSON.stringify({ questions: [
      { section: 'plan', quote: 'We ship the page first', question: 'Fine one?' },
      { section: 'seats', quote: 'Opus high', question: 'Broken one?' },
    ] }))
    const bad = await run(['scope', 'ask', 'demo', '--from', join(work, 'bad.json')], env)
    assert.notEqual(bad.status, 0)
    assert.match(bad.stderr, /quote not found/)
    assert.match(bad.stderr, /question 2|questions\[1\]/)
    assert.equal((await h.request('/api/scope/demo', { headers: human })).json.scope.threads.length, 3, 'nothing from a refused batch lands')

    // Slop in any question refuses the batch with the unslop findings; --keep applies to the whole batch.
    writeFileSync(join(work, 'slop.json'), JSON.stringify([
      { section: 'plan', quote: 'We ship the page first', question: 'Should we leverage the page?' },
    ]))
    const slop = await run(['scope', 'ask', 'demo', '--from', join(work, 'slop.json')], env)
    assert.equal(slop.status, 2, slop.stderr)
    assert.match(slop.stderr, /leverage/)
    assert.equal((await h.request('/api/scope/demo', { headers: human })).json.scope.threads.length, 3)
    writeFileSync(join(work, 'kept.json'), JSON.stringify([
      { section: 'plan', quote: 'We ship the page first', question: 'Is Vector the name?' },
    ]))
    assert.equal((await run(['scope', 'ask', 'demo', '--from', join(work, 'kept.json')], env)).status, 2, 'vector is jargon unless kept')
    assert.equal((await run(['scope', 'ask', 'demo', '--from', join(work, 'kept.json'), '--keep', 'Vector'], env)).status, 0)

    // --from cannot mix with single-question flags or words.
    assert.equal((await run(['scope', 'ask', 'demo', '--from', join(work, 'q.json'), '--section', 'plan'], env)).status, 2)
    assert.equal((await run(['scope', 'ask', 'demo', '--from', join(work, 'q.json'), 'extra words'], env)).status, 2)
    page.close()
  } finally { await h.close() }
})
