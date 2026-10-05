// Owner: Opus (r11, demo and video blocks). Implementers make it pass and never edit it.
// Alex (2026-09-29 via p6): "scope pages need a demo block: an inline 'Try it' embed (iframe of a tailnet demo URL,
// mic allowed for voice demos) and a video block, each able to anchor comments."
// Syntax and anchors agreed with the live-docs lane (~/.agent-rails/scoping/live-docs/asks/FROM-pHY-3.md):
// ```demo / ```video fences of `key: value` lines, then a `Figure:` caption that comments anchor to; a video
// comment may carry `t` (seconds) and `t_end`.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-29T21:00:00Z'
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'try', heading: 'Try it', body_md: 'Words for now.' }] },
  threads: [],
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const png = (salt = 0) => Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([salt])])
// Just enough of each container for the daemon's magic-byte check.
const mp4 = (size) => { const b = Buffer.alloc(size, 7); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'ascii'); return b }
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)])
const DEMO = '<!doctype html><meta charset="utf-8"><button id="b">Talk</button><script>parent.postMessage({ demo: "ran" }, "*")</script>'

test('lanes put a live demo and a recording in the doc; video is served in ranges; comments can pin a moment', async () => {
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
  const upload = (body, type) => raw('/api/scope/demo/assets', { method: 'POST', headers: { ...bearer, 'Content-Type': type }, body })
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  const put = (body_md) => request('/api/scope/demo/doc', { method: 'PUT', headers: bearer, body: { sections: [
    { id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'try', heading: 'Try it', body_md },
  ] } })
  try {
    // 1. Recordings upload like screenshots: mp4 and webm, checked by their bytes, up to 64 MiB.
    const big = mp4(9 * 1024 * 1024)
    const clip = await upload(big, 'video/mp4')
    assert.equal(clip.status, 201, clip.buf.toString())
    assert.match(clip.json.id, /^[0-9a-f]{16}\.mp4$/)
    assert.equal(clip.json.type, 'video')
    const web = await upload(webm(), 'video/webm')
    assert.equal(web.status, 201, web.buf.toString())
    assert.match(web.json.id, /^[0-9a-f]{16}\.webm$/)
    assert.equal((await upload(Buffer.from('not a video at all'), 'video/mp4')).status, 400)
    assert.equal((await upload(Buffer.from('also not a video'), 'video/webm')).status, 400)
    assert.equal((await upload(mp4(65 * 1024 * 1024), 'video/mp4')).status, 413)

    // 2. Video is served in byte ranges, so a browser can seek (Safari will not play it otherwise).
    const path = `/api/scope/demo/assets/${clip.json.id}`
    const full = await raw(path, { headers: human })
    assert.equal(full.status, 200)
    assert.equal(full.headers['content-type'], 'video/mp4')
    assert.equal(full.headers['accept-ranges'], 'bytes')
    assert.equal(full.buf.length, big.length)
    const part = await raw(path, { headers: { ...human, Range: 'bytes=4-11' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers['content-range'], `bytes 4-11/${big.length}`)
    assert.equal(part.headers['content-length'], '8')
    assert.equal(part.buf.toString('ascii'), 'ftypisom')
    const tail = await raw(path, { headers: { ...human, Range: 'bytes=-4' } })
    assert.equal(tail.status, 206)
    assert.equal(tail.headers['content-range'], `bytes ${big.length - 4}-${big.length - 1}/${big.length}`)
    const rest = await raw(path, { headers: { ...human, Range: 'bytes=100-' } })
    assert.equal(rest.status, 206)
    assert.equal(rest.buf.length, big.length - 100)
    const past = await raw(path, { headers: { ...human, Range: `bytes=${big.length}-` } })
    assert.equal(past.status, 416)
    assert.equal(past.headers['content-range'], `bytes */${big.length}`)

    // 3. An HTML demo runs its own script, in a sandbox with no access to the page; images stay script-free.
    const demo = await upload(Buffer.from(DEMO), 'text/html')
    assert.equal(demo.status, 201)
    const served = await raw(`/api/scope/demo/assets/${demo.json.id}`, { headers: human })
    const csp = served.headers['content-security-policy']
    assert.match(csp, /^sandbox allow-scripts allow-forms;/, csp)
    assert.match(csp, /script-src 'unsafe-inline'/, csp)
    assert.doesNotMatch(csp, /allow-same-origin|connect-src (?!'none')/, csp)
    const shot = await upload(png(1), 'image/png')
    const image = await raw(`/api/scope/demo/assets/${shot.json.id}`, { headers: human })
    assert.match(image.headers['content-security-policy'], /^sandbox;/)
    assert.doesNotMatch(image.headers['content-security-policy'], /allow-scripts/)

    // 4. The doc takes demo and video fences. Asset refs are checked like image lines; the doc lists what it uses.
    const body = [
      'Try the flow here, or watch the recording.', '',
      '```demo', 'src: https://studio.example.ts.net:8799/demo/voice/', 'height: 640', 'frame: phone', 'allow: microphone', '```', 'Figure: Try the voice flow.', '',
      '```demo', `src: asset:${demo.json.id}`, '```', 'Figure: A small demo inside the page.', '',
      '```video', `src: asset:${clip.json.id}`, `poster: asset:${shot.json.id}`, '```', 'Figure: The inbox, recorded on a phone.',
    ].join('\n')
    const ok = await put(body)
    assert.equal(ok.status, 200, ok.text)
    const assets = (await get()).doc.assets
    assert.equal(assets[clip.json.id]?.type, 'video')
    assert.equal(assets[demo.json.id]?.type, 'html')
    assert.equal(assets[shot.json.id]?.type, 'image')
    const rev = (await get()).revision
    const refuse = async (fence, why) => {
      const r = await put(`Words.\n\n${fence}\nFigure: A caption.`)
      assert.equal(r.status, 400, `${why}: ${r.text}`)
    }
    await refuse(['```video', `src: asset:${shot.json.id}`, '```'].join('\n'), 'a video src must be a video')
    await refuse(['```video', `src: asset:${clip.json.id}`, `poster: asset:${clip.json.id}`, '```'].join('\n'), 'a poster must be an image')
    await refuse(['```video', 'src: asset:0123456789abcdef.mp4', '```'].join('\n'), 'an unknown asset')
    await refuse(['```demo', `src: asset:${shot.json.id}`, '```'].join('\n'), 'a demo asset must be HTML')
    await refuse(['```demo', 'src: http://example.com/', '```'].join('\n'), 'plain http')
    await refuse(['```demo', 'src: javascript:alert(1)', '```'].join('\n'), 'a script URL')
    await refuse(['```demo', 'height: 400', '```'].join('\n'), 'no src')
    assert.equal((await get()).revision, rev, 'a refused doc changes nothing')

    // 5. A comment on the recording pins a moment: t in seconds (one decimal), t_end if after t; junk is dropped.
    const say = (anchor, text) => request('/api/scope/demo/threads', { method: 'POST', headers: human, body: { anchor, text } })
    const cap = { section: 'try', quote: 'The inbox, recorded on a phone', prefix: '', suffix: '.' }
    const pinned = await say({ ...cap, t: 12.34 }, 'Here it stalls.')
    assert.equal(pinned.status, 201, pinned.text)
    assert.equal(pinned.json.thread.anchor.t, 12.3)
    assert.equal(pinned.json.thread.anchor.t_end, undefined)
    const span = (await say({ ...cap, t: 5, t_end: 9.25 }, 'This stretch drags.')).json.thread.anchor
    assert.deepEqual([span.t, span.t_end], [5, 9.3])
    for (const [anchor, why] of [[{ ...cap, t: 5, t_end: 2 }, 't_end before t'], [{ ...cap, t: -1 }, 'negative'], [{ ...cap, t: 'x' }, 'not a number'], [{ ...cap, t: 90000 }, 'over a day']]) {
      const made = await say(anchor, `Dropped: ${why}.`)
      assert.equal(made.status, 201, made.text)
      assert.ok(!('t_end' in made.json.thread.anchor), why)
      if (why !== 't_end before t') assert.ok(!('t' in made.json.thread.anchor), why)
    }
    const stored = (await get()).threads.find((t) => t.messages[0].text === 'Here it stalls.')
    assert.equal(stored.anchor.t, 12.3, 'the moment is stored, not only echoed')

    // 6. The CLI uploads a section's local demo page, recording and poster, and rewrites them to asset refs.
    const work = mkdtempSync(join(tmpdir(), 'scope-demo-'))
    writeFileSync(join(work, 'demo.html'), DEMO.replace('Talk', 'Talk now'))
    writeFileSync(join(work, 'clip.webm'), webm())
    writeFileSync(join(work, 'poster.png'), png(2))
    writeFileSync(join(work, 'try.md'), [
      '## Try it {#try}', '', 'Try the flow here, or watch the recording.', '',
      '```demo', 'src: https://studio.example.ts.net:8799/demo/voice/', 'allow: microphone', '```', 'Figure: Try the voice flow.', '',
      '```demo', 'src: demo.html', 'frame: phone', '```', 'Figure: A small demo inside the page.', '',
      '```video', 'src: ./clip.webm', 'poster: poster.png', '```', 'Figure: The inbox, recorded on a phone.', '',
    ].join('\n'))
    const cli = (...args) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { cwd: tmpdir(), env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
      let stdout = '', stderr = ''
      child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
      child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    const done = await cli('scope', 'patch', 'demo', 'try', '--from', join(work, 'try.md'))
    assert.equal(done.status, 0, done.stderr)
    const md = (await get()).doc.sections.find((s) => s.id === 'try').body_md
    assert.match(md, /src: https:\/\/studio\.example\.ts\.net:8799\/demo\/voice\//, 'https demos are left as they are')
    const refs = [...md.matchAll(/^(src|poster): asset:([0-9a-f]{16}\.(html|webm|png))$/gm)].map((m) => [m[1], m[3]])
    assert.deepEqual(refs, [['src', 'html'], ['src', 'webm'], ['poster', 'png']], md)
    for (const [, id] of md.matchAll(/asset:([0-9a-f]{16}\.\w+)/g)) assert.equal((await raw(`/api/scope/demo/assets/${id}`, { headers: human })).status, 200, id)
    writeFileSync(join(work, 'missing.md'), ['```video', 'src: nowhere.mp4', '```', 'Figure: Gone.'].join('\n'))
    assert.equal((await cli('scope', 'patch', 'demo', 'try', '--from', join(work, 'missing.md'))).status, 1, 'a missing local file stops before publishing')
  } finally { await h.close() }
})
