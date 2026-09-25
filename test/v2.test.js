import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { approvalAssertion, enrollPasskey } from './helpers/passkey-client.js'

const state = mkdtempSync(join(process.env.UNBLOCK_TEST_TMPDIR || tmpdir(), 'unblock-v2-'))
process.env.UNBLOCK_STATE_DIR = state
process.env.UNBLOCK_CONFIG_DIR = join(state, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
process.env.UNBLOCK_PUBLIC_ORIGIN = 'https://studio.tailnet.test:8797'
process.env.UNBLOCK_TRUSTED_PROXY = 'tailscale'
process.env.UNBLOCK_ALLOWED_USERS = 'alex@example.test'
const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const token = loadOrCreateSecret()
let daemon
const auth = { Authorization: `Bearer ${token}` }
const human = { Host: 'studio.tailnet.test:8797', 'tailscale-user-login': 'alex@example.test' }
const rp = { rpId: 'studio.tailnet.test', origin: process.env.UNBLOCK_PUBLIC_ORIGIN }
let number = 0
const base = { kind: 'file', title: 'Action', why: 'This needs your approval.', tried: ['Checked the available tools and could not do it alone.'] }
const plan = { site: 'example.com', start_url: 'https://example.com/settings/new', steps: ['Open the settings page'], changes: 'Updates a setting', untouched: 'Other settings' }
const spend = { item: 'Workspace subscription', vendor: 'Acme', vendor_url: 'https://example.com/checkout', amount_cents: 1500, cap_cents: 2000, currency: 'usd', why: 'Needed for the project' }
const message = { to: 'person@example.test', via: 'email', subject: 'Hello', text: 'Please review.' }
function shape(purpose) { return { ...base, title: `Request ${++number}`, purpose, only_you: { consent: 'their_account', spend: 'spend', message: 'message' }[purpose], ...(purpose === 'consent' ? { plan } : purpose === 'spend' ? { spend } : { message }) } }
function raw(path, { method = 'GET', headers = auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method, headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => { const bytes = Buffer.concat(chunks); let json; try { json = JSON.parse(bytes) } catch {} resolve({ status: res.statusCode, json, bytes }) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const post = (path, body, headers) => raw(path, { method: 'POST', body, headers })
async function create(ask) { const result = await post('/api/asks', { ask }); assert.equal(result.status, 201, JSON.stringify(result.json)); return result.json }
async function approve(ask, values = { verdict: 'approve' }, assertion) { return post('/api/answer', { ticket: ask.ticket, revision: ask.revision, values, assertion }, human) }

/**
 * `consent approve`, `message approve` and `permission allow_once` are
 * passkey-gated (src/passkey.js, src/store.js#answer) — this file is not
 * about that gate (test/passkey.test.js owns it in detail), so it enrolls
 * ONE software passkey the first time a test needs to get past it, and
 * reuses that same device for every later gated approval in this file.
 */
let passkey
async function getPasskey() { return passkey ??= await enrollPasskey(post, human, rp) }
async function gatedAssertion(ticket) { return approvalAssertion(post, human, ticket, await getPasskey()) }
function cli(...args) { return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin/unblock.js'), ...args], { env: { ...process.env, UNBLOCK_PORT: String(daemon.port), UNBLOCK_STATE_DIR: state, UNBLOCK_LINK_CLI: join(state, 'fake-link') } })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('error', reject)
  child.on('close', (status) => resolve({ status, stdout, stderr }))
}) }

test.before(async () => { daemon = await startDaemon({ port: 0 }) })
test.after(async () => { await daemon.close(); rmSync(state, { recursive: true, force: true }) })

test('filing validation and generated fields through HTTP', async () => {
  for (const [ask, match] of [
    [{ ...shape('consent'), plan: undefined }, /plan/],
    [{ ...shape('consent'), plan: { ...plan, steps: ['Click Sign out'] } }, /stay Alex's own click/],
    [{ ...shape('consent'), plan: { ...plan, start_url: 'https://accounts.google.com/settings/new', site: 'accounts.google.com' } }, /stay Alex's own click/],
    [{ ...shape('consent'), plan: { ...plan, site: 'other.com' } }, /must match/],
    [{ ...shape('consent'), fields: [{ name: 'x', type: 'text' }] }, /fields/],
    [{ ...base, title: `Block ${++number}`, only_you: 'their_account', fields: [{ name: 'ok', type: 'confirm' }], links: [{ url: 'https://example.com/settings/new' }] }, /consent_blocked_by/],
    [{ ...shape('spend'), spend: { ...spend, currency: 'eur' } }, /usd/],
    [{ ...shape('spend'), spend: { ...spend, cap_cents: 1499 } }, /cap/],
    [{ ...shape('spend'), spend: { ...spend, amount_cents: 50001, cap_cents: 50001 } }, /50000/],
  ]) { const response = await post('/api/asks', { ask }); assert.equal(response.status, 400, JSON.stringify(response.json)); assert.match(response.json.error, match) }
  const blocker = await create({ ...base, title: `Block ${++number}`, only_you: 'their_account', consent_blocked_by: 'sign_in', fields: [{ name: 'ok', type: 'confirm' }], links: [{ url: 'https://example.com/settings/new' }] })
  assert.equal(blocker.consent_blocked_by, 'sign_in')
  for (const [key, value] of [['item', '-merchant-name=Evil'], ['item', 'One,quantity:50'], ['vendor', '--include'], ['vendor', 'Acme:other']]) {
    const invalidSpend = await post('/api/asks', { ask: { ...shape('spend'), spend: { ...spend, [key]: value } } })
    assert.equal(invalidSpend.status, 400)
    assert.equal(invalidSpend.json.path, `spend.${key}`)
  }
  for (const purpose of ['consent', 'spend', 'message']) {
    const ask = await create(shape(purpose))
    assert.equal(ask.revision, 1)
    assert.deepEqual(ask.fields.map((f) => f.name), purpose === 'message' ? ['verdict', 'edited_text'] : ['verdict', 'note'])
    assert.deepEqual(ask.fields[0].choices.map((c) => c.value), purpose === 'consent' ? ['approve', 'self', 'no'] : ['approve', 'no'])
    const expected = {
      consent: [{ name: 'verdict', type: 'choice', label: 'Your call', required: true, must_decide: true, choices: [
        { value: 'approve', label: 'Approve: do it for me' }, { value: 'self', label: "I'll do it myself" }, { value: 'no', label: 'No' },
      ] }, { name: 'note', type: 'text', label: 'Anything to change in the plan', required: false }],
      spend: [{ name: 'verdict', type: 'choice', label: 'Pay this?', required: true, must_decide: true, choices: [
        { value: 'approve', label: 'Approve payment' }, { value: 'no', label: 'No' },
      ] }, { name: 'note', type: 'text', label: 'Note', required: false }],
      message: [{ name: 'verdict', type: 'choice', label: 'Send it?', required: true, must_decide: true, choices: [
        { value: 'approve', label: 'Approve and send' }, { value: 'no', label: 'No' },
      ] }, { name: 'edited_text', type: 'text', multiline: true, label: 'Your edit', required: false }],
    }
    assert.deepEqual(ask.fields, expected[purpose])
  }
})

test('human-only, strict verdict, revision, immutable answered ask', async () => {
  const ask = await create(shape('consent'))
  const path = `/api/asks/${ask.ticket}`
  assert.equal((await post(`${path}/answer`, { revision: 1, values: { verdict: 'approve' } })).json.code, 'HUMAN_ONLY')
  assert.equal((await cli('answer', ask.ticket, 'approve')).status, 4)
  for (const draftPath of [`${path}/draft`, '/api/draft']) {
    const denied = await post(draftPath, { ticket: ask.ticket, values: { verdict: 'approve' } })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.code, 'HUMAN_ONLY')
  }
  const drafted = await post('/api/draft', { ticket: ask.ticket, values: { verdict: 'approve', note: 'typed' } }, human)
  assert.equal(drafted.status, 200)
  assert.equal(drafted.json.ask.draft.verdict, undefined)
  assert.equal(drafted.json.ask.draft.note, 'typed')
  const localLink = await post('/api/links', { ticket: ask.ticket })
  assert.equal(localLink.status, 201)
  const deniedLink = await post(`/u/${localLink.json.token}/api/answer`, { ticket: ask.ticket, revision: 1, values: { verdict: 'approve' } }, {})
  assert.equal(deniedLink.status, 403)
  assert.equal(deniedLink.json.code, 'HUMAN_ONLY')
  const deniedLinkDraft = await post(`/u/${localLink.json.token}/api/draft`, { ticket: ask.ticket, values: { note: 'draft' } }, {})
  assert.equal(deniedLinkDraft.status, 403)
  assert.equal(deniedLinkDraft.json.code, 'HUMAN_ONLY')
  const shared = await create(shape('message'))
  const sharedLink = await post('/api/links', { ticket: shared.ticket }, human)
  // Even a valid assertion cannot be submitted through a share link; it
  // must remain usable on the human path after that refusal.
  const sharedAssertion = await gatedAssertion(shared.ticket)
  const sharedAnswer = await post(`/u/${sharedLink.json.token}/api/answer`, { ticket: shared.ticket, revision: 1, values: { verdict: 'approve' }, assertion: sharedAssertion }, {})
  assert.equal(sharedAnswer.status, 403, JSON.stringify(sharedAnswer.json))
  assert.equal(sharedAnswer.json.code, 'PASSKEY_ON_SHARE_LINK')
  assert.equal((await raw(`/api/asks/${shared.ticket}`, { headers: human })).json.status, 'open')
  const humanAnswer = await approve(shared, { verdict: 'approve' }, sharedAssertion)
  assert.equal(humanAnswer.status, 200, JSON.stringify(humanAnswer.json))
  assert.equal(humanAnswer.json.ask.answered_via, `passkey:${passkey.id.slice(-8)}`)

  const updated = await post(`${path}/update`, { plan: { ...plan, changes: 'Different setting' } })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.ask.revision, 2)
  assert.deepEqual(updated.json.ask.draft, {})
  for (const [body, status, code] of [
    [{ revision: 1, values: { verdict: 'approve' } }, 409, 'STALE_REVISION'],
    [{ revision: 2, values: { verdict: null } }, 400, 'INVALID_VERDICT'],
    [{ revision: 2, values: { verdict: 'maybe' } }, 400, 'INVALID_VERDICT'],
    [{ revision: 2, values: { verdict: 'approve', note: 'change it' } }, 400, 'NOTE_MEANS_CHANGE'],
    [{ revision: 2, values: { verdict: 'approve' }, reply: 'change it' }, 400, 'NOTE_MEANS_CHANGE'],
    [{ revision: 2, values: { verdict: 'approve' }, field_context: { note: 'change it' } }, 400, 'NOTE_MEANS_CHANGE'],
  ]) {
    // A real assertion is fetched whenever the sent verdict is the gated one
    // ('approve'), so the request reaches ITS OWN check (stale revision,
    // invalid verdict, note-means-change) instead of stopping earlier at the
    // passkey gate for lack of an assertion.
    const assertion = body.values?.verdict === 'approve' ? await gatedAssertion(ask.ticket) : undefined
    const result = await post('/api/answer', { ticket: ask.ticket, ...body, assertion }, human)
    assert.equal(result.status, status)
    assert.equal(result.json.code, code)
  }
  const rejectedFields = await post(`${path}/update`, { add_fields: [] }); assert.equal(rejectedFields.status, 400); assert.equal(rejectedFields.json.path, 'fields')
  const approveAssertion = await gatedAssertion(ask.ticket)
  const approved = await approve(updated.json.ask, { verdict: 'approve' }, approveAssertion)
  assert.equal(approved.status, 200, JSON.stringify(approved.json))
  assert.equal(approved.json.ask.answered_via, `passkey:${passkey.id.slice(-8)}`)
  // A second answer against the now-answered ask still needs a real,
  // unconsumed assertion to get PAST the passkey gate at all — otherwise it
  // reads PASSKEY_REQUIRED, not the ASK_NOT_OPEN this checks for — so a
  // fresh one is fetched for the same (unchanged) revision before retrying.
  const secondAssertion = await gatedAssertion(ask.ticket)
  const secondAnswer = await approve(updated.json.ask, { verdict: 'approve' }, secondAssertion)
  assert.equal(secondAnswer.status, 409); assert.equal(secondAnswer.json.code, 'ASK_NOT_OPEN')
  const answeredUpdate = await post(`${path}/update`, { title: 'Altered' }); assert.equal(answeredUpdate.status, 409); assert.equal(answeredUpdate.json.code, 'ASK_NOT_OPEN')
})

test('receipts enforce scope, file bounds, and authenticated reads', async () => {
  const ask = await create(shape('consent'))
  const path = `/api/asks/${ask.ticket}/receipt`
  assert.equal((await post(path, {})).json.code, 'RECEIPT_NOT_ALLOWED')
  const badTicket = await post('/api/asks/ub_INVALID/receipt', {}); assert.equal(badTicket.status, 400); assert.equal(badTicket.json.error, 'invalid ticket')
  const approved = await approve(ask, { verdict: 'approve' }, await gatedAssertion(ask.ticket))
  assert.equal(approved.status, 200, JSON.stringify(approved.json))
  const collected = await post(`/api/asks/${ask.ticket}/collect`, {})
  assert.equal(collected.json.ask.status, 'collected')
  const png = join(state, 'source.png')
  writeFileSync(png, Buffer.from([137,80,78,71,13,10,26,10,0]))
  const symlink = join(state, 'symlink.png')
  symlinkSync(png, symlink)
  const invalid = join(state, 'invalid.png')
  writeFileSync(invalid, 'not png')
  const huge = join(state, 'huge.png')
  writeFileSync(huge, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(5 * 1024 * 1024)]))
  for (const file of [symlink, invalid, huge]) { const rejected = await post(path, { before: file }); assert.equal(rejected.status, 400); assert.equal(rejected.json.error, 'invalid PNG file') }
  const directoryAsk = await create(shape('consent'))
  const directoryApproved = await approve(directoryAsk, { verdict: 'approve' }, await gatedAssertion(directoryAsk.ticket))
  assert.equal(directoryApproved.status, 200, JSON.stringify(directoryApproved.json))
  const receiptRoot = join(state, 'receipts')
  mkdirSync(receiptRoot, { recursive: true })
  const redirected = join(receiptRoot, directoryAsk.ticket)
  const elsewhere = join(state, 'elsewhere')
  mkdirSync(elsewhere)
  symlinkSync(elsewhere, redirected)
  const refusedDirectory = await post(`/api/asks/${directoryAsk.ticket}/receipt`, { before: png })
  assert.equal(refusedDirectory.status, 400)
  assert.equal(refusedDirectory.json.error, 'invalid receipt directory')
  rmSync(redirected)
  const result = await post(path, { before: png, final_url: 'https://example.com/settings/new' })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  assert.equal(result.json.ask.receipt.before, true)
  const served = await raw(`${path}/before.png`)
  assert.equal(served.status, 200)
  assert.deepEqual(served.bytes, readFileSync(png))
  const unauthenticated = await raw(`${path}/before.png`, { headers: {} }); assert.equal(unauthenticated.status, 401); assert.equal(unauthenticated.json.error, 'unauthorized')
  const wrongHost = await raw(`${path}/before.png`, { headers: { Host: 'evil.example' } }); assert.equal(wrongHost.status, 403); assert.equal(wrongHost.json.error, 'invalid host')
})

test('pay claims and CLI mask card output and errors', async () => {
  writeFileSync(join(state, 'fake-link'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${join(state, 'args')}'\nif [ -f '${join(state, 'fail')}' ]; then echo sk_live_SECRET >&2; exit 1; fi\necho '{"id":"sr_test","status":"pending","number":"4242424242424242"}'\n`, { mode: 0o700 })
  const waiting = await create(shape('spend'))
  assert.equal((await cli('pay', waiting.ticket)).status, 5)
  await approve(waiting)
  const collected = await post(`/api/asks/${waiting.ticket}/collect`, {})
  assert.equal(collected.json.ask.status, 'collected')
  const rejectedMethod = await cli('pay', waiting.ticket, '--payment-method', '--include')
  assert.equal(rejectedMethod.status, 4)
  assert.match(rejectedMethod.stderr, /invalid payment method/)
  const paid = await cli('pay', waiting.ticket, '--payment-method', 'pm_safe_1')
  assert.equal(paid.status, 0, paid.stderr)
  assert.match(paid.stdout, /sr_test.*pending/)
  assert.doesNotMatch(paid.stdout + paid.stderr, /4242424242424242/)
  const args = readFileSync(join(state, 'args'), 'utf8')
  assert.match(args, new RegExp(`--idempotency-key=unblock-${waiting.ticket}-r1`))
  assert.doesNotMatch(args, /--include|--output-file/)
  assert.match(args, /--payment-method-id=pm_safe_1/)
  assert.equal((await cli('pay', waiting.ticket)).status, 5)
  const retry = await create(shape('spend'))
  await approve(retry)
  const first = await post(`/api/asks/${retry.ticket}/pay-claim`, {})
  assert.equal(first.json.is_new, true)
  const second = await cli('pay', retry.ticket)
  assert.equal(second.status, 0, second.stderr)
  assert.match(readFileSync(join(state, 'args'), 'utf8'), new RegExp(`--idempotency-key=unblock-${retry.ticket}-r1`))
  const failing = await create(shape('spend'))
  await approve(failing)
  writeFileSync(join(state, 'fail'), '')
  const failed = await cli('pay', failing.ticket)
  assert.equal(failed.status, 1)
  assert.doesNotMatch(failed.stdout + failed.stderr, /sk_live_SECRET/)
})

test('revision two metadata and relay shapes cross HTTP and CLI', async () => {
  const rich = { ...shape('consent'), summary: 'Approve a setting update', minutes: 5,
    after: 'The agent verifies the setting', blocks: ['Calendar on staging', 'nightly import'],
    steps: ['Open the settings page'], links: [{ url: 'https://example.com/settings/new' }] }
  const filed = await create(rich)
  for (const key of ['summary', 'minutes', 'after', 'blocks', 'steps']) assert.deepEqual(filed[key], rich[key])
  assert.equal(filed.links[0].url, rich.links[0].url)
  const printed = await cli('show', filed.ticket)
  assert.equal(printed.status, 0, printed.stderr)
  for (const word of ['Approve a setting update', '~5 min', 'Calendar on staging', 'The agent verifies the setting']) assert.ok(printed.stdout.includes(word), word)
  const listed = await cli('list')
  assert.equal(listed.status, 0, listed.stderr)
  assert.ok(listed.stdout.includes('~5 min'))
  assert.ok(listed.stdout.includes('unblocks: Calendar on staging, nightly import'))
  const changed = { summary: 'Approve the revised setting', minutes: 10, after: 'The agent continues', blocks: ['nightly import'] }
  const revised = await post(`/api/asks/${filed.ticket}/update`, changed)
  assert.equal(revised.status, 200, JSON.stringify(revised.json))
  assert.equal(revised.json.ask.revision, 2)
  for (const [key, value] of Object.entries(changed)) assert.deepEqual(revised.json.ask[key], value)

  const question = await create({ kind: 'file', title: `Question ${++number}`, purpose: 'question', why: 'Choose the response format.',
    steps: ['Review the available options'], fields: [
      { name: 'format', step: 1, type: 'choice', label: 'Preferred format', multi: true,
        choices: [{ value: 'a', label: 'First', description: 'A brief response' }, { value: 'b', label: 'Second', description: 'A long response' }] },
      { name: 'other', type: 'text', label: 'Other', required: false },
    ] })
  assert.equal(question.only_you, null)
  assert.deepEqual(question.tried, [])
  assert.equal(question.fields[0].step, 1)
  assert.equal(question.fields[0].choices[0].description, 'A brief response')
  const changedQuestion = await post(`/api/asks/${question.ticket}/update`, { steps: ['Review the available options', 'Pick another format'],
    add_fields: [{ name: 'format', step: 2, type: 'choice', label: 'Preferred format', choices: [{ value: 'a', label: 'First', description: 'Small' }, { value: 'b', label: 'Second' }] }] })
  assert.equal(changedQuestion.status, 200, JSON.stringify(changedQuestion.json))
  assert.equal(changedQuestion.json.ask.fields[0].step, 2)
  assert.equal(changedQuestion.json.ask.fields[0].choices[0].description, 'Small')
})

test('revision two approval send-back and permission human gate', async () => {
  const permission = { kind: 'file', purpose: 'permission', title: `Permission ${++number}`, why: 'This operation needs a person.',
    permission: { tool: 'Bash', command: 'cat /Users/alex/project', path: '/Users/alex/project', summary: 'Read a project file' } }
  const filed = await create(permission)
  assert.deepEqual(filed.permission, permission.permission)
  assert.deepEqual(filed.fields, [
    { name: 'verdict', type: 'choice', label: 'Allow this?', required: true, must_decide: true,
      choices: [{ value: 'allow_once', label: 'Allow once' }, { value: 'deny', label: 'Deny' }] },
    { name: 'note', type: 'text', label: 'Note to the agent', required: false },
  ])
  assert.equal(filed.only_you, null)
  assert.deepEqual(filed.tried, [])
  const bearer = await post('/api/answer', { ticket: filed.ticket, revision: 1, values: { verdict: 'allow_once' } })
  assert.equal(bearer.status, 403)
  assert.equal(bearer.json.code, 'HUMAN_ONLY')
  const bouncedField = await post('/api/answer', { ticket: filed.ticket, revision: 1, values: { verdict: 'deny' }, field_bounce: { verdict: 'No' } }, human)
  assert.equal(bouncedField.status, 400)
  assert.equal(bouncedField.json.code, 'WHOLE_ASK_ONLY')
  for (const headers of [auth, human]) {
    const body = { ticket: filed.ticket, revision: 1, bounce: true, reply: 'Please clarify the scope.' }
    const response = await post('/api/answer', body, headers)
    if (headers === auth) { assert.equal(response.status, 403); assert.equal(response.json.code, 'HUMAN_ONLY') }
    else { assert.equal(response.status, 200, JSON.stringify(response.json)); assert.equal(response.json.ask.status, 'bounced'); assert.equal(response.json.ask.reply, body.reply) }
  }
  const allowed = await create({ ...permission, title: `Permission ${++number}` })
  const allowedAssertion = await gatedAssertion(allowed.ticket)
  const approved = await post('/api/answer', { ticket: allowed.ticket, revision: 1, values: { verdict: 'allow_once' }, assertion: allowedAssertion }, human)
  assert.equal(approved.status, 200, JSON.stringify(approved.json))
  assert.equal(approved.json.ask.answers.verdict, 'allow_once')
  assert.equal(approved.json.ask.answered_via, `passkey:${passkey.id.slice(-8)}`)
  const revised = await create({ ...permission, title: `Permission ${++number}` })
  const updated = await post(`/api/asks/${revised.ticket}/update`, { permission: { ...permission.permission, summary: 'Read only one file' } })
  assert.equal(updated.status, 200, JSON.stringify(updated.json))
  assert.equal(updated.json.ask.revision, 2)
  assert.equal(updated.json.ask.permission.summary, 'Read only one file')
})

test('revision two validates step indexes and option descriptions', async () => {
  const ask = { ...base, title: `Step ${++number}`, only_you: 'message', steps: ['Open the page'],
    fields: [{ name: 'result', type: 'text', label: 'Result', step: 2 }] }
  const invalid = await post('/api/asks', { ask })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.path, 'fields[0].step')
  const valid = await create({ ...ask, title: `Step ${++number}`, fields: [{ ...ask.fields[0], step: 1 }] })
  const update = await post(`/api/asks/${valid.ticket}/update`, { steps: [] })
  assert.equal(update.status, 400)
  assert.equal(update.json.path, 'fields[0].step')
  const question = { kind: 'file', purpose: 'question', title: `Question ${++number}`, why: 'Choose how to proceed.',
    fields: [{ name: 'pick', type: 'choice', label: 'Pick one', choices: [{ value: 'a', label: 'A', description: 'x'.repeat(201) }, { value: 'b', label: 'B' }] }] }
  const badDescription = await post('/api/asks', { ask: question })
  assert.equal(badDescription.status, 400)
  assert.equal(badDescription.json.path, 'fields[0].choices[0].description')
})

test('revision two queue order prioritizes parked, dependencies, age', async () => {
  const requests = [
    { ticket: 'old', created_at: 1, blocks: [], gating: false },
    { ticket: 'busy', created_at: 3, blocks: ['one', 'two'], gating: false },
    { ticket: 'parked', created_at: 4, blocks: [], gating: true },
    { ticket: 'middle', created_at: 2, blocks: ['one'], gating: false },
  ]
  const { sortAsks } = await import('../src/queue-model.js')
  assert.deepEqual(sortAsks(requests).map(({ ticket }) => ticket), ['parked', 'busy', 'middle', 'old'])
})

test('question recommendations validate choice membership at HTTP boundary', async () => {
  const ask = { kind: 'file', purpose: 'question', title: `Recommended question ${++number}`, why: 'Choose a deployment format.',
    fields: [
      { name: 'mode', type: 'choice', label: 'Format', choices: [{ value: 'compact', label: 'Compact' }, { value: 'full', label: 'Full' }],
        recommend: { value: 'compact', why: 'It is easier to read' } },
      { name: 'other', type: 'text', label: 'Other answer', required: false, recommend: { value: 'Another approach', why: 'If neither fits' } },
    ] }
  const accepted = await create(ask)
  assert.deepEqual(accepted.fields.map((field) => field.recommend), ask.fields.map((field) => field.recommend))
  const invalid = await post('/api/asks', { ask: { ...ask, title: `Invalid recommendation ${++number}`,
    fields: [{ ...ask.fields[0], recommend: { value: 'unknown', why: 'Not a declared option' } }] } })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.path, 'fields[0].recommend.value')
})
