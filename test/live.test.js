/**
 * Live asks: the human types, the agent watches, the agent revises.
 *
 * The property under test is that an ask can change while someone is filling it
 * in without costing them what they already typed — and that a watcher hears
 * about it without polling the whole queue.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'unblock-live-'))
process.env.UNBLOCK_STATE_DIR = stateDir
process.env.UNBLOCK_CONFIG_DIR = join(stateDir, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const authSecret = loadOrCreateSecret()

async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authSecret}`,
      ...(options.headers || {}),
    },
  })
  return { response, body: await response.json() }
}

const textField = (name) => ({ name, type: 'text', label: name, required: true })

function file(base, fields, extras = {}) {
  return json(base, '/api/asks', {
    method: 'POST',
    body: JSON.stringify({
      ask: { kind: 'file', title: 'Live ask', why: 'Someone has to answer this.', fields, ...extras },
      origin: { session_id: 'live-session' },
    }),
  })
}

/** Read one SSE frame at a time off the stream, so a test can await an event. */
function sseReader(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return async function next() {
    for (;;) {
      const split = buffer.indexOf('\n\n')
      if (split >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const event = frame.match(/^event: (.+)$/m)
        const data = frame.match(/^data: (.+)$/m)
        if (!event) continue // a keepalive comment
        return { event: event[1], data: data ? JSON.parse(data[1]) : null }
      }
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended')
      buffer += decoder.decode(value, { stream: true })
    }
  }
}

test('live asks', async (t) => {
  const daemon = await startDaemon({ port: 0 })
  const base = `http://127.0.0.1:${daemon.port}`

  await t.test('reads a draft back per ask, with the time it was typed', async () => {
    const created = await file(base, [textField('host'), textField('port')])
    const before = await json(base, `/api/asks/${created.body.ticket}`)
    assert.equal(before.body.draft_updated_at, undefined)

    await json(base, '/api/draft', {
      method: 'POST',
      body: JSON.stringify({
        ticket: created.body.ticket,
        values: { host: 'db-1' },
        field_context: { host: 'only until Friday' },
      }),
    })

    const after = await json(base, `/api/asks/${created.body.ticket}`)
    assert.equal(after.body.status, 'open')
    assert.equal(after.body.draft.host, 'db-1')
    assert.equal(after.body.field_context.host, 'only until Friday')
    assert.ok(after.body.draft_updated_at > 0)
  })

  await t.test('streams draft, updated and answered events for one ask', async () => {
    const created = await file(base, [textField('host')])
    const stream = await fetch(`${base}/api/asks/${created.body.ticket}/events`, {
      headers: { Authorization: `Bearer ${authSecret}` },
    })
    assert.equal(stream.status, 200)
    const next = sseReader(stream)

    const state = await next()
    assert.equal(state.event, 'state')
    assert.equal(state.data.ticket, created.body.ticket)

    await json(base, '/api/draft', {
      method: 'POST',
      body: JSON.stringify({ ticket: created.body.ticket, values: { host: 'db-2' } }),
    })
    const draft = await next()
    assert.equal(draft.event, 'draft')
    assert.equal(draft.data.draft.host, 'db-2')

    await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({ add_fields: [textField('region')] }),
    })
    const updated = await next()
    assert.equal(updated.event, 'updated')
    assert.ok(updated.data.updated_at > 0)

    await json(base, `/api/asks/${created.body.ticket}/answer`, {
      method: 'POST',
      body: JSON.stringify({ values: { host: 'db-2', region: 'eu' } }),
    })
    const answered = await next()
    assert.equal(answered.event, 'answered')
    assert.equal(answered.data.status, 'answered')
  })

  await t.test('streams the two ways an ask ends without an answer', async () => {
    for (const [route, body, event, status] of [
      ['answer', { bounce: true, reply: 'wrong question' }, 'sent_back', 'bounced'],
      ['cancel', { note: 'solved it myself' }, 'cancelled', 'cancelled'],
    ]) {
      const created = await file(base, [textField('host')])
      const stream = await fetch(`${base}/api/asks/${created.body.ticket}/events`, {
        headers: { Authorization: `Bearer ${authSecret}` },
      })
      const next = sseReader(stream)
      await next() // the opening state frame
      await json(base, `/api/asks/${created.body.ticket}/${route}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const ended = await next()
      assert.equal(ended.event, event)
      assert.equal(ended.data.status, status)
    }
  })

  await t.test('adds a question without losing the answers already typed', async () => {
    const created = await file(base, [textField('host')])
    await json(base, '/api/draft', {
      method: 'POST',
      body: JSON.stringify({
        ticket: created.body.ticket,
        values: { host: 'db-3' },
        field_context: { host: 'the replica, not the primary' },
        reply: 'half written',
      }),
    })
    const updated = await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({ why: 'The region matters too.', add_fields: [textField('region')] }),
    })
    assert.equal(updated.response.status, 200)
    assert.deepEqual(updated.body.ask.fields.map((field) => field.name), ['host', 'region'])
    assert.equal(updated.body.ask.why, 'The region matters too.')
    assert.equal(updated.body.ask.status, 'open')
    assert.equal(updated.body.ask.draft.host, 'db-3')
    assert.equal(updated.body.ask.field_context.host, 'the replica, not the primary')
    assert.equal(updated.body.ask.draft_reply, 'half written')
    assert.ok(updated.body.ask.updated_at > 0)
  })

  await t.test('removing a question takes its draft and its note with it', async () => {
    const created = await file(base, [textField('host'), textField('region')])
    await json(base, '/api/draft', {
      method: 'POST',
      body: JSON.stringify({
        ticket: created.body.ticket,
        values: { host: 'db-4', region: 'eu' },
        field_context: { region: 'guessing' },
      }),
    })
    const updated = await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({ remove_fields: ['region'] }),
    })
    assert.deepEqual(updated.body.ask.fields.map((field) => field.name), ['host'])
    assert.equal(updated.body.ask.draft.host, 'db-4')
    assert.equal(updated.body.ask.draft.region, undefined)
    assert.equal(updated.body.ask.field_context.region, undefined)
  })

  await t.test('a same-named add revises that question in place', async () => {
    const created = await file(base, [textField('host'), textField('region')])
    const updated = await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({
        add_fields: [{ name: 'host', type: 'text', label: 'Which host, by name?' }],
      }),
    })
    assert.deepEqual(updated.body.ask.fields.map((field) => field.name), ['host', 'region'])
    assert.equal(updated.body.ask.fields[0].label, 'Which host, by name?')
  })

  await t.test('holds the update to the same schema a fresh ask obeys', async () => {
    const created = await file(base, [textField('host')])

    const empty = await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    assert.equal(empty.response.status, 400)

    const gone = await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({ remove_fields: ['nope'] }),
    })
    assert.equal(gone.response.status, 400)

    const noFields = await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({ remove_fields: ['host'] }),
    })
    assert.equal(noFields.response.status, 400)
    assert.match(noFields.body.error, /at least one field/)

    // A blocker made entirely of choices is rejected on create; an update must
    // not be the way round it.
    const allChoices = await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({
        replace_fields: [
          { name: 'pick', type: 'choice', label: 'pick', choices: ['a', 'b'] },
        ],
      }),
    })
    assert.equal(allChoices.response.status, 400)
  })

  await t.test('refuses to revise an ask the human already answered', async () => {
    const created = await file(base, [textField('host')])
    await json(base, `/api/asks/${created.body.ticket}/answer`, {
      method: 'POST',
      body: JSON.stringify({ values: { host: 'db-5' } }),
    })
    const updated = await json(base, `/api/asks/${created.body.ticket}/update`, {
      method: 'POST',
      body: JSON.stringify({ add_fields: [textField('region')] }),
    })
    assert.equal(updated.response.status, 409)
    assert.equal(updated.body.code, 'ASK_NOT_OPEN')
  })

  await t.test('reports this agent’s open asks alongside its answered ones', async () => {
    const created = await file(base, [textField('host')])
    await json(base, '/api/draft', {
      method: 'POST',
      body: JSON.stringify({ ticket: created.body.ticket, values: { host: 'db-6' } }),
    })
    const pending = await json(base, '/api/pending?session_id=live-session')
    const open = pending.body.open.find((ask) => ask.ticket === created.body.ticket)
    assert.ok(open, 'the open ask is reported')
    assert.equal(open.draft.host, 'db-6')
    assert.ok(open.draft_updated_at > 0)
  })

  await daemon.close()
})

test.after(() => rmSync(stateDir, { recursive: true, force: true }))
