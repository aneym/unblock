// Owner: Opus (visual review, 2026-10-08). Alex: "have the deck up so i can see full visual, ... highlight visuals and you see it".
// Integration: imports real images through the CLI, posts human comments over HTTP, and checks the lane delivery.
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { anchorInSection, slidesOf, validateScope } from '../src/scope-doc.js'
import { normalizeAnchor } from '../src/scope-anchor.js'
import { human, startScopeHarness } from './scope-harness.js'
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]))); return Buffer.concat([head, data, crc]) }
// A real 2x1 RGB PNG, with location metadata in a tEXt, an iTXt (XMP) and an eXIf chunk when asked.
function png({ gps = false, salt = 0 } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2
  const idat = Buffer.from('78da63f8cfc0f01f0005fe02fe', 'hex')
  const meta = gps ? [chunk('tEXt', Buffer.from('Location\x0040.7128 N, 74.0060 W')), chunk('iTXt', Buffer.from('XML:com.adobe.xmp\x00\x00\x00\x00\x00<x:xmpmeta><exif:GPSLatitude>40,42.77N</exif:GPSLatitude></x:xmpmeta>')), chunk('eXIf', Buffer.from('MM\x00\x2a\x00\x00\x00\x08GPSLatitude 40.7128'))] : []
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...meta, chunk('tIME', Buffer.from([7, 234, 9, 30, 15, 0, salt])), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

test('visual slides import, spatial comments, crops and quote compatibility', async () => {
  const h = await startScopeHarness({ version: 2, slug: 'vis', title: 'Vis', kind: 'visual', pane: 'w5H:pT1', revision: 1, updated_at: '2026-10-08T12:00:00Z', doc: { sections: [{ id: 'title', heading: 'Vis', body_md: 'Deck for review.' }] }, threads: [] })
  const cli = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'bin/unblock.js'), 'scope', ...args], { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
    let stdout = '', stderr = ''
    child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }))
  })
  const raw = (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path, ...options }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks) }))
    }); req.on('error', reject); req.end(options.body)
  })
  const get = async () => (await h.request('/api/scope/vis', { headers: human })).json.scope
  const post = anchor => h.request('/api/scope/vis/threads', { method: 'POST', headers: human, body: { anchor, text: 'This chart is unclear' } })
  try {
    const dir = join(process.env.UNBLOCK_SCOPING_DIR, 'input'); mkdirSync(dir)
    writeFileSync(join(dir, '01-cover.png'), png({ salt: 1 })); writeFileSync(join(dir, '02-market.png'), png({ salt: 2 }))
    const imported = await cli('slides', 'vis', '--from', dir, '--json')
    assert.equal(imported.code, 0, imported.stderr); assert.equal(JSON.parse(imported.stdout).revision, 2)
    const scope = await get()
    assert.deepEqual(scope.doc.sections.map(s => s.id), ['title', 'slide-1', 'slide-2'])
    assert.deepEqual(scope.doc.sections.map(s => s.heading), ['Vis', 'Cover', 'Market'])
    assert.equal(slidesOf(scope).length, 2)
    for (const slide of slidesOf(scope)) assert.ok(scope.doc.assets[slide.image])
    const upload = await raw('/api/scope/vis/assets', { method: 'POST', headers: { ...human, 'Content-Type': 'image/png' }, body: png({ salt: 7 }) })
    assert.equal(upload.status, 201)
    const crop = JSON.parse(upload.bytes.toString()).id, rect = { x: .1, y: .2, w: .5, h: .25 }
    const anchor = { section: 'slide-2', quote: 'whatever', prefix: '', suffix: '', rect, crop }
    const posted = await post(anchor); assert.equal(posted.status, 201, posted.text)
    const thread = posted.json.thread
    assert.deepEqual(thread.anchor, { section: 'slide-2', quote: 'Market', prefix: '', suffix: '', rect, crop })
    for (const invalid of [{ ...anchor, section: 'title' }, { ...anchor, rect: { ...rect, w: 0 } }, { ...anchor, crop: '0000000000000000.png' }, { section: 'slide-2', quote: 'Market', crop }]) assert.equal((await post(invalid)).status, 400)
    const quote = anchorInSection(scope.doc.sections[0], 'Deck for review')
    const quoted = await post(quote); assert.equal(quoted.status, 201)
    assert.deepEqual(quoted.json.thread.anchor, normalizeAnchor(quote)); assert.ok(!('rect' in quoted.json.thread.anchor))
    const normalized = normalizeAnchor({ section: 'title', quote: 'x', prefix: '', suffix: '' })
    assert.ok(!('rect' in normalized)); assert.ok(!('crop' in normalized))
    const comments = await cli('comments', 'vis', '--json'); assert.equal(comments.code, 0, comments.stderr)
    const region = JSON.parse(comments.stdout).threads.find(t => t.id === thread.id)
    assert.equal(region.anchor.section, 'slide-2'); assert.deepEqual(region.anchor.rect, rect)
    assert.ok(existsSync(region.crop_path))
    const image = await raw(`/api/scope/vis/assets/${crop}`, { headers: human })
    assert.deepEqual(readFileSync(region.crop_path), image.bytes)
    const text = await cli('comments', 'vis'); assert.equal(text.code, 0, text.stderr)
    for (const part of ['slide-2', '[region x=10% y=20% w=50% h=25%]', `[crop: ${region.crop_path}]`, '"Deck for review"']) assert.ok(text.stdout.includes(part), text.stdout)
    await h.until(() => h.paneLines().includes('[crop: ' + region.crop_path))
    assert.ok(h.paneLines().includes('on slide §Market [region x=10% y=20% w=50% h=25%]'))
    assert.deepEqual(validateScope(await get()), [])
  } finally { await h.close() }
})
