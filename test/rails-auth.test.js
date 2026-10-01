// Owner: Opus (unblock on rails S2, 2026-10-01). Implementers make it pass and never edit it.
// Studio's Unblock connects to hosted Unblock as the owner's own OAuth client (ADR 0086 section 6): dynamic
// client registration, PKCE S256 and a loopback redirect. Alex approves once on rails.so; the refresh token
// lives only in agent-secret and is rotated there on every refresh. Nothing prints a token.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'unblock-rails-auth-'))
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
const { connect, railsAccessToken } = await import('../src/rails-auth.js')

const RESOURCE = 'https://unblock.rails.so/mcp'
const tokenCalls = []
let as, issuer, challenge
function authServer() {
  return http.createServer((req, res) => {
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
        assert.equal(body.token_endpoint_auth_method, 'none')
        assert.ok(body.redirect_uris.every((uri) => uri.startsWith('http://127.0.0.1:')), body.redirect_uris)
        return json(201, { client_id: 'cid-1', redirect_uris: body.redirect_uris })
      }
      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString())
        tokenCalls.push(Object.fromEntries(form))
        assert.equal(form.get('client_id'), 'cid-1')
        assert.equal(form.get('resource'), RESOURCE)
        if (form.get('grant_type') === 'authorization_code') {
          assert.equal(form.get('code'), 'code-1')
          assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge, 'PKCE verifier matches')
          return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' })
        }
        if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-1') {
          return json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'Bearer' })
        }
        return json(400, { error: 'invalid_grant' })
      }
      json(404, {})
    })
  })
}

test.before(async () => {
  as = authServer()
  await new Promise((resolve) => as.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${as.address().port}`
})
test.after(() => { as.close(); rmSync(dir, { recursive: true, force: true }) })

test('connect registers a client, sends the person to approve, and keeps only a refresh token in agent-secret', async () => {
  const seen = []
  const result = await connect({
    issuer, resource: RESOURCE, clientName: 'Unblock on Studio', secretName: 'rails-unblock-client',
    openUrl: async (authorize) => {
      // The person's browser: approve on rails.so, which redirects to the loopback callback.
      const url = new URL(authorize)
      seen.push(url)
      challenge = url.searchParams.get('code_challenge')
      const back = new URL(url.searchParams.get('redirect_uri'))
      back.searchParams.set('code', 'code-1')
      back.searchParams.set('state', url.searchParams.get('state'))
      const response = await fetch(back)
      assert.equal(response.status, 200)
    },
  })
  assert.equal(result.client_id, 'cid-1')
  const [authorize] = seen
  assert.equal(authorize.origin + authorize.pathname, `${issuer}/oauth/authorize`)
  assert.equal(authorize.searchParams.get('response_type'), 'code')
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorize.searchParams.get('resource'), RESOURCE)
  assert.ok(authorize.searchParams.get('state'), 'a state value')
  const stored = JSON.parse(JSON.parse(readFileSync(vault, 'utf8'))['rails-unblock-client'])
  assert.equal(stored.client_id, 'cid-1')
  assert.equal(stored.refresh_token, 'refresh-1')
  assert.equal(stored.resource, RESOURCE)
  assert.equal(stored.access_token, undefined, 'access tokens are not stored')
  assert.ok(!JSON.stringify(result).includes('refresh-1') && !JSON.stringify(result).includes('access-1'), 'connect returns no token')
})

test('an access token comes from the stored refresh token, and the rotated refresh token is saved first', async () => {
  const before = tokenCalls.length
  assert.equal(await railsAccessToken({ secretName: 'rails-unblock-client', refresh: true }), 'access-2')
  const stored = JSON.parse(JSON.parse(readFileSync(vault, 'utf8'))['rails-unblock-client'])
  assert.equal(stored.refresh_token, 'refresh-2', 'the rotated refresh token replaces the spent one')
  assert.equal(await railsAccessToken({ secretName: 'rails-unblock-client' }), 'access-2', 'a live access token is reused')
  assert.equal(tokenCalls.length - before, 1, 'one refresh for two calls')
})
