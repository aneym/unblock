// The Rails relay copies scope assets and Rails refuses any whose bytes do not hash to the asset id.
// 2026-10-05: the embed bridge appended to every served HTML asset made each HTML copy fail, so no scope
// with an HTML embed reached Rails Admin (the page showed blank). The relay must get the stored bytes.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-bytes-0123456789abcdefghijklmnopqrstu'
const at = '2026-10-05T15:00:00Z'
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }] }, threads: [],
}

test('relay gets HTML asset bytes that hash to the id; people still get the bridge', async () => {
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = RELAY
  const h = await startScopeHarness(scope)
  const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { const buf = Buffer.concat(chunks); let json; try { json = JSON.parse(buf.toString()) } catch {} resolve({ status: res.statusCode, buf, json }) })
    })
    req.on('error', reject)
    req.end(body)
  })
  try {
    const body = Buffer.from('<!doctype html><title>Demo</title><h1>Demo</h1>')
    const up = await raw('/api/scope/demo/assets', { method: 'POST', headers: { ...h.bearer, 'Content-Type': 'text/html' }, body })
    assert.equal(up.status, 201, up.buf.toString())
    const id = up.json.id
    const relayed = await raw(`/api/scope/demo/assets/${id}`, { headers: { 'X-Unblock-Relay': RELAY } })
    assert.equal(relayed.status, 200)
    assert.ok(relayed.buf.equals(body))
    assert.equal(createHash('sha256').update(relayed.buf).digest('hex').slice(0, 16), id.split('.')[0])
    const viewed = await raw(`/api/scope/demo/assets/${id}`, { headers: human })
    assert.equal(viewed.status, 200)
    assert.ok(viewed.buf.length > body.length, 'people still get the embed bridge')
    assert.equal((await raw(`/api/scope/demo/assets/${id}`, { headers: { 'X-Unblock-Relay': 'wrong-secret-0123456789abcdefghijkl' } })).status, 401)
  } finally {
    await h.close()
  }
})
