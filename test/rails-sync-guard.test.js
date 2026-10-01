// Owner: Opus (unblock on rails S3 fix round, 2026-10-01). Implementers make it pass and never edit it.
// Review findings (Sonnet, diff 459a230d): an agent holding the daemon bearer could mark a human-only ask answered
// "from Rails"; and a hosted answer the daemon failed to take was collected in Rails and then lost.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const state = mkdtempSync(join(tmpdir(), 'unblock-rails-guard-'))
Object.assign(process.env, {
  UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: join(state, 'config'), UNBLOCK_SECRET_BACKEND: 'env',
  UNBLOCK_PUBLIC_ORIGIN: 'https://studio.tailnet.test:8797',
})
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const { createRailsSync } = await import('../src/rails-sync.js')
const BEARER = 'hosted-test-bearer'
const agentBearer = { Authorization: `Bearer ${loadOrCreateSecret()}` }
let daemon, proxy, hosted, sync, failAnswers = 0, number = 0
const asks = new Map()

function hostedServer() {
  return http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${BEARER}`) { res.writeHead(401); return res.end('{}') }
      const message = JSON.parse(Buffer.concat(chunks))
      const reply = (result, headers = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })) }
      if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'unblock' } }, { 'Mcp-Session-Id': 'sess-1' })
      if (message.id === undefined) { res.writeHead(202); return res.end() }
      const { name, arguments: args } = message.params
      const ok = (data) => reply({ isError: false, structuredContent: { blocks: [{ type: 'text', text: JSON.stringify(data) }] }, content: [{ type: 'text', text: JSON.stringify(data) }] })
      const refuse = (code) => reply({ isError: true, content: [{ type: 'text', text: code }], _meta: { 'so.rails/refusal': { code } }, structuredContent: { code } })
      if (name === 'ask.file') {
        const ticket = `ub_r${args.request_id.replace(/[^A-Za-z0-9]/g, '')}`
        if (!asks.has(ticket)) asks.set(ticket, { ...args, ticket, status: 'open', answers: {}, reply: null })
        return ok({ ticket, state: 'filed', url: null })
      }
      const ask = asks.get(args.ticket)
      if (name === 'queue.list') return ok({ asks: [...asks.values()].filter((a) => !args.status || a.status === args.status) })
      if (!ask) return refuse('not_found')
      if (name === 'ask.check') {
        const seen = { ...ask }
        if (['answered', 'sent_back'].includes(ask.status)) ask.status = 'collected'
        return ok({ asks: [seen] })
      }
      if (name === 'ask.update') { if (ask.status !== 'open') return refuse('invalid_state'); return ok({ ask }) }
      if (name === 'ask.cancel') { if (ask.status !== 'open') return refuse('invalid_state'); ask.status = 'cancelled'; return ok({ ask }) }
      return refuse('unknown_tool')
    })
  })
}

// Sits between the sidecar and the daemon; answers 503 to the next `failAnswers` answer posts (a daemon restart).
function proxyServer() {
  return http.createServer((req, res) => {
    if (failAnswers > 0 && /\/answer$/.test(req.url) && req.method === 'POST') { failAnswers -= 1; req.resume(); res.writeHead(503); return res.end('{}') }
    const upstream = http.request({ host: '127.0.0.1', port: daemon.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers); up.pipe(res)
    })
    req.pipe(upstream)
  })
}

function raw(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method, headers: { ...agentBearer, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks)) } catch {} resolve({ status: res.statusCode, json }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const tried = ['Checked the available tools and could not do it alone.']
async function create(ask) {
  const r = await raw('/api/asks', { method: 'POST', body: { ask: { kind: 'file', project: 'unblock-on-rails', tried, ...ask, title: `${ask.title} ${++number}` }, origin: { agent: 'claude', pane_id: 'w5H:p6' } } })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  return r.json
}
const decision = { purpose: 'decision', only_you: 'judgment', title: 'Launch day', why: 'The post is drafted.',
  fields: [{ name: 'day', label: 'Day', type: 'choice', choices: ['Tuesday', 'Thursday'], recommend: { value: 'Tuesday', why: 'Most readers are in.' } }] }
const spend = { purpose: 'spend', only_you: 'spend', title: 'Pay', why: 'Needed.',
  spend: { item: 'Workspace subscription', vendor: 'Acme', vendor_url: 'https://example.com/checkout', amount_cents: 1500, cap_cents: 2000, currency: 'usd' } }
const hostedFor = (local) => [...asks.values()].find((a) => a.request_id === local.ticket)
const local = async (ticket) => (await raw(`/api/asks/${ticket}`)).json

test.before(async () => {
  daemon = await startDaemon({ port: 0 })
  hosted = hostedServer(); proxy = proxyServer()
  await new Promise((resolve) => hosted.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  sync = createRailsSync({
    daemonOrigin: `http://127.0.0.1:${proxy.address().port}`, daemonToken: loadOrCreateSecret(),
    hostedUrl: `http://127.0.0.1:${hosted.address().port}/mcp`, accessToken: async () => BEARER,
    statePath: join(state, 'rails-sync.json'), host: 'studio',
  })
})
test.after(async () => { await daemon.close(); hosted.close(); proxy.close(); rmSync(state, { recursive: true, force: true }) })

test('an agent holding only the daemon bearer cannot answer or send back an ask as Rails', async () => {
  const pay = await create(spend)
  const forged = await raw(`/api/asks/${pay.ticket}/answer`, { method: 'POST', body: { revision: pay.revision, values: { verdict: 'approve' }, via: 'rails' } })
  assert.notEqual(forged.status, 200, JSON.stringify(forged.json))
  assert.equal((await local(pay.ticket)).status, 'open', 'a human-only ask stays open')
  const day = await create(decision)
  const claimed = await raw(`/api/asks/${day.ticket}/answer`, { method: 'POST', body: { revision: day.revision, bounce: true, reply: 'Not this one.', via: 'rails' } })
  const after = await local(day.ticket)
  assert.ok(claimed.status !== 200 || !/^rails\b/.test(String(after.answered_via)), `answered_via=${after.answered_via}`)
})

test('a hosted answer the daemon cannot take yet is applied on a later run, not lost', async () => {
  const ask = await create(decision)
  await sync.once()
  Object.assign(hostedFor(ask), { status: 'answered', answers: { day: 'Thursday' }, reply: null })
  failAnswers = 1
  await sync.once().catch(() => {})
  assert.equal(hostedFor(ask).status, 'collected', 'the stand-in marks it collected on the first read')
  await sync.once()
  const after = await local(ask.ticket)
  assert.equal(after.status, 'answered', JSON.stringify(after))
  assert.equal(after.answers.day, 'Thursday')
  assert.match(String(after.answered_via), /^rails\b/)
})

test('an answer the daemon refuses does not wedge later runs', async () => {
  const bad = await create(decision)
  const good = await create(decision)
  await sync.once()
  Object.assign(hostedFor(bad), { status: 'answered', answers: { day: 'Someday' } })
  await sync.once()
  await sync.once()
  Object.assign(hostedFor(good), { status: 'answered', answers: { day: 'Tuesday' } })
  await sync.once()
  assert.equal((await local(good.ticket)).status, 'answered')
})

test('a damaged state file does not stop the sync', async () => {
  writeFileSync(join(state, 'rails-sync.json'), '{"asks": ')
  const ask = await create(decision)
  await sync.once()
  assert.ok(hostedFor(ask), 'the new ask is still mirrored')
})
