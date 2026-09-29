// Owner: Opus (H1b). Implementers make it pass and never edit it.
// A phone mock renders at phone width even when the lane forgot the viewport tag, page-shot
// failures say what happened, and an image hidden behind brackets in its alt text is still refused.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T21:00:00Z'
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'demo', heading: 'The demo', body_md: 'Words for now.' }] },
  threads: [],
}
const VIEWPORT = /<meta\s+name="viewport"\s+content="width=device-width[^"]*"\s*\/?>/gi

test('mock HTML gets a viewport tag once; page-shot failures are named; bracketed alt text cannot hide a remote image', async () => {
  const h = await startScopeHarness(v2)
  const { request, bearer } = h
  try {
    const work = mkdtempSync(join(tmpdir(), 'scope-cli-b-'))
    mkdirSync(join(work, 'mocks'))
    writeFileSync(join(work, 'mocks', 'bare.html'), '<!doctype html><html><head><title>t</title></head><body><div>Bare phone</div></body></html>')
    writeFileSync(join(work, 'mocks', 'nohead.html'), '<div>No head at all</div>')
    writeFileSync(join(work, 'mocks', 'has.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>Has one</body></html>')
    const md = ['# Demo scope', '', 'A small page.', '', '## The demo {#demo}', '', 'Screens.', '',
      '![Bare](mocks/bare.html "phone")', '![No head](mocks/nohead.html "phone")', '![Has](mocks/has.html)', 'Figure: Three mocks.'].join('\n')
    writeFileSync(join(work, 'doc.md'), md)
    const seen = join(work, 'seen')
    mkdirSync(seen)
    const fake = (name, body) => { const f = join(work, name); writeFileSync(f, `#!/usr/bin/env node\n${body}`); chmodSync(f, 0o755); return f }
    const good = fake('good-page-shot', `const fs = require('fs'), path = require('path'); const a = process.argv.slice(2)
const opt = (k) => a[a.indexOf(k) + 1]; const src = new URL(a[0]).pathname
fs.copyFileSync(src, path.join(${JSON.stringify(seen)}, Date.now() + '-' + Math.random().toString(36).slice(2) + '.html'))
const out = path.join(opt('--out'), 'r' + Math.random().toString(36).slice(2)); fs.mkdirSync(out, { recursive: true })
const shots = opt('--themes').split(',').map((theme) => { const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  b.writeUInt32BE(Number(opt('--widths')) * 2, 16); b.writeUInt32BE(2000, 20); const file = path.join(out, theme + '.png'); fs.writeFileSync(file, Buffer.concat([b, Buffer.from(theme + src)])); return { theme, file } })
console.log(JSON.stringify({ ok: true, dir: out, shots, console_errors: [] }))`)
    const failing = fake('bad-page-shot', `process.stderr.write('chromium exploded: BOOM-TAIL\\n'); process.exit(3)`)
    const cli = (shot, ...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args],
        { cwd: work, env: { ...process.env, UNBLOCK_PORT: String(h.port), UNBLOCK_PAGE_SHOT: shot } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
    })

    // 1. Every mock page-shot renders carries exactly one viewport tag, so a "phone" mock lays out
    //    at 390 instead of a shrunken 980 desktop page. The stored HTML (the live mock) has it too.
    const ran = await cli(good, 'scope', 'doc', 'demo', '--from', join(work, 'doc.md'))
    assert.equal(ran.status, 0, ran.stderr + ran.stdout)
    const rendered = (await import('node:fs')).readdirSync(seen).map((f) => readFileSync(join(seen, f), 'utf8'))
    assert.equal(rendered.length, 3)
    for (const html of rendered) assert.equal((html.match(VIEWPORT) || []).length, 1, html.slice(0, 300))
    assert.ok(rendered.some((html) => html.includes('No head at all')))
    const scope = (await request('/api/scope/demo', { headers: human })).json.scope
    const mocks = Object.values(scope.doc.assets).filter((a) => a.type === 'mock')
    assert.equal(mocks.length, 3)
    for (const m of mocks) {
      const html = await request(`/api/scope/demo/assets/${m.html}`, { headers: human })
      assert.equal((html.text.match(VIEWPORT) || []).length, 1, html.text.slice(0, 300))
    }
    assert.equal(readFileSync(join(work, 'mocks', 'bare.html'), 'utf8').includes('viewport'), false, 'the source is untouched')

    // 2. page-shot that exists but fails says it failed, with its error tail; a missing one says not found.
    writeFileSync(join(work, 'mocks', 'other.html'), '<div>Other</div>')
    writeFileSync(join(work, 'doc2.md'), md.replace('mocks/bare.html', 'mocks/other.html'))
    const failed = await cli(failing, 'scope', 'doc', 'demo', '--from', join(work, 'doc2.md'))
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /can't render .*other\.html: page-shot failed/)
    assert.match(failed.stderr, /BOOM-TAIL/)
    assert.doesNotMatch(failed.stderr, /not found/)
    const missing = await cli(join(work, 'no-such-page-shot'), 'scope', 'doc', 'demo', '--from', join(work, 'doc2.md'))
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /can't render .*other\.html: page-shot not found \(render it to PNG yourself and reference the PNG\)/)

    // 3. Brackets inside the alt text do not hide a non-asset image from the doc check.
    const sections = scope.doc.sections
    const bad = async (line) => (await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer,
      body: { sections: sections.map((s) => s.id === 'demo' ? { ...s, body_md: line } : s) } })).status
    assert.equal(await bad('![a [b] c](https://evil.example/x.png)'), 400)
    assert.equal(await bad('![a [b]](mocks/x.png)'), 400)
  } finally { await h.close() }
})
