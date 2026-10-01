// Owner: Opus (unblock on rails S3, 2026-10-01). Implementers make it pass and never edit it.
// Alex (2026-10-01 ~12:02 ET): "full migration of our unblock system to be actually hosted on rails ... and the
// unblock workspace to be a culmination of entries from all our agents, of course tied to projects."
// Step one: the Studio daemon mirrors every open ask into hosted Unblock (unblock.rails.so/mcp, the owner's own
// OAuth client), and an answer or send-back given in hosted Unblock comes back to the daemon, which wakes the
// agent the way a local answer does. Asks with a secret field stay local for now.
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const state = mkdtempSync(join(tmpdir(), 'unblock-rails-sync-'))
Object.assign(process.env, {
  UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: join(state, 'config'), UNBLOCK_SECRET_BACKEND: 'env',
  UNBLOCK_PUBLIC_ORIGIN: 'https://studio.tailnet.test:8797',
})
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const { createRailsSync } = await import('../src/rails-sync.js')
const BEARER = 'hosted-test-bearer'
const bearer = { Authorization: `Bearer ${loadOrCreateSecret()}` }
let daemon, hosted, sync, number = 0

// A stand-in for hosted Unblock's public MCP: the session handshake, the bearer, and the tool results in the
// shape the real rail returns (result.structuredContent.blocks[0].text is the tool's JSON).
const asks = new Map()
const calls = []
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
      if (req.headers['mcp-session-id'] !== 'sess-1') { res.writeHead(404); return res.end('{}') }
      const { name, arguments: args } = message.params
      calls.push({ name, args })
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
      if (name === 'ask.update') { if (ask.status !== 'open') return refuse('invalid_state'); Object.assign(ask, { why: args.why ?? ask.why, fields: args.replace_fields ?? ask.fields }); return ok({ ask }) }
      if (name === 'ask.cancel') { if (ask.status !== 'open') return refuse('invalid_state'); ask.status = 'cancelled'; ask.reason = args.reason; return ok({ ask }) }
      return refuse('unknown_tool')
    })
  })
}

function raw(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method, headers: { ...bearer, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks)) } catch {} resolve({ status: res.statusCode, json }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const tried = ['Checked the available tools and could not do it alone.']
const origin = { agent: 'claude', pane_id: 'w5H:p6', session_id: 'sess-local' }
async function create(ask) {
  const r = await raw('/api/asks', { method: 'POST', body: { ask: { kind: 'file', project: 'unblock-on-rails', tried, ...ask, title: `${ask.title} ${++number}` }, origin } })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  return r.json
}
const decision = { purpose: 'decision', only_you: 'judgment', title: 'Launch day', why: 'The post is drafted.',
  fields: [{ name: 'day', label: 'Day', type: 'choice', choices: ['Tuesday', 'Thursday'], recommend: { value: 'Tuesday', why: 'Most readers are in.' } }] }
const question = { purpose: 'question', only_you: 'judgment', title: 'Region', why: 'The deploy needs a region.',
  fields: [{ name: 'region', label: 'Region', type: 'choice', choices: [{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }] }] }
const secret = { purpose: 'blocker', title: 'Key', why: 'The service needs its key.', only_you: 'credential',
  links: [{ label: 'API keys', url: 'https://dashboard.example.test/keys' }], fields: [{ name: 'api_key', label: 'API key', type: 'secret', env_name: 'SERVICE_API_KEY' }] }
const hostedFor = (local) => [...asks.values()].find((a) => a.request_id === local.ticket)
const local = async (ticket) => (await raw(`/api/asks/${ticket}`)).json

test.before(async () => {
  daemon = await startDaemon({ port: 0 })
  hosted = hostedServer()
  await new Promise((resolve) => hosted.listen(0, '127.0.0.1', resolve))
  sync = createRailsSync({
    daemonOrigin: `http://127.0.0.1:${daemon.port}`, daemonToken: loadOrCreateSecret(),
    hostedUrl: `http://127.0.0.1:${hosted.address().port}/mcp`, accessToken: async () => BEARER,
    statePath: join(state, 'rails-sync.json'), host: 'studio',
  })
})
test.after(async () => { await daemon.close(); hosted.close(); rmSync(state, { recursive: true, force: true }) })

test('an open ask is filed in hosted Unblock once, with its project and who filed it', async () => {
  const ask = await create(decision)
  await sync.once()
  await sync.once()
  const filed = [...asks.values()].filter((a) => a.request_id === ask.ticket)
  assert.equal(filed.length, 1, 'one hosted ask per local ask, however often the sync runs')
  const [mirror] = filed
  assert.equal(mirror.purpose, 'decision')
  assert.equal(mirror.project, 'unblock-on-rails')
  assert.ok(mirror.title.startsWith('Launch day'), mirror.title)
  assert.equal(mirror.fields[0].recommend.value, 'Tuesday')
  assert.deepEqual({ agent: mirror.from?.agent, pane: mirror.from?.pane, host: mirror.from?.host }, { agent: 'claude', pane: 'w5H:p6', host: 'studio' })
  assert.ok(mirror.links.some((link) => link.url.startsWith('https://studio.tailnet.test:8797')), 'a way back to the Studio page')
})

test('an answer given in hosted Unblock lands on the daemon as answered from Rails', async () => {
  const ask = await create(decision)
  await sync.once()
  Object.assign(hostedFor(ask), { status: 'answered', answers: { day: 'Thursday' }, reply: 'Thursday is quieter.' })
  await sync.once()
  const after = await local(ask.ticket)
  assert.equal(after.status, 'answered', JSON.stringify(after))
  assert.equal(after.answers.day, 'Thursday')
  assert.match(String(after.answered_via), /^rails\b/)
  await sync.once()
  assert.equal(calls.filter((c) => c.name === 'ask.cancel' && c.args.ticket === hostedFor(ask).ticket).length, 0, 'an ask answered in Rails is not cancelled back')
})

test('a send-back in hosted Unblock sends the ask back to the agent with the note', async () => {
  const ask = await create(decision)
  await sync.once()
  Object.assign(hostedFor(ask), { status: 'sent_back', reply: 'Ask about the date, not the day.' })
  await sync.once()
  const after = await local(ask.ticket)
  assert.equal(after.status, 'bounced', JSON.stringify(after))
  assert.equal(after.reply, 'Ask about the date, not the day.')
})

test('an ask cancelled on Studio is cancelled in hosted Unblock', async () => {
  const ask = await create(question)
  await sync.once()
  assert.equal(hostedFor(ask).purpose, 'question')
  const cancelled = await raw(`/api/asks/${ask.ticket}/cancel`, { method: 'POST', body: { note: 'Settled in chat.' } })
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json))
  await sync.once()
  assert.equal(hostedFor(ask).status, 'cancelled')
})

test('an ask with a secret field stays on Studio', async () => {
  const ask = await create(secret)
  await sync.once()
  assert.equal(hostedFor(ask), undefined)
})
