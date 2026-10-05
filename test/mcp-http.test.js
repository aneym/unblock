import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import { request } from 'node:http'
import test from 'node:test'

// Real daemon + stdio boundaries: transport parity, request-scoped identity,
// and browser-write rejection. Existing API tests cannot reach /mcp.
test('daemon MCP HTTP shares stdio tools and isolates request identity', { timeout: 20000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'unblock-mcp-http-'))
  process.env.UNBLOCK_STATE_DIR = state
  process.env.UNBLOCK_CONFIG_DIR = join(state, 'config')
  process.env.UNBLOCK_SECRET_BACKEND = 'env'
  process.env.UNBLOCK_LIVEDOC_APPROVALS = '0'
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = 'test-relay'
  process.env.HERDR_PANE_ID = 'daemon-pane-must-not-leak'
  process.env.HERDR_SESSION_ID = 'daemon-session-must-not-leak'
  process.env.UNBLOCK_PROJECT = 'daemon-project-must-not-leak'
  const { startDaemon } = await import('../src/daemon.js')
  const daemon = await startDaemon({ port: 0 })
  t.after(async () => { await daemon.close(); rmSync(state, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${daemon.port}`
  const child = spawn(process.execPath, ['src/mcp.js'], { cwd: new URL('..', import.meta.url), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const pending = new Map()
  const lines = readline.createInterface({ input: child.stdout })
  t.after(() => lines.close())
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  let id = 0
  function stdio(method, params = {}) {
    const requestId = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stdio ${method} timed out`)), 5000)
      pending.set(requestId, (message) => { clearTimeout(timer); resolve(message) })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
    })
  }
  async function http(method, params = {}, headers = {}) {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    assert.equal(response.status, 200)
    const message = await response.json()
    assert.equal(message.error, undefined, JSON.stringify(message.error))
    return message.result
  }
  const identity = { 'X-Herdr-Pane': 'pane-one', 'X-Claude-Session': 'claude-one', 'X-Herdr-Session': 'herdr-one', 'X-Unblock-Project': 'http-project' }
  assert.deepEqual(await http('initialize', { capabilities: {}, protocolVersion: '2025-06-18' }, identity), (await stdio('initialize', { capabilities: {} })).result)
  assert.deepEqual(await http('tools/list', {}, identity), (await stdio('tools/list')).result)
  const filed = await http('tools/call', { name: 'unblock_file', arguments: {
    title: 'HTTP identity test', why: 'A human must answer.', only_you: 'message', tried: ['Checked available tools.'],
    fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true }],
  } }, identity)
  const ticket = filed.structuredContent.ticket
  const peek = { name: 'unblock_peek', arguments: { ticket } }
  const httpPeek = await http('tools/call', peek, identity)
  assert.deepEqual(httpPeek, (await stdio('tools/call', peek)).result)
  assert.equal(httpPeek.structuredContent.ask.origin.pane_id, 'pane-one')
  assert.equal(httpPeek.structuredContent.ask.origin.session_id, 'herdr-one')
  assert.equal(httpPeek.structuredContent.ask.project, 'http-project')
  const fallback = await http('tools/call', { name: 'unblock_file', arguments: {
    title: 'Claude session fallback', why: 'A human must answer.', only_you: 'message', tried: ['Checked available tools.'],
    fields: [{ name: 'answer', type: 'text', label: 'Answer', required: true }],
  } }, { 'X-Claude-Session': 'claude-fallback' })
  const fallbackPeek = await http('tools/call', { name: 'unblock_peek', arguments: { ticket: fallback.structuredContent.ticket } })
  assert.equal(fallbackPeek.structuredContent.ask.origin.session_id, 'claude-fallback')
  assert.equal(fallbackPeek.structuredContent.ask.origin.pane_id, undefined)
  assert.notEqual(fallbackPeek.structuredContent.ask.project, 'daemon-project-must-not-leak')
  const auth = JSON.parse(readFileSync(join(state, 'daemon.json'), 'utf8')).auth
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }
  await fetch(`${base}/api/asks/${ticket}/draft`, { method: 'POST', signal: AbortSignal.timeout(5000), headers, body: JSON.stringify({ reply: 'Typing an answer' }) })
  const check = { name: 'unblock_check', arguments: {} }
  const [mine, other, missing] = await Promise.all([
    http('tools/call', check, identity),
    http('tools/call', check, { 'X-Herdr-Pane': 'pane-two', 'X-Claude-Session': 'claude-two' }),
    http('tools/call', check),
  ])
  assert.equal(mine.structuredContent.open[0].ticket, ticket)
  assert.deepEqual(other.structuredContent.open, [])
  assert.deepEqual(missing.structuredContent.open, [])
  for (const badHeaders of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }, { 'Content-Type': 'text/plain' }]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...badHeaders } }, (res) => { res.resume(); resolve(res.statusCode) })
      req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')))
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(status, badHeaders['Content-Type'] ? 415 : 403)
  }
})
