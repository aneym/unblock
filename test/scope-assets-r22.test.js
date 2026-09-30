// Owner: Opus (r22, r11 review advisories on assets). Implementers make it pass and never edit it.
// A range that starts past the end of an asset is unsatisfiable, however large its number: 416, never the whole
// file. An HTML demo's CSP forbids form submissions to anywhere (form-action 'none'), so a demo can't post out.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-30T01:00:00Z'
const scope = { version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }] }, threads: [] }
const mp4 = (size) => { const b = Buffer.alloc(size, 7); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'ascii'); return b }

test('huge range starts are 416; HTML demos cannot submit forms out', async () => {
  const h = await startScopeHarness(scope)
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
    const clip = await upload(mp4(4096), 'video/mp4')
    assert.equal(clip.status, 201, clip.buf.toString())
    const path = `/api/scope/demo/assets/${clip.json.id}`
    for (const start of ['99999999999999999999', '9007199254740993', '4096']) {
      const res = await raw(path, { headers: { ...human, Range: `bytes=${start}-` } })
      assert.equal(res.status, 416, `bytes=${start}-`)
      assert.equal(res.headers['content-range'], 'bytes */4096')
      assert.equal(res.buf.length, 0)
    }
    assert.equal((await raw(path, { headers: { ...human, Range: 'bytes=10-20' } })).status, 206, 'normal ranges still work')
    assert.equal((await raw(path, { headers: { ...human, Range: 'bytes=20-10' } })).status, 200, 'a backwards range is ignored')
    const demo = await upload(Buffer.from('<!doctype html><form action="https://evil.example/"><button>Go</button></form>'), 'text/html')
    assert.equal(demo.status, 201)
    const csp = (await raw(`/api/scope/demo/assets/${demo.json.id}`, { headers: human })).headers['content-security-policy']
    assert.match(csp, /form-action 'none'/, csp)
    assert.match(csp, /^sandbox allow-scripts allow-forms;/, 'the rest of the demo CSP is unchanged')
  } finally { await h.close() }
})
