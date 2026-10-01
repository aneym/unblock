// Owner: Opus (unblock on rails, tailnet connect, 2026-10-01). Implementers make it pass and never edit it.
// Alex approves on rails.so from the Book or his phone, so a loopback redirect would land on his own
// machine. With redirectUri set, connect registers that https URI (a tailscale serve address on Studio),
// listens on 127.0.0.1:port behind it, and sends the same URI in the code exchange. Here the fake
// browser stands in for tailscale serve by calling the loopback port directly.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'unblock-rails-connect-'))
const vault = join(dir, 'vault.json')
const fakeSecret = join(dir, 'agent-secret')
writeFileSync(vault, '{}')
writeFileSync(fakeSecret, `#!/usr/bin/env node
const fs = require('fs'); const [cmd, name] = process.argv.slice(2); const v = JSON.parse(fs.readFileSync(${JSON.stringify(vault)}, 'utf8'))
if (cmd === 'get') { if (!(name in v)) process.exit(1); process.stdout.write(v[name]) }
else if (cmd === 'put') { v[name] = fs.readFileSync(0, 'utf8'); fs.writeFileSync(${JSON.stringify(vault)}, JSON.stringify(v)) }
else process.exit(2)
`)
chmodSync(fakeSecret, 0o755)
Object.assign(process.env, { UNBLOCK_STATE_DIR: join(dir, 'state'), UNBLOCK_AGENT_SECRET_BIN: fakeSecret })
const { connect } = await import('../src/rails-auth.js')

const RESOURCE = 'https://unblock.rails.so/mcp'
const CALLBACK = 'https://cb.example.test:8490/callback'
let requests = 0
const registered = []
const exchanges = []
let as, issuer, challenge
function authServer() {
  return http.createServer((req, res) => {
    requests++
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, issuer)
      const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
          registration_endpoint: `${issuer}/oauth/register`, code_challenge_methods_supported: ['S256'] })
      }
      if (url.pathname === '/oauth/register') {
        const body = JSON.parse(Buffer.concat(chunks))
        registered.push(body)
        return json(201, { client_id: 'cid-tailnet', redirect_uris: body.redirect_uris })
      }
      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString())
        exchanges.push(Object.fromEntries(form))
        if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'code-1' &&
          createHash('sha256').update(form.get('code_verifier')).digest('base64url') === challenge) {
          return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' })
        }
        return json(400, { error: 'invalid_grant' })
      }
      json(404, {})
    })
  })
}

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

test.before(async () => {
  as = authServer()
  await new Promise((resolve) => as.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${as.address().port}`
})
test.after(() => { as.close(); rmSync(dir, { recursive: true, force: true }) })

test('connect with a tailnet https redirect registers it, sends it to authorize and to the code exchange', async () => {
  const port = await freePort()
  const seen = []
  const result = await connect({
    issuer, resource: RESOURCE, secretName: 'rails-unblock-client', redirectUri: CALLBACK, port,
    openUrl: async (authorize) => {
      // The person's browser on another device: rails.so redirects to the tailnet URI, and tailscale
      // serve forwards it to the loopback port on Studio.
      const url = new URL(authorize)
      seen.push(url)
      challenge = url.searchParams.get('code_challenge')
      const callback = new URL(url.searchParams.get('redirect_uri'))
      const back = new URL(`http://127.0.0.1:${port}${callback.pathname}`)
      back.searchParams.set('code', 'code-1')
      back.searchParams.set('state', url.searchParams.get('state'))
      const response = await fetch(back)
      assert.equal(response.status, 200)
    },
  })
  assert.equal(result.client_id, 'cid-tailnet')
  assert.deepEqual(registered.at(-1).redirect_uris, [CALLBACK], 'DCR registers only the https tailnet URI')
  assert.equal(seen[0].searchParams.get('redirect_uri'), CALLBACK, 'authorize carries the tailnet URI')
  const exchange = exchanges.at(-1)
  assert.equal(exchange.grant_type, 'authorization_code')
  assert.equal(exchange.redirect_uri, CALLBACK, 'the code exchange sends the same URI')
  const stored = JSON.parse(JSON.parse(readFileSync(vault, 'utf8'))['rails-unblock-client'])
  assert.equal(stored.refresh_token, 'refresh-1')
  assert.equal(stored.client_id, 'cid-tailnet')
  const raw = readFileSync(vault, 'utf8')
  assert.ok(!raw.includes('access-1') && !raw.includes('code-1'), 'the vault holds no access token or code')
  assert.ok(!JSON.stringify(result).includes('refresh-1'), 'connect returns no token')
})

test('a redirect that is not https, or has no port to listen on, is refused before any network call', async () => {
  const before = requests
  const refused = async (options) => {
    let opened = false
    await assert.rejects(
      connect({ issuer, resource: RESOURCE, secretName: 'rails-refused', timeoutMs: 2_000, openUrl: () => { opened = true }, ...options }),
      (error) => error.code === 'invalid_redirect',
    )
    assert.equal(opened, false)
  }
  await refused({ redirectUri: 'http://cb.example.test:8490/callback', port: await freePort() })
  await refused({ redirectUri: 'http://127.0.0.1:8490/callback', port: await freePort() })
  await refused({ redirectUri: 'not a url', port: await freePort() })
  await refused({ redirectUri: CALLBACK })
  assert.equal(requests - before, 0, 'no request reached the issuer')
})
