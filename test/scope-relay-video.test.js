// Owner: Opus (r31, pJ0 TO-pHY-10). Implementers make it pass and never edit it.
// Admin mirrors a scope's assets through the relay. Videos are assets too (mp4 and webm, up to 64 MiB), so the
// relay may read them, in byte ranges, the same as an image. It still reads nothing else.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-video-0123456789abcdefghijklmnopqrstu'
const at = '2026-09-30T04:00:00Z'
const scope = { version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }] }, threads: [] }
const mp4 = (size) => { const b = Buffer.alloc(size, 7); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'ascii'); return b }
const webm = (size) => { const b = Buffer.alloc(size, 9); Buffer.from('1a45dfa3', 'hex').copy(b, 0); return b }

test('the Admin relay reads video assets (mp4, webm) in full and in byte ranges; nothing new beyond that', async () => {
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = RELAY
  const h = await startScopeHarness(scope)
  const relay = { 'X-Unblock-Relay': RELAY }
  const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const buf = Buffer.concat(chunks); let json; try { json = JSON.parse(buf.toString()) } catch {} resolve({ status: res.statusCode, headers: res.headers, buf, json }) })
    })
    req.on('error', reject)
    req.end(body)
  })
  const upload = (body, type) => raw('/api/scope/demo/assets', { method: 'POST', headers: { ...h.bearer, 'Content-Type': type }, body })
  try {
    for (const [body, type] of [[mp4(4096), 'video/mp4'], [webm(4096), 'video/webm']]) {
      const up = await upload(body, type)
      assert.equal(up.status, 201, up.buf.toString())
      const path = `/api/scope/demo/assets/${up.json.id}`
      const full = await raw(path, { headers: relay })
      assert.equal(full.status, 200, `${type}: ${full.buf.toString().slice(0, 200)}`)
      assert.equal(full.buf.length, 4096)
      assert.equal(full.headers['content-type'], type)
      const part = await raw(path, { headers: { ...relay, Range: 'bytes=10-20' } })
      assert.equal(part.status, 206, `${type} range`)
      assert.equal(part.buf.length, 11)
    }
    // Still refused: a video upload (r40, 2026-09-30: the relay uploads Alex's raster pictures only, so 415), a non-asset path under the scope, another slug's style of path.
    assert.equal((await raw('/api/scope/demo/assets', { method: 'POST', headers: { ...relay, 'Content-Type': 'video/mp4' }, body: mp4(64) })).status, 415)
    assert.equal((await raw('/api/scope/demo/assets/0123456789abcdef.mov', { headers: relay })).status, 403)
    assert.equal((await raw('/api/scope/demo/assets/0123456789abcdef.webm/x', { headers: relay })).status, 403)
  } finally { await h.close(); delete process.env.UNBLOCK_ADMIN_RELAY_TOKEN }
})
