// A real daemon over a temp state dir, a temp scoping root with one scope,
// and a herdr stub that logs every pane prompt. Shared by the scoping tests.
import assert from 'node:assert/strict'
import http from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const human = { Host: 'studio.example.ts.net:8797', 'tailscale-user-login': 'alex@example.com' }

export async function startScopeHarness(initial) {
  const temp = mkdtempSync(join(tmpdir(), 'unblock-scope-'))
  const scopes = join(temp, 'scopes')
  const dir = join(scopes, initial.slug)
  const paneLog = join(temp, 'pane.log')
  const herdrBin = join(temp, 'herdr-stub')
  mkdirSync(dir, { recursive: true })
  Object.assign(process.env, {
    UNBLOCK_STATE_DIR: join(temp, 'state'),
    UNBLOCK_CONFIG_DIR: join(temp, 'config'),
    UNBLOCK_SECRET_BACKEND: 'env',
    UNBLOCK_ALEX_FEED: '0',
    UNBLOCK_SCOPING_DIR: scopes,
    UNBLOCK_SCOPE_POLL_MS: '100',
    UNBLOCK_SCOPE_RETRY_MS: '100',
    UNBLOCK_TRUSTED_PROXY: 'tailscale',
    UNBLOCK_PUBLIC_ORIGIN: 'https://studio.example.ts.net:8797',
    UNBLOCK_ALLOWED_USERS: 'alex@example.com',
    HERDR_BIN_PATH: herdrBin,
  })
  writeFileSync(herdrBin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${paneLog}'\n`)
  chmodSync(herdrBin, 0o700)
  // Lanes replace scope.json by rename; tests do the same.
  const writeScope = (scope) => {
    writeFileSync(join(dir, 'scope.tmp'), JSON.stringify(scope))
    renameSync(join(dir, 'scope.tmp'), join(dir, 'scope.json'))
  }
  writeScope(initial)
  const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
  const bearer = { Authorization: `Bearer ${loadOrCreateSecret()}` }
  let daemon = await startDaemon({ port: 0 })
  const streams = []

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
        const handle = {
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
        }
        streams.push(handle)
        resolve(handle)
      })
      req.on('error', reject)
      req.end()
    })
  }

  async function until(assertion, what = 'condition') {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (await assertion()) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    assert.fail(`${what} not reached within 2s`)
  }

  const paneLines = () => { try { return readFileSync(paneLog, 'utf8') } catch { return '' } }

  async function restart() {
    for (const handle of streams) handle.close()
    await daemon.close()
    daemon = await startDaemon({ port: 0 })
  }

  async function close() {
    for (const handle of streams) handle.close()
    await daemon.close()
    rmSync(temp, { recursive: true, force: true })
  }

  return { request, stream, until, paneLines, writeScope, bearer, close, restart, get port() { return daemon.port } }
}
