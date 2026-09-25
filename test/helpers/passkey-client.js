/**
 * Shared client-side steps for tests that only need to get PAST the passkey
 * gate to exercise something else (revisions, receipts, human-only checks,
 * ...) — not to test the gate itself. That belongs to test/passkey.test.js,
 * which drives the same ceremony in far more detail (replay, cross-ask,
 * cap, removal). Both call through `post`, the caller's own HTTP helper
 * (`(path, body, headers) => Promise<{status, json}>`), so this file makes
 * no assumption about a test's state dir, port, or daemon lifecycle.
 */
import assert from 'node:assert/strict'

import { createAuthenticator } from './authenticator.js'

/**
 * Enrolls the FIRST passkey for a daemon that has zero credentials — the one
 * window `src/passkey.js#registerOptions` leaves open with no prior
 * assertion. Call this once per daemon; a second call throws, because the
 * daemon no longer has zero credentials. Returns the software authenticator
 * device so the caller can build later approval assertions with it.
 */
export async function enrollPasskey(post, headers, { rpId, origin } = {}) {
  const options = await post('/api/passkeys/register/options', {}, headers)
  assert.equal(options.status, 200, JSON.stringify(options.json))
  const device = createAuthenticator({ rpId, origin })
  const credential = device.register(options.json.challenge)
  const registered = await post('/api/passkeys/register', { challenge_id: options.json.challenge_id, credential }, headers)
  assert.equal(registered.status, 200, JSON.stringify(registered.json))
  return device
}

/**
 * Fetches approve options for `ticket` on the human path and signs them with
 * `device`, returning the assertion body `/api/answer` (or a share link's
 * `/api/answer`, once the ticket and challenge already exist) expects at
 * `body.assertion`. The challenge is bound to this ticket's current revision
 * at fetch time, so call this right before the answer it gates.
 */
export async function approvalAssertion(post, headers, ticket, device) {
  const options = await post('/api/passkeys/approve/options', { ticket }, headers)
  assert.equal(options.status, 200, JSON.stringify(options.json))
  const built = device.assert(options.json.challenge)
  return { challenge_id: options.json.challenge_id, id: built.id, rawId: built.rawId, response: built.response }
}
