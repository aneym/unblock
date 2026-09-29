// Scenario (owner: Opus; implementers make it pass, never edit it):
// Alex wants scoping docs to be product demos: screen mocks, storyboards and diagrams
// (PROTOCOL.md "Show, don't tell", 2026-09-29). A lane writes its doc with image lines that point
// at local files; `unblock scope doc --from` uploads screenshots and renders HTML mocks to light
// and dark PNGs, and the daemon serves them sandboxed. The doc carries a manifest of the assets it
// uses. A question about a screen anchors to the figure's caption, never to an image.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T21:00:00Z'
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'demo', heading: 'The demo', body_md: 'Words for now.' }] },
  threads: [],
}
// A 1x1 PNG whose IHDR claims w x h (the daemon reads only the header).
function png(w, h, salt = 0) {
  const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  return Buffer.concat([b, Buffer.from([salt])])
}
const ID = /^[0-9a-f]{16}\.(png|jpg|webp|gif|svg|html|mock)$/

test('lanes put screens and mocks in the doc; the daemon serves them sandboxed; questions anchor to captions', async () => {
  const h = await startScopeHarness(v2)
  const { request, bearer } = h
  const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const buf = Buffer.concat(chunks); let json; try { json = JSON.parse(buf.toString()) } catch {} resolve({ status: res.statusCode, headers: res.headers, buf, json }) })
    })
    req.on('error', reject)
    req.end(body)
  })
  const upload = (body, type, headers = bearer) => raw('/api/scope/demo/assets', { method: 'POST', headers: { ...headers, 'Content-Type': type }, body })
  try {
    // 1. A lane uploads a screenshot: content-addressed, sized, deduped.
    const shot = await upload(png(1280, 800), 'image/png')
    assert.equal(shot.status, 201)
    assert.match(shot.json.id, ID)
    assert.equal(shot.json.ref, `asset:${shot.json.id}`)
    assert.deepEqual([shot.json.type, shot.json.width, shot.json.height], ['image', 1280, 800])
    const again = await upload(png(1280, 800), 'image/png')
    assert.equal(again.status, 200)
    assert.equal(again.json.id, shot.json.id)

    // 2. Only lanes upload, only real images or HTML, within size.
    assert.equal((await upload(png(10, 10, 1), 'image/png', human)).status, 403)
    assert.ok([400, 415].includes((await upload(Buffer.from('%PDF-1.7'), 'application/pdf')).status))
    assert.equal((await upload(Buffer.from('not a png at all'), 'image/png')).status, 400)
    assert.equal((await upload(Buffer.alloc(9 * 1024 * 1024, 1), 'image/png')).status, 413)

    // 3. Served to Alex and lanes, never guessed, never across scopes, always sandboxed.
    const got = await raw(`/api/scope/demo/assets/${shot.json.id}`, { headers: human })
    assert.equal(got.status, 200)
    assert.equal(got.headers['content-type'], 'image/png')
    assert.equal(got.headers['x-content-type-options'], 'nosniff')
    assert.match(got.headers['content-security-policy'], /sandbox/)
    assert.match(got.headers['content-security-policy'], /default-src 'none'/)
    assert.ok(got.buf.equals(png(1280, 800)))
    assert.equal((await raw(`/api/scope/demo/assets/${shot.json.id}`, { headers: bearer })).status, 200)
    assert.ok([401, 403].includes((await raw(`/api/scope/demo/assets/${shot.json.id}`)).status))
    assert.ok([400, 404].includes((await raw('/api/scope/demo/assets/..%2Fscope.json', { headers: human })).status))
    assert.ok([400, 404].includes((await raw('/api/scope/demo/assets/0000000000000000.png', { headers: human })).status))
    assert.equal((await raw(`/api/scope/other/assets/${shot.json.id}`, { headers: human })).status, 404)

    // 4. An HTML mock is served as a sandboxed document: no scripts, no same-origin.
    const html = await upload(Buffer.from('<!doctype html><title>Inbox</title><h1>Inbox</h1><script>parent.x=1</script>'), 'text/html')
    assert.equal(html.status, 201)
    assert.match(html.json.id, /\.html$/)
    const page = await raw(`/api/scope/demo/assets/${html.json.id}`, { headers: human })
    assert.match(page.headers['content-type'], /^text\/html/)
    assert.match(page.headers['content-security-policy'], /sandbox/)
    assert.doesNotMatch(page.headers['content-security-policy'], /allow-scripts|allow-same-origin/)
    assert.match(page.headers['content-security-policy'], /script-src 'none'|default-src 'none'/)

    // 5. A mock record ties the HTML to its light and dark renders and its frame.
    const light = (await upload(png(390, 1600, 2), 'image/png')).json
    const dark = (await upload(png(390, 1600, 3), 'image/png')).json
    const mockBody = (o) => Buffer.from(JSON.stringify({ kind: 'mock', html: html.json.id, light: light.id, dark: dark.id, frame: 'phone', ...o }))
    const mock = await upload(mockBody({}), 'application/json')
    assert.equal(mock.status, 201)
    assert.match(mock.json.id, /\.mock$/)
    assert.deepEqual([mock.json.type, mock.json.width, mock.json.height], ['mock', 390, 1600])
    assert.equal((await upload(mockBody({ light: undefined }), 'application/json')).status, 400)
    assert.equal((await upload(mockBody({ light: html.json.id }), 'application/json')).status, 400, 'light must be an image')
    assert.equal((await upload(mockBody({ frame: 'tablet' }), 'application/json')).status, 400)

    // 6. The doc uses them: consecutive image lines are one figure, captioned by the Figure line.
    const body = ['Noah reviews drafts before they go out.', '',
      `![Inbox on desktop](asset:${shot.json.id})`, `![Inbox on phone](asset:${mock.json.id} "phone")`,
      'Figure: Noah opens the inbox and sees three drafts waiting.'].join('\n')
    const sections = [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'demo', heading: 'The demo', body_md: body }]
    const put = await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections } })
    assert.equal(put.status, 200, put.text)
    const scope = (await request('/api/scope/demo', { headers: human })).json.scope
    assert.deepEqual(scope.doc.assets[shot.json.id], { type: 'image', width: 1280, height: 800 })
    assert.deepEqual(scope.doc.assets[mock.json.id], { type: 'mock', width: 390, height: 1600, light: light.id, dark: dark.id, html: html.json.id, frame: 'phone' })
    assert.equal(Object.keys(scope.doc.assets).length, 2, 'the manifest lists what the doc uses, nothing else')

    // 7. Every image must be an uploaded asset of this scope, with a known frame.
    const bad = async (line) => (await request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections: [sections[0], { ...sections[1], body_md: line }] } }))
    const unknown = await bad('![x](asset:0123456789abcdef.png)')
    assert.equal(unknown.status, 400)
    assert.match(unknown.json.error, /unknown asset/)
    assert.equal((await bad('![x](https://example.com/x.png)')).status, 400)
    assert.equal((await bad('![x](mocks/inbox.png)')).status, 400)
    assert.equal((await bad(`![x](asset:${shot.json.id} "tablet")`)).status, 400)

    // 8. A question about the screen anchors to the caption; image alt text is not doc text.
    const ask = await request('/api/scope/demo/threads', { method: 'POST', headers: bearer,
      body: { section: 'demo', quote: 'sees three drafts waiting', text: 'Three drafts, or one at a time?', recommendation: 'Three at once' } })
    assert.equal(ask.status, 201, ask.text)
    assert.equal(ask.json.thread.anchor.quote, 'sees three drafts waiting')
    const alt = await request('/api/scope/demo/threads', { method: 'POST', headers: bearer,
      body: { section: 'demo', quote: 'Inbox on desktop', text: 'Q?', recommendation: 'x' } })
    assert.equal(alt.status, 400)

    // 9. The CLI turns local files into assets: a screenshot is uploaded; an HTML mock gets its
    //    local CSS and images inlined, is rendered by page-shot at its frame's width in light and
    //    dark, and becomes a mock record. The lane's source file is left alone.
    const work = mkdtempSync(join(tmpdir(), 'scope-cli-'))
    mkdirSync(join(work, 'mocks'))
    writeFileSync(join(work, 'mocks', 'theme.css'), '.card { border: 1px solid #ddd; } /* THEME-MARK */')
    writeFileSync(join(work, 'mocks', 'logo.png'), png(8, 8, 4))
    writeFileSync(join(work, 'mocks', 'inbox.html'), '<!doctype html><link rel="stylesheet" href="theme.css"><img src="logo.png"><div class="card">Three drafts</div>')
    writeFileSync(join(work, 'mocks', 'desk.html'), '<!doctype html><div class="card">Desk</div>')
    writeFileSync(join(work, 'shot.png'), png(1440, 900, 5))
    const md = ['# Demo scope', '', 'A small page.', '', '## The demo {#demo}', '', 'Noah reviews drafts before they go out.', '',
      '![Inbox on phone](mocks/inbox.html "phone")', '![Inbox on desktop](mocks/desk.html)', '![Real screen](shot.png)',
      'Figure: Noah opens the inbox and sees three drafts waiting.'].join('\n')
    writeFileSync(join(work, 'doc.md'), md)
    const log = join(work, 'page-shot.log')
    const fake = join(work, 'fake-page-shot')
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'), path = require('path'); const a = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n')
const opt = (k) => a[a.indexOf(k) + 1]; const out = path.join(opt('--out'), 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2)); fs.mkdirSync(out, { recursive: true })
const w = Number(opt('--widths')); const shots = []
for (const theme of opt('--themes').split(',')) {
  const b = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  b.writeUInt32BE(w, 16); b.writeUInt32BE(1234, 20); const file = path.join(out, theme + '-' + w + '.png'); fs.writeFileSync(file, Buffer.concat([b, Buffer.from(theme)]))
  shots.push({ theme, width: w, status: 200, file })
}
console.log(JSON.stringify({ ok: true, dir: out, shots, console_errors: [] }))
`)
    chmodSync(fake, 0o755)
    const cli = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args],
        { cwd: work, env: { ...process.env, UNBLOCK_PORT: String(h.port), UNBLOCK_PAGE_SHOT: fake } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    const ran = await cli('scope', 'doc', 'demo', '--from', join(work, 'doc.md'))
    assert.equal(ran.status, 0, ran.stderr + ran.stdout)
    assert.equal(readFileSync(join(work, 'doc.md'), 'utf8'), md, 'the source file is untouched')
    const after = (await request('/api/scope/demo', { headers: human })).json.scope
    const demoBody = after.doc.sections.find((s) => s.id === 'demo').body_md
    const refs = [...demoBody.matchAll(/!\[([^\]]*)\]\(asset:([0-9a-f]{16}\.\w+)(?: "(\w+)")?\)/g)].map((m) => ({ alt: m[1], id: m[2], frame: m[3] ?? null }))
    assert.deepEqual(refs.map((r) => [r.alt, r.id.split('.')[1], r.frame]), [['Inbox on phone', 'mock', 'phone'], ['Inbox on desktop', 'mock', null], ['Real screen', 'png', null]])
    assert.match(demoBody, /Figure: Noah opens the inbox and sees three drafts waiting\./)
    const phoneMock = after.doc.assets[refs[0].id], deskMock = after.doc.assets[refs[1].id]
    assert.deepEqual([phoneMock.type, phoneMock.frame, phoneMock.width, phoneMock.height], ['mock', 'phone', 390, 1234])
    assert.deepEqual([deskMock.frame, deskMock.width], ['desktop', 1280])
    assert.deepEqual(after.doc.assets[refs[2].id], { type: 'image', width: 1440, height: 900 })
    const inlined = (await raw(`/api/scope/demo/assets/${phoneMock.html}`, { headers: human })).buf.toString()
    assert.match(inlined, /THEME-MARK/)
    assert.match(inlined, /data:image\/png;base64,/)
    assert.doesNotMatch(inlined, /<link[^>]+stylesheet/)
    const light2 = (await raw(`/api/scope/demo/assets/${phoneMock.light}`, { headers: human })).buf.toString('latin1')
    const dark2 = (await raw(`/api/scope/demo/assets/${phoneMock.dark}`, { headers: human })).buf.toString('latin1')
    assert.ok(light2.endsWith('light') && dark2.endsWith('dark'), 'light and dark renders are kept apart')
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const phoneCall = calls.find((c) => c.includes('390')), deskCall = calls.find((c) => c.includes('1280'))
    assert.ok(phoneCall && phoneCall.includes('--touch') && phoneCall[0].startsWith('file://'))
    assert.ok(deskCall && !deskCall.includes('--touch') && !deskCall.includes('--viewport-only'))
    for (const c of calls) assert.equal(c[c.indexOf('--themes') + 1], 'light,dark')

    // 10. Export round-trips: the exported markdown carries asset refs and imports unchanged.
    const exported = await cli('scope', 'doc', 'demo')
    assert.equal(exported.status, 0, exported.stderr)
    writeFileSync(join(work, 'export.md'), exported.stdout)
    const before = calls.length
    const reimport = await cli('scope', 'doc', 'demo', '--from', join(work, 'export.md'))
    assert.equal(reimport.status, 0, reimport.stderr)
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, before, 'asset refs are not re-rendered')
    assert.equal(existsSync(join(work, 'doc.md')), true)
  } finally { await h.close() }
})
