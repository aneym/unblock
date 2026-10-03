// PM scenario for p0M DG2u (scope rails-rooms Block G, DG2 comments inside embeds), written by the Opus spec author;
// the implementer may not edit it. Story: Rails shows a scope doc as a tab and puts each HTML demo in an iframe served
// by this daemon. Alex selects text inside the demo to comment on it. The embed bridge today answers only a parent on
// the daemon's own origin, so Rails never hears the selection. A Rails origin the owner configured (config file key
// rails_origins, or UNBLOCK_RAILS_ORIGINS) becomes an accepted parent; nothing else does, and the unblock page keeps
// working as before. Boundaries: the real daemon over a temp scoping root (scope-harness.js) serves the asset; the
// served bridge script runs in a node:vm context with a fake window/parent (as in scope-embed-anchor.test.js).
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { applyConfig } from '../src/config.js'
import { human, startScopeHarness } from './scope-harness.js'

const DAEMON = 'https://studio.example.ts.net:8797'
const RAILS = 'https://rails.example'
const scope = {
  version: 2, slug: 'demo-embed', title: 'Demo embed', pane: 'w5H:pT2', revision: 1, updated_at: '2026-10-03T18:00:00.000Z',
  doc: { sections: [{ id: 'title', heading: 'Demo embed', body_md: 'A demo.' }] }, threads: [],
}

// Run a served HTML asset's bridge script the way a sandboxed iframe would: its URL origin is the daemon's.
function runBridge(html) {
  const script = html.match(/<script>\(\(\) => \{ const fold[\s\S]*<\/script>$/)?.[0]
  assert.ok(script, 'the served HTML ends with the embed bridge')
  const replies = [], listeners = {}
  const parent = { postMessage: (data, origin) => replies.push({ data, origin }) }
  const text = { nodeType: 3, data: 'Workspace\nInvite teammates\nContinue', get length() { return this.data.length } }
  const document = { body: { nodeType: 1, tagName: 'BODY', matches: () => false, childNodes: [text] }, addEventListener() {}, createRange: () => ({ setStart() {}, setEnd() {} }) }
  const context = { parent, location: { origin: DAEMON }, document, window: { addEventListener: (name, fn) => { listeners[name] = fn } }, setTimeout, clearTimeout }
  vm.runInNewContext(script.replace(/^<script>|<\/script>$/g, ''), context)
  const send = (data, origin, source = parent) => listeners.message({ source, origin, data: { type: 'rails-embed', ...data } })
  return { replies, send, parent }
}

async function servedDemo(railsOrigins) {
  if (railsOrigins === undefined) delete process.env.UNBLOCK_RAILS_ORIGINS
  else process.env.UNBLOCK_RAILS_ORIGINS = railsOrigins
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
    const up = await raw('/api/scope/demo-embed/assets', { method: 'POST', headers: { ...h.bearer, 'Content-Type': 'text/html' }, body: Buffer.from('<!doctype html><title>Invite</title><p>Workspace</p><p>Invite teammates</p><p>Continue</p>') })
    assert.ok([200, 201].includes(up.status), `upload: ${up.buf}`)
    const page = await raw(`/api/scope/demo-embed/assets/${up.json.id}`, { headers: human })
    assert.equal(page.status, 200)
    return page.buf.toString('utf8')
  } finally {
    await h.close()
    delete process.env.UNBLOCK_RAILS_ORIGINS
  }
}

test('a configured Rails origin can drive the demo bridge and hears selections; the token still gates every command', async () => {
  const bridge = runBridge(await servedDemo(RAILS))
  bridge.send({ action: 'init', token: 'cap-rails' }, RAILS)
  assert.equal(bridge.replies.length, 1, 'the Rails parent is answered')
  assert.equal(bridge.replies[0].origin, RAILS, 'replies go to the Rails origin, never "*"')
  assert.deepEqual([bridge.replies[0].data.action, bridge.replies[0].data.token], ['ready', 'cap-rails'])

  bridge.send({ action: 'match', token: 'wrong', anchors: [] }, RAILS)
  assert.equal(bridge.replies.length, 1, 'a wrong token is ignored')
  bridge.send({ action: 'match', token: 'cap-rails', anchors: [{ id: 'T1', anchor: { quote: 'Invite teammates', prefix: 'Workspace', suffix: 'Continue' } }] }, RAILS)
  assert.equal(bridge.replies[1].origin, RAILS)
  assert.equal(bridge.replies[1].data.matches[0].found, true, 'Rails can place comment highlights inside the demo')
})

test('origins nobody configured stay refused, a non-parent window stays refused, and the unblock page still works', async () => {
  const html = await servedDemo(RAILS)
  const other = runBridge(html)
  other.send({ action: 'init', token: 'cap' }, 'https://evil.example')
  other.send({ action: 'init', token: 'cap' }, RAILS, {})
  assert.equal(other.replies.length, 0)

  const own = runBridge(html)
  own.send({ action: 'init', token: 'cap-own' }, DAEMON)
  assert.equal(own.replies[0]?.origin, DAEMON, 'the scope page on the daemon origin is answered as before')

  const unconfigured = runBridge(await servedDemo(undefined))
  unconfigured.send({ action: 'init', token: 'cap' }, RAILS)
  assert.equal(unconfigured.replies.length, 0, 'without configuration Rails is refused (the default is no extra parents)')
})

test('the config file key rails_origins fills UNBLOCK_RAILS_ORIGINS with clean https origins only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unblock-rails-origins-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify({ rails_origins: ['https://rails.example', 'https://app.rails.example/', 'http://plain.example', 'https://*.example', 'https://x.example/path'] }))
  const env = {}
  applyConfig({ env, path })
  assert.equal(env.UNBLOCK_RAILS_ORIGINS, 'https://rails.example,https://app.rails.example')

  writeFileSync(path, JSON.stringify({ rails_origins: ['http://plain.example'] }))
  const none = {}
  applyConfig({ env: none, path })
  assert.equal(none.UNBLOCK_RAILS_ORIGINS, undefined, 'nothing valid means nothing set')
})
