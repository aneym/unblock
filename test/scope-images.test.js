// Owner: Opus (r40, images in comments). Implementers copy it to test/ and make it pass; they never edit it.
// Alex (2026-09-30 09:34 ET): "scoping comments should support images pasted in btw and rendered nicely."
// Alex (and the Admin relay) upload raster images to the scope's assets; the daemon strips location metadata
// (EXIF, XMP, PNG text) before it hashes and stores them. A comment, reply, rejection or resolve carries up to six
// image ids; a comment or reply may be only images. The lane sees a local file path for each image in the note it
// gets, and in `scope notes`, so it can Read the picture.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-img-0123456789abcdefghijklmnopqrstuv'
const at = '2026-09-30T15:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We ship the inbox first. Then the review. The runner is Executor.' },
]
const on = (quote) => anchorInSection(sections[1], quote)
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: on('The runner is Executor'), author: 'agent', kind: 'question', status: 'open', recommendation: 'Executor', messages: [{ from: 'agent', text: 'Which runner?', at }], created_at: at },
    { id: 'T2', anchor: on('Then the review'), author: 'alex', kind: 'comment', status: 'open', messages: [{ from: 'alex', text: 'Who reviews?', at }], created_at: at },
    { id: 'T3', anchor: on('We ship the inbox first'), author: 'agent', kind: 'question', status: 'open', recommendation: 'Inbox first', messages: [{ from: 'agent', text: 'Inbox or drafts first?', at }], created_at: at },
  ],
}

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
// A JPEG whose APP1 holds EXIF with GPS and a second APP1 with XMP; the SOF says 640x480.
function jpeg() {
  const seg = (marker, data) => { const len = Buffer.alloc(2); len.writeUInt16BE(data.length + 2); return Buffer.concat([Buffer.from([0xff, marker]), len, data]) }
  const sof = Buffer.from([8, 0x01, 0xe0, 0x02, 0x80, 1, 1, 0x11, 0])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1')),
    seg(0xe1, Buffer.from('Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08GPSLatitude 40.7128 GPSLongitude 74.0060', 'latin1')),
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\x00<exif:GPSLatitude>40,42.77N</exif:GPSLatitude>', 'latin1')),
    seg(0xc0, sof), seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0x56]), Buffer.from([0xff, 0xd9])])
}
// A WebP with VP8X (EXIF and XMP flags set), an EXIF chunk, an XMP chunk and a VP8L frame; canvas 300x200.
function webp() {
  const c = (type, data) => { const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]) }
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04; vp8x.writeUIntLE(299, 4, 3); vp8x.writeUIntLE(199, 7, 3)
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f; vp8l.writeUInt32LE((299) | (199 << 14), 1)
  const body = Buffer.concat([Buffer.from('WEBP'), c('VP8X', vp8x), c('EXIF', Buffer.from('MM\x00\x2aGPSLatitude 40.7128')), c('XMP ', Buffer.from('<exif:GPSLatitude>40,42.77N</exif:GPSLatitude>')), c('VP8L', vp8l)])
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')

test('images in comments: Alex pastes a picture, location is stripped, the lane gets a path it can read', async () => {
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = RELAY
  const h = await startScopeHarness(scope)
  const { request, until, bearer } = h
  const relay = { 'X-Unblock-Relay': RELAY }
  const herdr = process.env.HERDR_BIN_PATH
  const postLog = join(dirname(herdr), 'lane-post.log'), postBin = join(dirname(herdr), 'lane-post-stub')
  writeFileSync(postBin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\x1f' "$a" >> '${postLog}'; done\nprintf '\\n' >> '${postLog}'\n`)
  chmodSync(postBin, 0o700)
  process.env.UNBLOCK_LANE_POST_BIN = postBin
  const posted = () => existsSync(postLog) ? readFileSync(postLog, 'utf8') : ''
  const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const buf = Buffer.concat(chunks); let json; try { json = JSON.parse(buf.toString()) } catch {} resolve({ status: res.statusCode, headers: res.headers, buf, json }) })
    })
    req.on('error', reject)
    req.end(body)
  })
  const upload = (body, type, headers = human) => raw('/api/scope/demo/assets', { method: 'POST', headers: { ...headers, 'Content-Type': type }, body })
  const served = async (id) => (await raw(`/api/scope/demo/assets/${id}`, { headers: human })).buf
  const get = async () => (await request('/api/scope/demo', { headers: human })).json
  const thread = async (id) => (await get()).scope.threads.find((t) => t.id === id)
  const post = (path, body, headers = human) => request(`/api/scope/demo/${path}`, { method: 'POST', headers, body })
  try {
    // 1. Alex uploads a PNG with location in it: 201, sized, and the stored bytes carry no location.
    const shot = await upload(png({ gps: true }), 'image/png')
    assert.equal(shot.status, 201, shot.buf.toString())
    assert.match(shot.json.id, /^[0-9a-f]{16}\.png$/)
    assert.deepEqual([shot.json.type, shot.json.width, shot.json.height], ['image', 2, 1])
    let bytes = await served(shot.json.id)
    for (const bad of ['tEXt', 'iTXt', 'eXIf', 'GPS', '40.7128']) assert.ok(!bytes.includes(bad), `PNG still has ${bad}`)
    for (const kept of ['IHDR', 'IDAT', 'IEND', 'tIME']) assert.ok(bytes.includes(kept), `PNG lost ${kept}`)
    // The same picture without the location is the same asset (stripped before hashing).
    assert.equal((await upload(png(), 'image/png')).json.id, shot.json.id)

    // JPEG: both APP1 segments (EXIF and XMP) are gone; the frame and scan data are intact.
    const photo = await upload(jpeg(), 'image/jpeg')
    assert.equal(photo.status, 201, photo.buf.toString())
    assert.deepEqual([photo.json.width, photo.json.height], [640, 480])
    bytes = await served(photo.json.id)
    for (const bad of ['Exif', 'GPS', 'ns.adobe.com']) assert.ok(!bytes.includes(bad), `JPEG still has ${bad}`)
    assert.ok(bytes.includes('JFIF') && bytes.includes(Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9])))

    // WebP: EXIF and XMP chunks are gone, their VP8X flags are cleared and the RIFF size still adds up.
    const web = await upload(webp(), 'image/webp')
    assert.equal(web.status, 201, web.buf.toString())
    assert.deepEqual([web.json.width, web.json.height], [300, 200])
    bytes = await served(web.json.id)
    for (const bad of ['EXIF', 'XMP ', 'GPS']) assert.ok(!bytes.includes(bad), `WebP still has ${bad}`)
    assert.equal(bytes.readUInt32LE(4), bytes.length - 8)
    assert.equal(bytes[20] & 0x0c, 0)

    const gif = await upload(GIF, 'image/gif')
    assert.equal(gif.status, 201)

    // Humans upload raster images only, within 8 MiB; a picture the daemon can't walk is refused.
    assert.equal((await upload(SVG, 'image/svg+xml')).status, 415)
    assert.equal((await upload(Buffer.from('<!doctype html><h1>x</h1>'), 'text/html')).status, 415)
    assert.equal((await upload(Buffer.from('....ftypisom'), 'video/mp4')).status, 415)
    assert.equal((await upload(Buffer.concat([png().subarray(0, 40), Buffer.from('garbage')]), 'image/png')).status, 400)
    assert.equal((await upload(Buffer.alloc(9 * 1024 * 1024, 1), 'image/png')).status, 413)
    // The Admin relay uploads for Alex the same way.
    const viaAdmin = await upload(png({ salt: 9 }), 'image/png', relay)
    assert.equal(viaAdmin.status, 201, viaAdmin.buf.toString())
    // Lanes keep their upload rules (an SVG diagram is fine for a lane).
    const laneSvg = await upload(SVG, 'image/svg+xml', bearer)
    assert.equal(laneSvg.status, 201)

    // 2. A new comment with a picture and words. The message carries the image, sized.
    const anchor = on('We ship the inbox first')
    let r = await post('threads', { anchor, text: 'This screen is off', images: [shot.json.id], client_id: 'img-1' })
    assert.equal(r.status, 201, r.text)
    const created = r.json.thread
    assert.deepEqual(created.messages[0].images, [{ id: shot.json.id, width: 2, height: 1 }])

    // A reply that is only pictures (no words) is fine; the order he pasted them in is kept.
    r = await post('threads/T2/reply', { text: '', images: [photo.json.id, web.json.id], client_id: 'img-2' })
    assert.equal(r.status, 200, r.text)
    let t2 = await thread('T2')
    assert.equal(t2.messages.at(-1).text, '')
    assert.deepEqual(t2.messages.at(-1).images.map((i) => i.id), [photo.json.id, web.json.id])
    // A reply with neither words nor pictures is still refused.
    assert.equal((await post('threads/T2/reply', { text: '  ', images: [] })).status, 400)

    // A rejection and a resolve can carry pictures too (the "Something else" answer is a resolve).
    r = await post('threads/T3/reject', { text: 'Drafts look like this now', images: [gif.json.id] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual((await thread('T3')).messages.at(-1).images, [{ id: gif.json.id, width: 1, height: 1 }])
    r = await post('threads/T1/resolve', { how: 'own', decision: 'Use this runner instead', alex_words: 'Use this runner instead', images: [viaAdmin.json.id] })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual((await thread('T1')).resolution.images.map((i) => i.id), [viaAdmin.json.id])

    // Only this scope's raster images, at most six, by id.
    assert.equal((await post('threads/T2/reply', { text: 'x', images: ['0000000000000000.png'] })).status, 400)
    assert.equal((await post('threads/T2/reply', { text: 'x', images: [laneSvg.json.id] })).status, 400)
    assert.equal((await post('threads/T2/reply', { text: 'x', images: ['../scope.json'] })).status, 400)
    assert.equal((await post('threads/T2/reply', { text: 'x', images: 'nope' })).status, 400)
    assert.equal((await post('threads/T2/reply', { text: 'x', images: Array(7).fill(shot.json.id) })).status, 400)
    // Lanes answer in words; pictures in comments are Alex's.
    assert.equal((await post('threads/T2/reply', { text: 'See this', images: [shot.json.id] }, bearer)).status, 400)

    // 3. The lane can read every picture: each note has local paths, and the lane-post line names them.
    const notes = (await request('/api/scope/demo/notes', { headers: bearer })).json.notes
    const withImages = notes.filter((n) => Array.isArray(n.images) && n.images.length)
    assert.equal(withImages.length, 4, JSON.stringify(notes.map((n) => [n.event, n.images])))
    const reply = withImages.find((n) => n.thread === 'T2')
    assert.equal(reply.images.length, 2)
    for (const [i, path] of reply.images.entries()) {
      assert.ok(path.startsWith('/'), path)
      assert.ok(path.endsWith([photo.json.id, web.json.id][i]), path)
      assert.ok(readFileSync(path).equals(await served([photo.json.id, web.json.id][i])), 'the path holds the stripped picture')
    }
    await until(() => posted().includes(reply.images[1]), 'the lane-post line carries the image path')
    const newNote = withImages.find((n) => n.thread === created.id)
    await until(() => posted().includes(newNote.images[0]), 'the new comment carries its path')
    assert.match(posted(), /This screen is off/)
  } finally { delete process.env.UNBLOCK_LANE_POST_BIN; delete process.env.UNBLOCK_ADMIN_RELAY_TOKEN; await h.close() }
})
