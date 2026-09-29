import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createVoiceSession } from '../src/voice.js'

const state = mkdtempSync(join(process.env.UNBLOCK_TEST_TMPDIR || tmpdir(), 'unblock-voice-stories-'))
process.env.UNBLOCK_STATE_DIR = state
process.env.UNBLOCK_CONFIG_DIR = join(state, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
process.env.UNBLOCK_PUBLIC_ORIGIN = 'https://studio.tailnet.test:8797'
process.env.UNBLOCK_TRUSTED_PROXY = 'tailscale'
process.env.UNBLOCK_ALLOWED_USERS = 'viewer@example.test'
process.env.UNBLOCK_ISSUE_DRY = '1'
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const auth = { Authorization: `Bearer ${loadOrCreateSecret()}` }
const human = { Host: 'studio.tailnet.test:8797', 'tailscale-user-login': 'viewer@example.test' }
let daemon
let nextId = 0
const field = (name, extra = {}) => ({ name, label: name, type: 'text', required: true, ...extra })
const choice = (name, extra = {}) => ({ name, label: name, type: 'choice', required: true,
  choices: [{ value: 'x', label: 'Option X' }, { value: 'y', label: 'Option Y' }], ...extra })

test.before(async () => { daemon = await startDaemon({ port: 0 }) })
test.after(async () => { await daemon.close(); rmSync(state, { recursive: true, force: true }) })

function raw(path, { method = 'GET', body, headers = auth } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method,
      headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: res.statusCode, json: JSON.parse(text) })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const post = (path, body, headers) => raw(path, { method: 'POST', body, headers })
const getAsk = async (ticket) => {
  const result = await raw(`/api/asks/${ticket}`)
  assert.equal(result.status, 200)
  return result.json
}
async function file({ title, fields = [field('answer')], project = 'Studio', ...extra } = {}) {
  const id = ++nextId
  const result = await post('/api/asks', { ask: { kind: 'file', purpose: 'question', title: title || `Voice story ${id}`,
    why: 'The owner needs to decide how this should work.', project, fields, ...extra }, origin: { session_id: `voice-story-${id}` } })
  assert.equal(result.status, 201, JSON.stringify(result.json))
  return result.json
}
async function screen() {
  const id = ++nextId
  const result = await post('/api/asks', { ask: { kind: 'file', purpose: 'blocker', title: `Credential request ${id}`,
    why: 'The agent needs access to finish this task.', project: 'Keys', only_you: 'credential',
    tried: ['Checked the available CLI and no usable credential was found.'],
    links: [{ url: 'https://example.test/settings/keys', label: 'Key settings' }],
    fields: [field('api_key', { type: 'secret' })] }, origin: { session_id: `voice-story-${id}` } })
  assert.equal(result.status, 201, JSON.stringify(result.json))
  return result.json
}
function voice(tickets, overrides = {}) {
  const visible = new Set(tickets.map((item) => item.ticket))
  const request = async (path, body) => {
    const result = await post(path, body, human)
    if (result.status >= 400) {
      const error = new Error(result.json.error)
      error.code = result.json.code
      throw error
    }
    return result.json
  }
  return createVoiceSession({
    getAsks: async () => (await raw('/api/queue')).json.asks.filter((ask) => visible.has(ask.ticket)),
    postAnswer: (body) => request('/api/answer', body),
    fileIssue: (issue) => request('/api/voice/issue', issue),
    ...overrides,
  })
}
const answers = (value, context) => ({ n: 1, answers: [{ field: '1', value, ...(context ? { context } : {}) }] })

// Each story uses asks filed through the agent API and checks the same durable store the panel reads.
test('1. summary counts voice and screen-only asks', async () => {
  const a = await file(), s = await screen()
  const result = await voice([a, s]).handle('queue_summary', {})
  assert.match(result.speech, /2 open:/)
  assert.match(result.speech, /1 needs the screen/)
  assert.equal((await getAsk(s.ticket)).status, 'open')
})

test('2. show project focuses the list numbering', async () => {
  const a = await file({ project: 'Studio' }), b = await file({ project: 'Recruiter' })
  const session = voice([a, b])
  assert.deepEqual((await session.handle('show_queue', { project: 'Recruiter' })).ui, { do: 'show_list', project: 'Recruiter' })
  assert.equal((await session.handle('ask_read', { n: 1 })).ticket, b.ticket)
})

test('3. read one shows the correct ask', async () => {
  const a = await file()
  assert.deepEqual((await voice([a]).handle('ask_read', { n: 1 })).ui, { do: 'show_ask', ticket: a.ticket })
})

test('4. option number previews, fills, answers and shows next', async () => {
  const a = await file({ fields: [choice('pick')] }), b = await file()
  const session = voice([a, b]), args = answers('two')
  assert.deepEqual((await session.handle('ask_preview', args)).ui, { do: 'fill', ticket: a.ticket, values: { pick: 'y' }, field_context: {} })
  const sent = await session.handle('ask_answer', args)
  assert.equal(sent.changed, true)
  assert.deepEqual(sent.ui, { do: 'show_ask', ticket: b.ticket })
  assert.deepEqual((await getAsk(a.ticket)).answers, { pick: 'y' })
  assert.equal((await getAsk(a.ticket)).status, 'answered')
})

test('5. qualification is persisted as field context', async () => {
  const a = await file(), session = voice([a]), args = answers('Proceed', 'Only after review')
  await session.handle('ask_preview', args)
  assert.equal((await session.handle('ask_answer', args)).ok, true)
  const stored = await getAsk(a.ticket)
  assert.deepEqual(stored.answers, { answer: 'Proceed' })
  assert.deepEqual(stored.field_context, { answer: 'Only after review' })
})

test('6. accept all stores recommendations and refuses must-decide', async () => {
  const recommendation = { value: 'x', why: 'The safer choice' }
  const a = await file({ fields: [choice('first', { recommend: recommendation }), choice('second', { recommend: recommendation })] })
  const session = voice([a]), args = { n: 1, accept_all_recommended: true }
  assert.equal((await session.handle('ask_preview', args)).ok, true)
  assert.equal((await session.handle('ask_answer', args)).ok, true)
  assert.deepEqual((await getAsk(a.ticket)).answers, { first: 'x', second: 'x' })
  const b = await file({ fields: [choice('human', { recommend: recommendation, must_decide: true })] })
  assert.equal((await voice([b]).handle('ask_preview', args)).ok, false)
  assert.deepEqual((await getAsk(b.ticket)).answers, {})
})

test('7. change of mind requires a new preview', async () => {
  const a = await file({ fields: [choice('pick')] }), session = voice([a])
  await session.handle('ask_preview', answers('one'))
  assert.equal((await session.handle('ask_answer', answers('two'))).ok, false)
  assert.deepEqual((await getAsk(a.ticket)).answers, {})
  await session.handle('ask_preview', answers('two'))
  assert.equal((await session.handle('ask_answer', answers('two'))).ok, true)
  assert.deepEqual((await getAsk(a.ticket)).answers, { pick: 'y' })
})

test('8. skip moves to the end and shows next', async () => {
  const a = await file(), b = await file(), session = voice([a, b])
  assert.deepEqual((await session.handle('ask_skip', { n: 1 })).ui, { do: 'show_ask', ticket: b.ticket })
  assert.equal((await session.handle('ask_read', { n: 2 })).ticket, a.ticket)
  assert.equal((await getAsk(a.ticket)).status, 'open')
})

test('9. send back a voice ask persists the bounce note', async () => {
  const a = await file(), session = voice([a])
  assert.equal((await session.handle('ask_send_back', { n: 1, note: 'Explain the goal first' })).ok, true)
  const stored = await getAsk(a.ticket)
  assert.equal(stored.status, 'bounced')
  assert.equal(stored.reply, 'Explain the goal first')
})

test('10. send back a screen-only ask without n after showing it', async () => {
  const a = await screen(), b = await file(), session = voice([a, b])
  await session.handle('show_screen_ask', { n: 1 })
  const sent = await session.handle('ask_send_back', { note: 'Make your own API keys' })
  assert.equal(sent.ok, true)
  assert.deepEqual(sent.ui, { do: 'show_ask', ticket: b.ticket })
  const stored = await getAsk(a.ticket)
  assert.equal(stored.status, 'bounced')
  assert.equal(stored.reply, 'Make your own API keys')
})

test('11. screen-only ask is shown with a reason but cannot be read aloud', async () => {
  const a = await screen(), session = voice([a])
  const shown = await session.handle('show_screen_ask', { n: 1 })
  assert.deepEqual(shown.ui, { do: 'show_ask', ticket: a.ticket })
  assert.match(shown.speech, /a credential/)
  assert.equal((await session.handle('ask_read', {})).speech, 'That one needs the screen.')
})

test('12. open link by number, generic name and on a single-link ask', async () => {
  const a = await file({ links: [{ url: 'https://example.test/first', label: 'First' }, { url: 'https://example.test/second', label: 'Second' }] })
  const session = voice([a])
  await session.handle('ask_read', { n: 1 })
  assert.equal((await session.handle('open_link', { which: '2' })).ui.url, 'https://example.test/second')
  assert.equal((await session.handle('open_link', { which: 'the link' })).ui.url, 'https://example.test/first')
  const b = await file({ links: [{ url: 'https://example.test/only', label: 'Only' }] })
  assert.equal((await voice([b]).handle('open_link', { n: 1, which: 'the link' })).ui.url, 'https://example.test/only')
})

test('13. show details opens the current ask', async () => {
  const a = await file(), session = voice([a])
  await session.handle('ask_read', { n: 1 })
  assert.deepEqual((await session.handle('show_details', {})).ui, { do: 'details', ticket: a.ticket, open: true })
})

test('14. answered list counts answered asks in this run', async () => {
  const a = await file(), b = await file(), session = voice([a, b]), args = answers('Done')
  assert.match((await session.handle('show_answered', {})).speech, /^Showing 0 answered/)
  await session.handle('ask_preview', args)
  await session.handle('ask_answer', args)
  const shown = await session.handle('show_answered', {})
  assert.deepEqual(shown.ui, { do: 'show_answered' })
  assert.match(shown.speech, /^Showing 1 answered/)
  assert.equal((await getAsk(a.ticket)).status, 'answered')
  assert.equal((await getAsk(b.ticket)).status, 'open')
})

test('15. show everything clears focus and restores global numbering', async () => {
  const a = await file({ project: 'Studio' }), b = await file({ project: 'Recruiter' }), session = voice([a, b])
  await session.handle('show_queue', { project: 'Recruiter' })
  assert.equal((await session.handle('ask_read', { n: 1 })).ticket, b.ticket)
  assert.deepEqual((await session.handle('show_queue', { all: true })).ui, { do: 'show_list', all: true })
  assert.equal((await session.handle('ask_read', { n: 1 })).ticket, a.ticket)
})

test('16. file issue returns the dry route result and includes the shown ticket', async () => {
  const a = await file(), session = voice([a])
  await session.handle('ask_read', { n: 1 })
  const result = await session.handle('file_issue', { title: 'Show dates on the answered list', details: 'The answered list should show dates', about: 'dashboard' })
  assert.equal(result.speech, 'Filed as issue 0.')
  assert.deepEqual(result.ui, { do: 'filed', number: 0, url: '' })
  assert.equal((await getAsk(a.ticket)).status, 'open')
  assert.equal((await session.handle('file_issue', { title: '', details: 'bad', about: 'dashboard' })).ok, false)
})

test('17. a mid-call agent revision refuses an outdated answer', async () => {
  const a = await file(), session = voice([a]), args = answers('Proceed')
  await session.handle('ask_preview', args)
  const update = await post(`/api/asks/${a.ticket}/update`, { title: 'Revised question' })
  assert.equal(update.status, 200)
  assert.equal((await session.handle('ask_answer', args)).speech, 'The agent changed that one. Read it again.')
  assert.deepEqual((await getAsk(a.ticket)).answers, {})
})

test('18. an ask closed between preview and answer is already closed while another remains open', async () => {
  const a = await file(), b = await file(), session = voice([a, b]), args = answers('Proceed')
  await session.handle('ask_preview', args)
  assert.equal((await post('/api/answer', { ticket: a.ticket, reply: 'No longer needed', bounce: true }, human)).status, 200)
  assert.equal((await session.handle('ask_answer', args)).speech, 'That one is already closed.')
  assert.deepEqual((await getAsk(a.ticket)).answers, {})
  assert.deepEqual((await getAsk(b.ticket)).answers, {})
  assert.equal((await getAsk(b.ticket)).status, 'open')
})

test('19. end call sends the goodbye UI', async () => {
  assert.deepEqual((await voice([]).handle('end_call', {})).ui, { do: 'end_call' })
})

test('20. talk faster changes speed without posting an answer or issue', async () => {
  const a = await file(), posted = []
  const session = voice([a], {
    provider: 'xai',
    postAnswer: async (body) => { posted.push(body); return {} },
    fileIssue: async (issue) => { posted.push(issue); return { number: 1, url: '' } },
  })
  await session.handle('ask_read', { n: 1 })
  assert.deepEqual(await session.handle('set_speed', { change: 'faster' }), {
    ok: true, speech: 'Okay, faster.', ui: { do: 'speed', change: 'faster' },
  })
  assert.deepEqual(posted, [])
  assert.equal((await getAsk(a.ticket)).status, 'open')
  assert.deepEqual((await getAsk(a.ticket)).answers, {})
})

test('issue endpoint enforces the human path and validates the body', async () => {
  assert.equal((await post('/api/voice/issue', { title: 'Valid', details: '', about: 'other' })).status, 403)
  for (const issue of [{ title: ' ', details: '', about: 'other' }, { title: 'x'.repeat(121), details: '', about: 'other' },
    { title: 'Valid', details: 'x'.repeat(4001), about: 'other' }, { title: 'Valid', details: '', about: 'invalid' }]) {
    assert.equal((await post('/api/voice/issue', issue, human)).status, 400)
  }
})

test('issue endpoint never retries a timed-out create, even with label in stderr', async () => {
  const calls = []
  const previousDry = process.env.UNBLOCK_ISSUE_DRY
  delete process.env.UNBLOCK_ISSUE_DRY
  const issueDaemon = await startDaemon({ port: 0, issueRunner: async (binary, argv) => {
    calls.push(argv)
    const error = new Error(`Command failed: ${binary} ${argv.join(' ')}`)
    error.killed = true
    error.signal = 'SIGTERM'
    error.stderr = 'could not add label dogfood-unblock'
    throw error
  } })
  try {
    const payload = JSON.stringify({ title: 'Show dates', details: 'Please show dates.', about: 'dashboard' })
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: issueDaemon.port, path: '/api/voice/issue', method: 'POST',
        headers: { ...human, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }))
      })
      req.on('error', reject)
      req.end(payload)
    })
    assert.deepEqual(result, { status: 502, json: { error: 'Could not file the issue' } })
    assert.equal(calls.length, 1)
  } finally {
    await issueDaemon.close()
    if (previousDry === undefined) delete process.env.UNBLOCK_ISSUE_DRY
    else process.env.UNBLOCK_ISSUE_DRY = previousDry
  }
})

test('issue endpoint passes exact argv and body to the injected runner and retries a missing label once', async () => {
  const calls = []
  const runner = async (binary, argv, body) => {
    calls.push({ binary, argv, body })
    if (calls.length === 1) { const error = new Error(`Command failed: gh ${argv.join(' ')}`); error.stderr = 'could not add label dogfood-unblock'; throw error }
    return 'https://github.com/shelf-group/agent-rails/issues/3812\n'
  }
  const previousDry = process.env.UNBLOCK_ISSUE_DRY
  delete process.env.UNBLOCK_ISSUE_DRY
  const issueDaemon = await startDaemon({ port: 0, issueRunner: runner })
  try {
    const request = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ title: 'Show dates', details: 'Please show dates on the answered list.', about: 'dashboard', ticket: 'ub_abc123' })
      const req = http.request({ host: '127.0.0.1', port: issueDaemon.port, path: '/api/voice/issue', method: 'POST',
        headers: { ...human, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }))
      })
      req.on('error', reject)
      req.end(payload)
    })
    assert.deepEqual(request, { status: 200, json: { number: 3812, url: 'https://github.com/shelf-group/agent-rails/issues/3812' } })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].binary, process.env.UNBLOCK_GH || join(process.env.HOME, '.local/bin/gh'))
    assert.deepEqual(calls[0].argv, ['issue', 'create', '-R', 'shelf-group/agent-rails', '--title', '[dashboard] Show dates', '--body-file', '-', '--label', 'dogfood-unblock'])
    assert.deepEqual(calls[1].argv, calls[0].argv.slice(0, -2))
    assert.match(calls[0].body, /^Filed by voice from the unblock panel by viewer@example\.test at \d{4}-\d\d-\d\dT[^\n]+\.\nAbout: dashboard\nOn screen: ub_abc123\n\nPlease show dates on the answered list\.\n\nPick-up: triage like any dogfood issue; comment 'fixed in <version>' when live\.\n$/)
    assert.equal(calls[1].body, calls[0].body)
  } finally {
    await issueDaemon.close()
    if (previousDry === undefined) delete process.env.UNBLOCK_ISSUE_DRY
    else process.env.UNBLOCK_ISSUE_DRY = previousDry
  }
})
