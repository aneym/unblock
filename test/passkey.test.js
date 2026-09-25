/**
 * The passkey gate, at the HTTP boundary, with a software authenticator that
 * builds real P-256 keys and real attestation/assertion bytes (see
 * test/helpers/authenticator.js). This exercises src/passkey.js and the gate
 * added to src/store.js#answer, not src/webauthn.js's own cryptography —
 * that lives in test/webauthn.test.js.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createAuthenticator } from './helpers/authenticator.js'

const state = mkdtempSync(join(process.env.UNBLOCK_TEST_TMPDIR || tmpdir(), 'unblock-passkey-'))
process.env.UNBLOCK_STATE_DIR = state
process.env.UNBLOCK_CONFIG_DIR = join(state, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
const origin = 'https://studio.tailnet.test:8797'
process.env.UNBLOCK_PUBLIC_ORIGIN = origin
process.env.UNBLOCK_TRUSTED_PROXY = 'tailscale'
process.env.UNBLOCK_ALLOWED_USERS = 'alex@example.test'
const rpId = 'studio.tailnet.test'

const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
const { Store } = await import('../src/store.js')
const secret = loadOrCreateSecret()
let daemon
const bearer = { Authorization: `Bearer ${secret}` }
const human = { Host: 'studio.tailnet.test:8797', 'tailscale-user-login': 'alex@example.test' }
let number = 0

test.before(async () => { daemon = await startDaemon({ port: 0 }) })
test.after(async () => { await daemon.close(); rmSync(state, { recursive: true, force: true }) })

function raw(path, { method = 'GET', headers = human, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1', port: daemon.port, path, method,
        headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          let json
          try { json = JSON.parse(bytes) } catch { /* not JSON */ }
          resolvePromise({ status: res.statusCode, json })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}
const post = (path, body, headers) => raw(path, { method: 'POST', body: body ?? {}, headers })
const get = (path, headers) => raw(path, { method: 'GET', headers })
const del = (path, body, headers) => raw(path, { method: 'DELETE', body: body ?? {}, headers })

const base = { kind: 'file', title: 'Action', why: 'This needs your approval.', tried: ['Checked the available tools and could not do it alone.'] }
const plan = { site: 'example.com', start_url: 'https://example.com/settings/new', steps: ['Open the settings page'], changes: 'Updates a setting', untouched: 'Other settings' }
const messageBody = { to: 'person@example.test', via: 'email', subject: 'Hello', text: 'Please review.' }
const spendBody = { item: 'Workspace subscription', vendor: 'Acme', vendor_url: 'https://example.com/checkout', amount_cents: 1500, cap_cents: 2000, currency: 'usd', why: 'Needed for the project' }
const permissionBody = { tool: 'Bash', command: 'cat /Users/alex/project', summary: 'Read a project file' }

function consentAsk(extra = {}) { return { ...base, title: `Consent ${++number}`, purpose: 'consent', only_you: 'their_account', plan, ...extra } }
function messageAsk(extra = {}) { return { ...base, title: `Message ${++number}`, purpose: 'message', only_you: 'message', message: messageBody, ...extra } }
function spendAsk(extra = {}) { return { ...base, title: `Spend ${++number}`, purpose: 'spend', only_you: 'spend', spend: spendBody, ...extra } }
function permissionAsk(extra = {}) { return { kind: 'file', title: `Permission ${++number}`, purpose: 'permission', why: 'This operation needs a person.', permission: permissionBody, ...extra } }

async function create(ask) {
  const result = await post('/api/asks', { ask }, bearer)
  assert.equal(result.status, 201, JSON.stringify(result.json))
  return result.json
}

/** Turns a raw authenticator assertion into the wire shape `store.answer` expects, bound to one challenge. */
function toAssertion(device, challengeId, challenge, opts) {
  const built = device.assert(challenge, opts)
  return { challenge_id: challengeId, id: built.id, rawId: built.rawId, response: built.response }
}

async function registerOptions(body) { return post('/api/passkeys/register/options', body, human) }
async function enrollAuthOptions() { return post('/api/passkeys/enroll-auth/options', {}, human) }
async function approveOptions(ticket) { return post('/api/passkeys/approve/options', { ticket }, human) }

/** Every enrolled device this file has created, in order — so later tests can pick a real, known credential id. */
const enrolledDevices = []

/** Enrolls the FIRST passkey (open with zero credentials). */
async function enrollFirst() {
  const options = await registerOptions({})
  assert.equal(options.status, 200, JSON.stringify(options.json))
  const device = createAuthenticator({ rpId, origin })
  const credential = device.register(options.json.challenge)
  const registered = await post('/api/passkeys/register', { challenge_id: options.json.challenge_id, credential }, human)
  assert.equal(registered.status, 200, JSON.stringify(registered.json))
  enrolledDevices.push(device)
  return { device, ...registered.json }
}

/** Enrolls one more passkey, authorized by an assertion from `authorizer`. */
async function enrollAdditional(authorizer) {
  const authOptions = await enrollAuthOptions()
  assert.equal(authOptions.status, 200, JSON.stringify(authOptions.json))
  const assertion = toAssertion(authorizer, authOptions.json.challenge_id, authOptions.json.challenge)
  const options = await registerOptions({ assertion })
  assert.equal(options.status, 200, JSON.stringify(options.json))
  const device = createAuthenticator({ rpId, origin })
  const credential = device.register(options.json.challenge)
  const registered = await post('/api/passkeys/register', { challenge_id: options.json.challenge_id, credential }, human)
  assert.equal(registered.status, 200, JSON.stringify(registered.json))
  enrolledDevices.push(device)
  return { device, ...registered.json }
}

test('fail closed: zero credentials refuse every passkey-gated verdict, no fallback to Tailscale headers', async () => {
  const consent = await create(consentAsk())
  const consentAnswer = await post('/api/answer', { ticket: consent.ticket, revision: 1, values: { verdict: 'approve' } }, human)
  assert.equal(consentAnswer.status, 403, JSON.stringify(consentAnswer.json))
  assert.equal(consentAnswer.json.code, 'PASSKEY_REQUIRED')

  const message = await create(messageAsk())
  const messageAnswer = await post('/api/answer', { ticket: message.ticket, revision: 1, values: { verdict: 'approve' } }, human)
  assert.equal(messageAnswer.status, 403, JSON.stringify(messageAnswer.json))
  assert.equal(messageAnswer.json.code, 'PASSKEY_REQUIRED')

  const permission = await create(permissionAsk())
  const permissionAnswer = await post('/api/answer', { ticket: permission.ticket, revision: 1, values: { verdict: 'allow_once' } }, human)
  assert.equal(permissionAnswer.status, 403, JSON.stringify(permissionAnswer.json))
  assert.equal(permissionAnswer.json.code, 'PASSKEY_REQUIRED')

  // The options route fails closed just as plainly, before any ceremony starts.
  const options = await approveOptions(consent.ticket)
  assert.equal(options.status, 403)
  assert.equal(options.json.code, 'PASSKEY_REQUIRED')
})

test('src/store.js also fails closed on zero credentials on its own, independent of the pre-check in src/passkey.js', async () => {
  // src/passkey.js's verifyApprovalAssertion() already refuses with zero
  // credentials before store.answer() is ever reached (the test above, at
  // the HTTP boundary). store.js keeps its own copy of that check too, so
  // it holds even for a caller that skips straight to store.answer() —
  // drive it directly, before any passkey has been enrolled in this file.
  const directStore = new Store()
  assert.equal(directStore.countCredentials(), 0)
  const ask = await create(consentAsk())
  assert.throws(
    () => directStore.answer(ask.ticket, { verdict: 'approve' }, {
      revision: 1, answeredVia: 'tailnet:alex@example.test',
      assertion: { challengeId: 'nonexistent', credentialId: 'nonexistent', newSignCount: 1 },
    }),
    (err) => err.code === 'PASSKEY_REQUIRED',
  )
})

test('spend approve, consent self, and permission deny need no assertion', async () => {
  const spend = await create(spendAsk())
  const spendAnswer = await post('/api/answer', { ticket: spend.ticket, revision: 1, values: { verdict: 'approve' } }, human)
  assert.equal(spendAnswer.status, 200, JSON.stringify(spendAnswer.json))
  assert.equal(spendAnswer.json.ask.answered_via, 'tailnet:alex@example.test')

  const consent = await create(consentAsk())
  const consentAnswer = await post('/api/answer', { ticket: consent.ticket, revision: 1, values: { verdict: 'self' } }, human)
  assert.equal(consentAnswer.status, 200, JSON.stringify(consentAnswer.json))
  assert.equal(consentAnswer.json.ask.answered_via, 'tailnet:alex@example.test')

  const permission = await create(permissionAsk())
  const permissionAnswer = await post('/api/answer', { ticket: permission.ticket, revision: 1, values: { verdict: 'deny' } }, human)
  assert.equal(permissionAnswer.status, 200, JSON.stringify(permissionAnswer.json))
  assert.equal(permissionAnswer.json.ask.answered_via, 'tailnet:alex@example.test')
})

test('passkey routes are human-path only: bearer secret is refused, and share links are refused outright', async () => {
  const consent = await create(consentAsk())
  const viaBearer = await post('/api/passkeys/register/options', {}, bearer)
  assert.equal(viaBearer.status, 403)
  assert.equal(viaBearer.json.code, 'HUMAN_ONLY')

  const link = await post('/api/links', { ticket: consent.ticket }, human)
  assert.equal(link.status, 201)
  const viaShareLink = await post(`/u/${link.json.token}/api/passkeys/approve/options`, { ticket: consent.ticket }, {})
  assert.equal(viaShareLink.status, 403)
  assert.equal(viaShareLink.json.code, 'PASSKEY_ON_SHARE_LINK')
})

let device1
let firstEventId

test('enrollment: open with zero credentials, gated afterwards, and it raises a banner event', async () => {
  // Someone else grabs an open-window challenge before the first enrollment...
  const early = await registerOptions({})
  assert.equal(early.status, 200, JSON.stringify(early.json))
  const first = await enrollFirst()
  // ...and cannot spend it once a passkey exists.
  const intruder = createAuthenticator({ rpId, origin })
  const late = await post('/api/passkeys/register', { challenge_id: early.json.challenge_id, credential: intruder.register(early.json.challenge) }, human)
  assert.equal(late.status, 403)
  assert.equal(late.json.code, 'PASSKEY_INVALID')
  device1 = first.device
  firstEventId = first.event_id
  assert.equal(typeof first.id_suffix, 'string')
  assert.equal(first.id_suffix.length, 8)

  const list = await get('/api/passkeys', human)
  assert.equal(list.status, 200)
  assert.equal(list.json.credentials.length, 1)
  assert.equal(list.json.credentials[0].id_suffix, first.id_suffix)
  assert.equal(list.json.banner.length, 1)
  assert.equal(list.json.banner[0].event_id, firstEventId)

  // A second enrollment with no assertion from the first key is refused.
  const bare = await registerOptions({})
  assert.equal(bare.status, 403)
  assert.equal(bare.json.code, 'PASSKEY_REQUIRED')

  const dismiss = await post('/api/passkeys/banner/dismiss', { event_id: firstEventId }, human)
  assert.equal(dismiss.status, 200)
  const afterDismiss = await get('/api/passkeys', human)
  assert.equal(afterDismiss.json.banner.some((e) => e.event_id === firstEventId), false)
})

test('a valid assertion approves, and answered_via records passkey:<id_suffix>', async () => {
  const consent = await create(consentAsk())
  const options = await approveOptions(consent.ticket)
  assert.equal(options.status, 200, JSON.stringify(options.json))
  const assertion = toAssertion(device1, options.json.challenge_id, options.json.challenge)
  const answered = await post('/api/answer', { ticket: consent.ticket, revision: 1, values: { verdict: 'approve' }, assertion }, human)
  assert.equal(answered.status, 200, JSON.stringify(answered.json))
  assert.equal(answered.json.ask.answered_via, `passkey:${device1.id.slice(-8)}`)
  assert.equal(answered.json.ask.status, 'answered')
})

test('replaying the same assertion and challenge on another answer attempt gets 403 PASSKEY_INVALID', async () => {
  const message = await create(messageAsk())
  const options = await approveOptions(message.ticket)
  const assertion = toAssertion(device1, options.json.challenge_id, options.json.challenge)
  const body = { ticket: message.ticket, revision: 1, values: { verdict: 'approve' }, assertion }
  const first = await post('/api/answer', body, human)
  assert.equal(first.status, 200, JSON.stringify(first.json))
  const replay = await post('/api/answer', body, human)
  assert.equal(replay.status, 403, JSON.stringify(replay.json))
  assert.equal(replay.json.code, 'PASSKEY_INVALID')
})

test('the challenge itself is single-use, independent of signCount: a counter-less authenticator repeating 0 is still refused', async () => {
  // signCount stays 0 on both calls, which the spec allows an authenticator
  // with no counter to do legitimately — so the ONLY thing that can catch a
  // replay here is the challenge's own used_at flag, not signCount.
  const zeroCounter = createAuthenticator({ rpId, origin })
  const enrollOptions = await enrollAuthOptions()
  const enrollAssertion = toAssertion(device1, enrollOptions.json.challenge_id, enrollOptions.json.challenge)
  const registerOpts = await registerOptions({ assertion: enrollAssertion })
  const credential = zeroCounter.register(registerOpts.json.challenge, { signCount: 0 })
  const registered = await post('/api/passkeys/register', { challenge_id: registerOpts.json.challenge_id, credential }, human)
  assert.equal(registered.status, 200, JSON.stringify(registered.json))
  enrolledDevices.push(zeroCounter)

  const ask = await create(consentAsk())
  const options = await approveOptions(ask.ticket)
  const assertion = toAssertion(zeroCounter, options.json.challenge_id, options.json.challenge, { signCount: 0 })
  const body = { ticket: ask.ticket, revision: 1, values: { verdict: 'approve' }, assertion }
  const first = await post('/api/answer', body, human)
  assert.equal(first.status, 200, JSON.stringify(first.json))
  const replay = await post('/api/answer', body, human)
  assert.equal(replay.status, 403, JSON.stringify(replay.json))
  assert.equal(replay.json.code, 'PASSKEY_INVALID')
})

test('an assertion for ask A is refused on ask B, and one for revision 1 is refused after an update to revision 2', async () => {
  const askA = await create(consentAsk())
  const askB = await create(consentAsk())
  const optionsForA = await approveOptions(askA.ticket)
  const assertionForA = toAssertion(device1, optionsForA.json.challenge_id, optionsForA.json.challenge)
  const crossAsk = await post('/api/answer', { ticket: askB.ticket, revision: 1, values: { verdict: 'approve' }, assertion: assertionForA }, human)
  assert.equal(crossAsk.status, 403, JSON.stringify(crossAsk.json))
  assert.equal(crossAsk.json.code, 'PASSKEY_INVALID')

  const askC = await create(consentAsk())
  const optionsAtRevision1 = await approveOptions(askC.ticket)
  const assertionAtRevision1 = toAssertion(device1, optionsAtRevision1.json.challenge_id, optionsAtRevision1.json.challenge)
  const updated = await post(`/api/asks/${askC.ticket}/update`, { plan: { ...plan, changes: 'A different change' } }, bearer)
  assert.equal(updated.status, 200, JSON.stringify(updated.json))
  assert.equal(updated.json.ask.revision, 2)
  const staleRevision = await post('/api/answer', { ticket: askC.ticket, revision: 2, values: { verdict: 'approve' }, assertion: assertionAtRevision1 }, human)
  assert.equal(staleRevision.status, 403, JSON.stringify(staleRevision.json))
  assert.equal(staleRevision.json.code, 'PASSKEY_INVALID')
})

test('src/store.js binds the challenge to its ask and revision on its own, independent of the pre-check in src/passkey.js', async () => {
  // src/passkey.js already refuses a cross-ask or cross-revision assertion
  // before src/store.js ever sees one (the test above). store.js repeats
  // that same check itself, inside the transaction that consumes the
  // challenge, to close the gap between that earlier check and the write —
  // so it needs its own test, driving store.answer() directly the way
  // src/daemon.js does once its own crypto check has already passed.
  const directStore = new Store()
  const credentialId = device1.id
  const signCount = () => directStore.listCredentials().find((c) => c.id === credentialId).signCount

  const askA = await create(consentAsk())
  const askB = await create(consentAsk())
  const optionsForA = await approveOptions(askA.ticket)
  const askBRow = directStore.get(askB.ticket)
  assert.throws(
    () => directStore.answer(askB.ticket, { verdict: 'approve' }, {
      revision: askBRow.revision, answeredVia: 'tailnet:alex@example.test',
      assertion: { challengeId: optionsForA.json.challenge_id, credentialId, newSignCount: signCount() + 1 },
    }),
    (err) => err.code === 'PASSKEY_INVALID',
  )

  const askC = await create(consentAsk())
  const optionsAtRevision1 = await approveOptions(askC.ticket)
  const updated = await post(`/api/asks/${askC.ticket}/update`, { plan: { ...plan, changes: 'Another change' } }, bearer)
  assert.equal(updated.status, 200, JSON.stringify(updated.json))
  const askCRow = directStore.get(askC.ticket)
  assert.equal(askCRow.revision, 2)
  assert.throws(
    () => directStore.answer(askC.ticket, { verdict: 'approve' }, {
      revision: askCRow.revision, answeredVia: 'tailnet:alex@example.test',
      assertion: { challengeId: optionsAtRevision1.json.challenge_id, credentialId, newSignCount: signCount() + 1 },
    }),
    (err) => err.code === 'PASSKEY_INVALID',
  )
})

test('UV=0, wrong origin, wrong rpIdHash, a bad signature, and a non-increasing signCount each get 403 PASSKEY_INVALID', async () => {
  async function expectInvalid(opts) {
    const ask = await create(consentAsk())
    const options = await approveOptions(ask.ticket)
    const assertion = toAssertion(device1, options.json.challenge_id, options.json.challenge, opts)
    const answer = await post('/api/answer', { ticket: ask.ticket, revision: 1, values: { verdict: 'approve' }, assertion }, human)
    assert.equal(answer.status, 403, JSON.stringify(answer.json))
    assert.equal(answer.json.code, 'PASSKEY_INVALID')
  }
  await expectInvalid({ flags: 0x01 }) // UP set, UV clear
  await expectInvalid({ origin: 'https://evil.example' })
  await expectInvalid({ rpId: 'evil.example' })
  await expectInvalid({ corruptSignature: true })

  // Non-increasing signCount needs a credential whose stored count is already
  // above zero, so enroll a fresh one, use it once for real, then replay 0.
  const fresh = await enrollAdditional(device1)
  const bump = await create(consentAsk())
  const bumpOptions = await approveOptions(bump.ticket)
  const bumpAssertion = toAssertion(fresh.device, bumpOptions.json.challenge_id, bumpOptions.json.challenge)
  const bumped = await post('/api/answer', { ticket: bump.ticket, revision: 1, values: { verdict: 'approve' }, assertion: bumpAssertion }, human)
  assert.equal(bumped.status, 200, JSON.stringify(bumped.json))

  const stale = await create(consentAsk())
  const staleOptions = await approveOptions(stale.ticket)
  const staleAssertion = toAssertion(fresh.device, staleOptions.json.challenge_id, staleOptions.json.challenge, { signCount: 0 })
  const staleAnswer = await post('/api/answer', { ticket: stale.ticket, revision: 1, values: { verdict: 'approve' }, assertion: staleAssertion }, human)
  assert.equal(staleAnswer.status, 403, JSON.stringify(staleAnswer.json))
  assert.equal(staleAnswer.json.code, 'PASSKEY_INVALID')
})

test('the enrollment log is tab-separated, mode 0600, and records the id prefix, AAGUID, and user agent', async () => {
  const fresh = await enrollAdditional(device1)
  const file = join(state, 'passkey-enrollments.log')
  const contents = readFileSync(file, 'utf8')
  const mode = statSync(file).mode & 0o777
  assert.equal(mode, 0o600)
  const lines = contents.trim().split('\n')
  const line = lines.find((l) => l.includes(fresh.device.id.slice(0, 8)))
  assert.ok(line, 'no log line for the new credential')
  const [iso, idPrefix, aaguid] = line.split('\t')
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(idPrefix, fresh.device.id.slice(0, 8))
  assert.match(aaguid, /^[0-9a-f]{32}$/)
})

test('removing a credential needs an assertion from a different passkey, unless it is the last one', async () => {
  // enrolledDevices[0] is device1, kept alive throughout the file as the
  // authorizer for later enrollments — remove a LATER one instead.
  assert.ok(enrolledDevices.length >= 3, 'need at least three enrolled devices for this test')
  const victim = enrolledDevices[1]

  // Using the victim's own assertion to remove itself is refused while other
  // credentials remain.
  const selfAuthOptions = await enrollAuthOptions()
  const selfAssertion = toAssertion(victim, selfAuthOptions.json.challenge_id, selfAuthOptions.json.challenge)
  const selfRemoval = await del(`/api/passkeys/${victim.id}`, { assertion: selfAssertion }, human)
  assert.equal(selfRemoval.status, 403, JSON.stringify(selfRemoval.json))
  assert.equal(selfRemoval.json.code, 'PASSKEY_INVALID')

  // A different, currently-enrolled key's assertion removes it cleanly.
  const authOptions = await enrollAuthOptions()
  const assertion = toAssertion(device1, authOptions.json.challenge_id, authOptions.json.challenge)
  const removed = await del(`/api/passkeys/${victim.id}`, { assertion }, human)
  assert.equal(removed.status, 200, JSON.stringify(removed.json))
  const afterRemoval = await get('/api/passkeys', human)
  assert.equal(afterRemoval.json.credentials.some((c) => c.id_suffix === victim.id.slice(-8)), false)
})

test('a sixth credential is refused with 409 PASSKEY_CAP', async () => {
  // Top up to exactly five, regardless of how many earlier tests enrolled
  // (and the previous test just removed one), then push a sixth.
  let count = (await get('/api/passkeys', human)).json.credentials.length
  while (count < 5) { await enrollAdditional(device1); count += 1 }
  assert.equal((await get('/api/passkeys', human)).json.credentials.length, 5)

  const sixthAuthOptions = await enrollAuthOptions()
  const sixthAssertion = toAssertion(device1, sixthAuthOptions.json.challenge_id, sixthAuthOptions.json.challenge)
  const sixthOptions = await registerOptions({ assertion: sixthAssertion })
  assert.equal(sixthOptions.status, 200, JSON.stringify(sixthOptions.json))
  const overflowDevice = createAuthenticator({ rpId, origin })
  const overflowCredential = overflowDevice.register(sixthOptions.json.challenge)
  const overflow = await post('/api/passkeys/register', { challenge_id: sixthOptions.json.challenge_id, credential: overflowCredential }, human)
  assert.equal(overflow.status, 409, JSON.stringify(overflow.json))
  assert.equal(overflow.json.code, 'PASSKEY_CAP')
  assert.equal((await get('/api/passkeys', human)).json.credentials.length, 5)
})
