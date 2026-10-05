// Scenario (owner: Opus; implementers make it pass, never edit it):
// Development area shows the scoping pages. Hosted Rails can't reach this daemon,
// so Alex's clicks there land in an outbox and a relay on this machine posts
// them here. The relay holds its own secret (not the agent bearer). With it,
// and only from loopback, it may do exactly what Alex's page does on a scope,
// marked "in Admin" for the lane, and a retried post never lands twice. It can
// do nothing else: no lane writes, no queue, no other API.
import assert from 'node:assert/strict'
import test from 'node:test'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-e2e-0123456789abcdefghijklmnopqrstuv'
const at = '2026-09-29T19:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first. Then the voice. The runner is Executor.' },
]
const on = (id, quote) => anchorInSection(sections.find((s) => s.id === id), quote)
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 3, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: on('plan', 'We build the page first'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Page first', messages: [{ from: 'agent', text: 'Page or voice first?', at }], created_at: at },
    { id: 'T2', anchor: on('plan', 'Then the voice'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Round two', messages: [{ from: 'agent', text: 'When does voice ship?', at }], created_at: at },
    { id: 'T3', anchor: on('plan', 'The runner is Executor'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Executor', messages: [{ from: 'agent', text: 'Which runner?', at }], created_at: at },
  ],
}

test('the Admin relay acts as Alex on scopes only, marked in Admin, and never twice', async () => {
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = RELAY
  const h = await startScopeHarness(v2)
  const { request, bearer, paneLines, until } = h
  const relay = { 'X-Unblock-Relay': RELAY }
  const post = (path, body, headers = relay) => request(path, { method: 'POST', headers, body })
  const get = async () => (await request('/api/scope/demo', { headers: human })).json.scope
  try {
    // 1. Reads: the scope list carries revision so the relay pushes only on change; one scope reads in full.
    const list = await request('/api/scope', { headers: relay })
    assert.equal(list.status, 200)
    assert.equal(list.json.scopes.find((s) => s.slug === 'demo').revision, 3)
    assert.equal((await request('/api/scope/demo', { headers: relay })).status, 200)

    // 2. A comment from Admin is Alex's, marked in Admin, and reaches the lane's pane that way.
    const made = await post('/api/scope/demo/threads', { anchor: on('plan', 'Then the voice'), text: 'Can voice come sooner?', client_id: 'adm-1' })
    assert.equal(made.status, 201)
    const t4 = made.json.thread
    assert.equal(t4.author, 'alex')
    assert.equal(t4.messages[0].via, 'admin')
    await until(() => /Alex \(in Admin\) on §The plan "Then the voice": Can voice come sooner\? \(new T4\)/.test(paneLines()), 'pane hears the Admin comment')

    // 3. The outbox retries: the same client_id never lands twice and never re-pings the pane.
    const before = paneLines()
    const again = await post('/api/scope/demo/threads', { anchor: on('plan', 'Then the voice'), text: 'Can voice come sooner?', client_id: 'adm-1' })
    assert.equal(again.status, 200)
    assert.equal(again.json.duplicate, true)
    assert.equal(again.json.thread.id, 'T4')
    assert.equal((await get()).threads.length, 4)

    // 4. Take it, No and Not now, each once, each in Admin.
    const take = { decision: 'Page first', alex_words: 'Take it', how: 'take', client_id: 'adm-2' }
    assert.equal((await post('/api/scope/demo/threads/T1/resolve', take)).status, 200)
    const retake = await post('/api/scope/demo/threads/T1/resolve', take)
    assert.equal(retake.status, 200)
    assert.equal(retake.json.duplicate, true)
    assert.equal((await post('/api/scope/demo/threads/T2/reject', { text: 'Too late.', client_id: 'adm-3' })).status, 200)
    assert.equal((await post('/api/scope/demo/threads/T2/reject', { text: 'Too late.', client_id: 'adm-3' })).json.duplicate, true)
    assert.equal((await post('/api/scope/demo/threads/T3/park', { client_id: 'adm-4' })).status, 200)
    assert.equal((await post('/api/scope/demo/threads/T4/reply', { text: 'Or with the page.', client_id: 'adm-5' })).status, 200)
    await until(() => /Alex \(in Admin\) took the recommendation on T1/.test(paneLines())
      && /Alex \(in Admin\) rejected the recommendation on T2 [^\n]*Too late\./.test(paneLines())
      && /Alex \(in Admin\) parked T3/.test(paneLines())
      && /Alex \(in Admin\) on T4 [^\n]*Or with the page\./.test(paneLines()), 'pane hears each Admin action once')
    const after = paneLines().slice(before.length)
    assert.equal(after.match(/took the recommendation on T1/g).length, 1)
    assert.equal(after.match(/rejected the recommendation on T2/g).length, 1)
    const scope = await get()
    assert.equal(scope.threads.find((t) => t.id === 'T1').status, 'resolved')
    assert.equal(scope.threads.find((t) => t.id === 'T2').messages.filter((m) => m.kind === 'reject').length, 1)
    assert.equal(scope.threads.find((t) => t.id === 'T4').messages.length, 2)

    // 5. The relay must name each write (client_id: 1–64 of [A-Za-z0-9_-]) and may say via admin (the default) or
    //    via voice (Alex spoke in Admin, pJ0 TO-pHY-9, r30); nothing else.
    assert.equal((await post('/api/scope/demo/threads/T4/reply', { text: 'x' })).status, 400, 'client_id required')
    assert.equal((await post('/api/scope/demo/threads/T4/reply', { text: 'x', client_id: 'bad id!' })).status, 400)
    assert.equal((await post('/api/scope/demo/threads/T4/reply', { text: 'x', client_id: 'adm-6', via: 'page' })).status, 400)
    const spoken = await post('/api/scope/demo/threads/T4/reply', { text: 'Said out loud.', client_id: 'adm-6v', via: 'voice' })
    assert.equal(spoken.status, 200, spoken.text)
    await h.until(() => /Alex \(by voice\) on T4 [^\n]*Said out loud\./.test(paneLines()), 'the pane hears a relayed voice reply as by voice')
    assert.equal((await get()).threads.find((t) => t.id === 'T4').messages.at(-1).via, 'voice')
    assert.equal((await get()).threads.find((t) => t.id === 'T4').messages.filter((m) => m.via === 'admin').length, 2, 'relay writes without via (the first comment and the step 4 reply) stay admin')
    // Alex's own page can't claim to be Admin.
    assert.equal((await post('/api/scope/demo/threads/T4/reply', { text: 'x', via: 'admin' }, human)).status, 400)

    // 6. Nothing a lane does: no doc rewrite, no ask, no agent reply with a recommendation.
    assert.equal((await request('/api/scope/demo/doc', { method: 'PUT', headers: relay, body: { sections } })).status, 403)
    const ask = await post('/api/scope/demo/threads', { section: 'plan', quote: 'We build the page first', text: 'Q?', recommendation: 'x', client_id: 'adm-7' })
    assert.ok([400, 403].includes(ask.status), 'the relay cannot ask as a lane')
    assert.equal((await get()).threads.length, 4)

    // 7. Nothing outside scopes: the queue, answers, secrets and voice stay closed.
    for (const [method, path] of [['GET', '/api/queue'], ['POST', '/api/answer'], ['POST', '/api/voice/session'], ['GET', '/api/health/secrets'], ['POST', '/api/asks']]) {
      const res = await request(path, { method, headers: relay, body: method === 'POST' ? {} : undefined })
      assert.ok([401, 403, 404].includes(res.status), `${method} ${path} closed to the relay (got ${res.status})`)
      assert.notEqual(res.status, 200)
    }

    // 8. A wrong or short secret is 401 even with a valid-looking body; the relay header never rides on the tailnet host.
    assert.equal((await post('/api/scope/demo/threads/T4/reply', { text: 'x', client_id: 'adm-8' }, { 'X-Unblock-Relay': RELAY.slice(0, -1) + 'X' })).status, 401)
    assert.equal((await post('/api/scope/demo/threads/T4/reply', { text: 'x', client_id: 'adm-9' }, { ...relay, Host: 'studio.example.ts.net:8797' })).status, 401)
    // The agent bearer still works for lanes and is not an Admin identity.
    assert.equal((await post('/api/scope/demo/threads/T4/reply', { text: 'Lane here.' }, bearer)).status, 200)
    const t4after = (await get()).threads.find((t) => t.id === 'T4')
    assert.equal(t4after.messages.at(-1).from, 'agent')
  } finally {
    delete process.env.UNBLOCK_ADMIN_RELAY_TOKEN
    await h.close()
  }
})

test('without a relay secret configured, the relay header opens nothing', async () => {
  delete process.env.UNBLOCK_ADMIN_RELAY_TOKEN
  process.env.UNBLOCK_ADMIN_RELAY_KEY_REF = 'none-test'
  const h = await startScopeHarness(v2)
  try {
    const res = await h.request('/api/scope', { headers: { 'X-Unblock-Relay': '' } })
    assert.equal(res.status, 401)
    const res2 = await h.request('/api/scope', { headers: { 'X-Unblock-Relay': RELAY } })
    assert.equal(res2.status, 401)
  } finally {
    delete process.env.UNBLOCK_ADMIN_RELAY_KEY_REF
    await h.close()
  }
})
