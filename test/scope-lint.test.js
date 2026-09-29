// Owner: Opus (r7, unslop gate). Implementers make it pass and never edit it.
// Alex (2026-09-29 ~17:30 ET): "all our scoping docs really need /unslop, these are a bit hard to read."
// Every lane write to a scope is checked for the mechanical AI tells and lane jargon before it lands.
// Alex's own words are never checked.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T21:00:00Z'
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'plan', heading: 'The plan', body_md: 'We ship the page first.' }] },
  threads: [],
}
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ') + '.'

test('lane writes are unslopped before they land; Alex is never checked', async () => {
  const h = await startScopeHarness(v2)
  const { request, bearer } = h
  const put = (plan, extra = {}) => request('/api/scope/demo/doc', { method: 'PUT', headers: bearer,
    body: { sections: [v2.doc.sections[0], { id: 'plan', heading: 'The plan', body_md: plan }], ...extra } })
  try {
    // 1. A doc with AI tells and lane jargon is refused whole, with every finding named, and nothing changes.
    const slop = [
      'We leverage a pivotal flow — it ships fast.',
      'Additionally, the page serves as the inbox.',
      'This is not just a list, but a plan.',
      'See PR #3127 and ~/.agent-rails/lanes/x/SPEC.md, then ask pJ0 or gpt-implementer.',
      'In order to ship, the “inbox” goes first.',
      'Open question: TBD.',
    ].join('\n\n')
    const bad = await put(slop)
    assert.equal(bad.status, 422, bad.text)
    assert.equal(bad.json.error, 'unslop')
    const rules = new Set(bad.json.findings.map((f) => f.rule))
    for (const r of ['ai-word', 'plain-word', 'em-dash', 'is', 'not-just', 'pr-number', 'path', 'pane', 'seat', 'filler', 'curly-quote', 'unsettled'])
      assert.ok(rules.has(r), `finding ${r} in ${JSON.stringify(bad.json.findings)}`)
    for (const f of bad.json.findings) {
      assert.equal(f.section, 'plan')
      assert.equal(typeof f.match, 'string')
      assert.ok(f.match.length > 0 && slop.includes(f.match), `match is the exact text: ${f.match}`)
      assert.equal(typeof f.hint, 'string')
    }
    assert.ok(bad.json.findings.some((f) => f.rule === 'plain-word' && /leverage/i.test(f.match) && /use/.test(f.hint)))
    assert.equal((await request('/api/scope/demo', { headers: human })).json.scope.revision, 1, 'a refused write changes nothing')

    // 2. Code, fences, diagrams, image lines and link URLs are not prose; headings and captions are.
    const code = ['Run `leverage --pivotal` then read [the doc](https://example.com/a—b/#3127).', '',
      '```mermaid', 'flowchart LR', '  A[Additionally] --> B[pJ0]', '```', 'Figure: The page goes first.', '',
      '```', 'in order to — leverage', '```'].join('\n')
    const clean = await put(code)
    assert.equal(clean.status, 200, clean.text)
    const cap = await put('Words.\n\n```mermaid\nflowchart LR\n  A --> B\n```\nFigure: A pivotal step.')
    assert.equal(cap.status, 422)
    assert.ok(cap.json.findings.some((f) => f.rule === 'ai-word' && f.match.toLowerCase() === 'pivotal'))
    const head = await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer,
      body: { sections: [v2.doc.sections[0], { id: 'plan', heading: 'The crucial plan', body_md: 'Words.' }] } })
    assert.equal(head.status, 422)

    // 3. keep lets a lane keep a named term it needs (a product name), only that term.
    const kept = await put('Vector is the name of the product.', { keep: ['Vector'] })
    assert.equal(kept.status, 200, kept.text)
    const partly = await put('Vector is the name. It is pivotal.', { keep: ['vector'] })
    assert.equal(partly.status, 422)
    assert.deepEqual(partly.json.findings.map((f) => f.match.toLowerCase()), ['pivotal'])

    // 4. The prose budget is a warning, not a refusal: over 120 words outside captions, tables and code.
    const long = await put(`${words(150)}\n\n| a | b |\n|---|---|\n| ${words(40)} | x |`)
    assert.equal(long.status, 200, long.text)
    assert.deepEqual(long.json.warnings, [{ section: 'plan', rule: 'words', count: 150, limit: 120 }])
    const short = await put(`${words(100)}\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\nFigure: ${words(40)}`)
    assert.equal(short.status, 200)
    assert.deepEqual(short.json.warnings ?? [], [])

    // 5. Questions, replies, options and decisions from a lane are checked the same way.
    await put('We ship the page first.')
    const ask = (body) => request('/api/scope/demo/threads', { method: 'POST', headers: bearer, body: { section: 'plan', quote: 'We ship the page first', ...body } })
    assert.equal((await ask({ text: 'Should we leverage the page?', recommendation: 'Page first' })).status, 422)
    assert.equal((await ask({ text: 'Page first?', recommendation: 'Page — first' })).status, 422)
    assert.equal((await ask({ text: 'Page first?', recommendation: 'Page first', options: ['Page first', 'Pivotal inbox'] })).status, 422)
    assert.equal((await ask({ text: 'Page first?', recommendation: 'Page first', why: 'See PR #3127' })).status, 422)
    const ok = await ask({ text: 'Which screen first?', recommendation: 'Page first', options: ['Page first', 'Inbox first'] })
    assert.equal(ok.status, 201, ok.text)
    const id = ok.json.thread.id
    assert.equal((await request(`/api/scope/demo/threads/${id}/reply`, { method: 'POST', headers: bearer, body: { text: 'Additionally, both.' } })).status, 422)
    assert.equal((await request(`/api/scope/demo/threads/${id}/reply`, { method: 'POST', headers: bearer, body: { text: 'Both work.' } })).status, 200)
    assert.equal((await request(`/api/scope/demo/threads/${id}/edit`, { method: 'POST', headers: bearer, body: { options: ['Page first', 'Utilize the inbox'] } })).status, 422)

    // 6. Alex's own words are never checked.
    const alex = await request(`/api/scope/demo/threads/${id}/reply`, { method: 'POST', headers: human, body: { text: 'Honestly — leverage whatever, it is crucial.' } })
    assert.equal(alex.status, 200, alex.text)

    // 7. The CLI shows the findings before publishing, exits 2, and says to run /unslop; --keep passes a term;
    //    `scope lint` checks a file without publishing.
    const work = mkdtempSync(join(tmpdir(), 'scope-lint-'))
    const cli = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { cwd: work, env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    writeFileSync(join(work, 'doc.md'), '# Demo scope\n\nA small page.\n\n## The plan {#plan}\n\nWe ship the page first. Vector leads — it is pivotal.\n')
    const before = (await request('/api/scope/demo', { headers: human })).json.scope.revision
    const refused = await cli('scope', 'doc', 'demo', '--from', join(work, 'doc.md'))
    assert.equal(refused.status, 2, refused.stderr)
    assert.match(refused.stderr, /§plan/)
    assert.match(refused.stderr, /pivotal/)
    assert.match(refused.stderr, /em dash|—/)
    assert.match(refused.stderr, /\/unslop/)
    assert.equal((await request('/api/scope/demo', { headers: human })).json.scope.revision, before)
    const lint = await cli('scope', 'lint', 'demo', '--from', join(work, 'doc.md'))
    assert.equal(lint.status, 2)
    assert.match(lint.stderr + lint.stdout, /pivotal/)
    assert.equal((await request('/api/scope/demo', { headers: human })).json.scope.revision, before, 'lint never publishes')
    writeFileSync(join(work, 'doc.md'), '# Demo scope\n\nA small page.\n\n## The plan {#plan}\n\nWe ship the page first. Vector leads.\n')
    assert.equal((await cli('scope', 'lint', 'demo', '--from', join(work, 'doc.md'))).status, 2, 'vector is jargon unless kept')
    const pass = await cli('scope', 'doc', 'demo', '--from', join(work, 'doc.md'), '--keep', 'Vector')
    assert.equal(pass.status, 0, pass.stderr)
    const bash = await cli('scope', 'ask', 'demo', '--section', 'plan', '--quote', 'We ship the page first', '--rec', 'Page first', 'Should we leverage it?')
    assert.equal(bash.status, 2)
    assert.match(bash.stderr, /leverage/)
  } finally { await h.close() }
})
