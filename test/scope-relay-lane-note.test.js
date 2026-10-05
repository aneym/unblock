// Scenario (owner: Opus; implementers make it pass, never edit it):
// Alex talks a scope through inside Development area. When the voice leaves the lane a quiet note ("Noted for the lane"),
// Admin queues it like any other write and the relay on this machine posts it here, with its own secret, from loopback.
// The note reaches the lane's pane once, as a note from Alex's voice call, however many times the outbox retries it.
// The relay must name the write (client_id) and may only call it voice; a lane still cannot leave one.
import assert from 'node:assert/strict'
import test from 'node:test'
import { human, startScopeHarness } from './scope-harness.js'

const RELAY = 'relay-e2e-0123456789abcdefghijklmnopqrstuv'
const at = '2026-09-29T21:00:00Z'
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 3, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'plan', heading: 'The plan', body_md: 'The runner is Executor.' }] },
  threads: [],
}
const TEXT = 'He wants phones first; the plan section should say so.'

test('the Admin relay leaves a voice lane note once, marked voice, and the lane hears it once', async () => {
  process.env.UNBLOCK_ADMIN_RELAY_TOKEN = RELAY
  const h = await startScopeHarness(v2)
  const { request, bearer, paneLines, until } = h
  const relay = { 'X-Unblock-Relay': RELAY }
  const post = (body, headers = relay) => request('/api/scope/demo/lane-note', { method: 'POST', headers, body })
  const laneNotes = async () => ((await request('/api/scope/demo', { headers: human })).json.notes || []).filter((n) => n.event === 'lane_note')
  try {
    // 1. The relayed note lands as Alex's, from his voice call, and no comment is made.
    const first = await post({ text: TEXT, client_id: 'adm-n1' })
    assert.equal(first.status, 200, first.text)
    assert.equal(first.json.note.from, 'alex')
    assert.equal(first.json.note.event, 'lane_note')
    assert.equal(first.json.note.via, 'voice')
    await until(() => paneLines().includes(`Note from Alex's voice call (not a comment): ${TEXT}`), 'pane hears the relayed note')
    assert.equal((await request('/api/scope/demo', { headers: human })).json.scope.threads.length, 0, 'no comment is created')

    // 2. The outbox retries: the same client_id is a duplicate, stored once, heard once.
    const again = await post({ text: TEXT, client_id: 'adm-n1', via: 'voice' })
    assert.equal(again.status, 200, again.text)
    assert.equal(again.json.duplicate, true)
    assert.equal(again.json.note.id, first.json.note.id)
    assert.equal((await laneNotes()).filter((n) => n.text === TEXT).length, 1)
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(paneLines().split(TEXT).length - 1, 1, 'the pane hears the note exactly once')

    // 3. A second note with its own client_id lands too, still voice even when the body says so.
    const second = await post({ text: 'Keep the call short.', client_id: 'adm-n2', via: 'voice' })
    assert.equal(second.status, 200, second.text)
    assert.equal(second.json.note.via, 'voice')
    assert.equal((await laneNotes()).length, 2)

    // 4. The relay must name the write and may only call it voice; the text rules still hold.
    assert.equal((await post({ text: 'x' })).status, 400, 'client_id required from the relay')
    assert.equal((await post({ text: 'x', client_id: 'bad id!' })).status, 400)
    assert.equal((await post({ text: 'x', client_id: 'adm-n3', via: 'admin' })).status, 400)
    assert.equal((await post({ text: '', client_id: 'adm-n4' })).status, 400)
    assert.equal((await post({ text: 'y'.repeat(1001), client_id: 'adm-n5' })).status, 400)

    // 5. A wrong secret opens nothing; a lane bearer still can't leave a lane note; Alex's own page still can.
    assert.equal((await post({ text: 'x', client_id: 'adm-n6' }, { 'X-Unblock-Relay': RELAY.slice(0, -1) + 'X' })).status, 401)
    assert.equal((await post({ text: 'x' }, bearer)).status, 403)
    const own = await post({ text: 'From his own page.', via: 'voice' }, human)
    assert.equal(own.status, 200, own.text)
    assert.equal((await laneNotes()).length, 3)
  } finally {
    delete process.env.UNBLOCK_ADMIN_RELAY_TOKEN
    await h.close()
  }
})
