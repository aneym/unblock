import assert from 'node:assert/strict'
import http from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const temp = mkdtempSync(join(tmpdir(), 'unblock-scope-'))
const scopes = join(temp, 'scopes')
const demo = join(scopes, 'demo')
const paneLog = join(temp, 'pane.log')
const herdrBin = join(temp, 'herdr-stub')
mkdirSync(demo, { recursive: true })
process.env.UNBLOCK_STATE_DIR = join(temp, 'state')
process.env.UNBLOCK_CONFIG_DIR = join(temp, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
process.env.UNBLOCK_SCOPING_DIR = scopes
process.env.UNBLOCK_SCOPE_POLL_MS = '100'
process.env.UNBLOCK_SCOPE_RETRY_MS = '100'
process.env.UNBLOCK_TRUSTED_PROXY = 'tailscale'
process.env.UNBLOCK_PUBLIC_ORIGIN = 'https://studio.example.ts.net:8797'
process.env.UNBLOCK_ALLOWED_USERS = 'alex@example.com'
writeFileSync(herdrBin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${paneLog}'\n`)
chmodSync(herdrBin, 0o700)
process.env.HERDR_BIN_PATH = herdrBin

const initial = {
  slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', updated_at: new Date().toISOString(), plan_md: 'Initial plan',
  questions: [{ id: 'Q1', text: 'First?', status: 'open' }, { id: 'Q2', text: 'Second?', status: 'open' }],
}
writeFileSync(join(demo, 'scope.json'), JSON.stringify(initial))
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const secret = loadOrCreateSecret()
let daemon
const human = { Host: 'studio.example.ts.net:8797', 'tailscale-user-login': 'alex@example.com' }
const bearer = { Authorization: `Bearer ${secret}` }

function request(path, { method = 'GET', headers = {}, body } = {}) {
  const payload = body && JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method,
      headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let json
        try { json = JSON.parse(text) } catch { /* HTML */ }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function stream(path) {
  return new Promise((resolve, reject) => {
    const events = []
    const waiters = []
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path, headers: human }, (res) => {
      assert.equal(res.statusCode, 200)
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = frame.match(/^event: (.+)$/m)?.[1]
          const data = frame.match(/^data: (.+)$/m)?.[1]
          if (!event || !data) continue
          events.push({ event, data: JSON.parse(data) })
          for (const waiter of [...waiters]) {
            if (!waiter.match(events.at(-1))) continue
            clearTimeout(waiter.timer)
            waiters.splice(waiters.indexOf(waiter), 1)
            waiter.resolve(events.at(-1).data)
          }
        }
      })
      resolve({
        next(event, match = () => true) {
          const found = events.find((item) => item.event === event && match(item.data))
          if (found) return Promise.resolve(found.data)
          return new Promise((done, fail) => {
            const waiter = { match: (item) => item.event === event && match(item.data), resolve: done }
            waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); fail(new Error(`timed out waiting for ${event}`)) }, 2000)
            waiters.push(waiter)
          })
        },
        close() { req.destroy(); res.destroy(); for (const waiter of waiters) clearTimeout(waiter.timer) },
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function until(assertion) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  assert.fail('condition not reached within 2s')
}

test('scoping notes reach the pane, stream, SQLite and CLI reply path', async () => {
  daemon = await startDaemon({ port: 0 })
  let events
  try {
    events = await stream('/api/scope/demo/events')
    const state = await events.next('state')
    assert.equal(state.scope.plan_md, 'Initial plan')
    assert.equal(state.notes.length, 0)

    const answer = await request('/api/scope/demo/note', { method: 'POST', headers: human, body: { qid: 'Q2', text: 'take the recommendation' } })
    assert.equal(answer.status, 201)
    assert.equal(answer.json.note.from, 'alex')
    const thought = await request('/api/scope/demo/note', { method: 'POST', headers: human, body: { text: 'also think about phones' } })
    assert.equal(thought.status, 201)
    assert.equal((await events.next('note', (note) => note.id === answer.json.note.id)).text, 'take the recommendation')
    assert.equal((await events.next('note', (note) => note.id === thought.json.note.id)).text, 'also think about phones')
    await until(() => {
      try {
        const log = readFileSync(paneLog, 'utf8')
        return log.includes('agent prompt w5H:pT1 [scoping demo] Alex on Q2: take the recommendation') && log.includes('also think about phones')
      } catch { return false }
    })
    await events.next('note', (note) => note.id === thought.json.note.id && note.delivery === 'delivered')
    await until(async () => {
      const { json } = await request('/api/scope/demo/notes', { headers: bearer })
      return json.notes.length === 2 && json.notes.every((note) => note.delivery === 'delivered')
    })

    const changed = { ...initial, plan_md: 'Updated plan', questions: [initial.questions[0], { ...initial.questions[1], status: 'answered' }] }
    writeFileSync(join(demo, 'scope.tmp'), JSON.stringify(changed))
    renameSync(join(demo, 'scope.tmp'), join(demo, 'scope.json'))
    assert.equal((await events.next('scope', (data) => data.scope?.plan_md === 'Updated plan')).scope.questions[1].status, 'answered')

    const reply = await request('/api/scope/demo/reply', { method: 'POST', headers: bearer, body: { text: 'Noted, moving ahead.' } })
    assert.equal(reply.status, 201)
    assert.equal((await events.next('note', (note) => note.id === reply.json.note.id)).from, 'agent')
    assert.equal((await request('/api/scope/demo/note', { method: 'POST', headers: bearer, body: { text: 'forged' } })).status, 403)
    assert.equal((await request('/api/scope/demo/note', { method: 'POST', headers: human, body: { qid: 'Q9', text: 'invalid' } })).status, 400)
    const page = await request('/s/demo')
    assert.equal(page.status, 200)
    assert.match(page.text, /__SCOPE_BOOT__/)
    assert.equal((await request('/s', { method: 'POST' })).status, 404)
  } finally {
    events?.close()
    await daemon.close()
    rmSync(temp, { recursive: true, force: true })
  }
})
