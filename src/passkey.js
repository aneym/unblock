/**
 * Passkey enrollment and approval: the crypto and the challenge bookkeeping
 * that sit between the daemon's HTTP routes and the store's tables.
 *
 * Why this exists at all: every agent on this machine runs as the same macOS
 * user as tailscaled, so a forged `Tailscale-User-Login` header proves
 * nothing (see the spec's "Passkey gate" section). A WebAuthn assertion with
 * user verification is the one thing an agent cannot fabricate, so
 * `consent approve`, `message approve` and `permission allow_once` go through
 * Touch ID on top of the existing human-path check. Spend does not: Link's
 * own push to Alex's phone is spend's human check.
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { PASSKEY_CREDENTIAL_CAP } from './store.js'
import { b64url, verifyAssertion, verifyRegistration, WebAuthnError } from './webauthn.js'

const CHALLENGE_TTL_MS = 120_000
// A fixed, non-secret user handle: there is exactly one human this daemon serves.
const FIXED_USER_ID = Buffer.alloc(16)

function fail(code, message, status) {
  const err = new Error(message)
  err.code = code
  err.status = status
  throw err
}

function clip(value, max) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .slice(0, max)
}

/** `rpId` is the hostname of `UNBLOCK_PUBLIC_ORIGIN`; the expected origin is that value exactly. */
export function relyingParty() {
  const origin = process.env.UNBLOCK_PUBLIC_ORIGIN
  if (!origin) return null
  try {
    return { origin, rpId: new URL(origin).hostname }
  } catch {
    return null
  }
}

function requireRp() {
  const rp = relyingParty()
  if (!rp) fail('PASSKEY_REQUIRED', 'no public origin is configured', 403)
  return rp
}

function credentialsPublic(store) {
  return store.listCredentials().map((c) => ({ id: c.id, type: 'public-key' }))
}

/**
 * Verify a browser assertion against its stored challenge and credential.
 * Pure: it reads the store but writes nothing, so a bad assertion leaves no
 * trace. The caller consumes the challenge (and, for `approve`, records the
 * answer) afterwards, inside its own transaction.
 */
function verifyWithChallenge(store, assertion, kind, rp) {
  if (!assertion || typeof assertion !== 'object') fail('PASSKEY_REQUIRED', 'a passkey assertion is required', 403)
  const challenge = store.getChallenge(assertion.challenge_id)
  if (!challenge || challenge.kind !== kind) fail('PASSKEY_INVALID', 'unknown or expired challenge', 403)
  const credential = store.getCredential(assertion.id)
  if (!credential) fail('PASSKEY_INVALID', 'unknown credential', 403)
  let verified
  try {
    verified = verifyAssertion({
      assertion,
      expectedChallenge: b64url(challenge.challenge),
      expectedOrigin: rp.origin,
      rpId: rp.rpId,
      credential: { id: credential.id, publicKeyJwk: credential.publicKeyJwk, alg: credential.alg, signCount: credential.signCount },
    })
  } catch (error) {
    if (error instanceof WebAuthnError) fail('PASSKEY_INVALID', error.message, 403)
    throw error
  }
  return { challenge, credential, newSignCount: verified.newSignCount }
}

/**
 * `POST /api/passkeys/register/options`. Open while there are zero
 * credentials (first enrollment closes the window); afterwards an existing
 * passkey must approve the new one via a fresh `enroll_auth` challenge.
 */
export function registerOptions(store, body) {
  const rp = requireRp()
  const existing = store.listCredentials()
  if (existing.length) {
    const { challenge, credential, newSignCount } = verifyWithChallenge(store, body?.assertion, 'enroll_auth', rp)
    if (!store.consumeChallenge(challenge.id, { kind: 'enroll_auth' }))
      fail('PASSKEY_INVALID', 'the passkey assertion is invalid, expired, or already used', 403)
    store.updateCredentialSignCount(credential.id, newSignCount)
  }
  const challenge = randomBytes(32)
  const challengeId = store.saveChallenge({ kind: 'register', challenge, ttlMs: CHALLENGE_TTL_MS, authorized: existing.length > 0 })
  return {
    challenge_id: challengeId,
    rp: { id: rp.rpId, name: 'unblock' },
    user: { id: b64url(FIXED_USER_ID), name: 'alex', displayName: 'Alex' },
    challenge: b64url(challenge),
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },
      { alg: -257, type: 'public-key' },
    ],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    attestation: 'none',
    excludeCredentials: credentialsPublic(store),
  }
}

/** `POST /api/passkeys/enroll-auth/options`: a challenge an existing credential signs to approve a new one, or to remove one. */
export function enrollAuthOptions(store) {
  const rp = requireRp()
  const challenge = randomBytes(32)
  const challengeId = store.saveChallenge({ kind: 'enroll_auth', challenge, ttlMs: CHALLENGE_TTL_MS })
  return {
    challenge_id: challengeId,
    challenge: b64url(challenge),
    rpId: rp.rpId,
    allowCredentials: credentialsPublic(store),
    userVerification: 'required',
    timeout: 60000,
  }
}

/** `POST /api/passkeys/register`. Verifies, stores the credential, logs the enrollment, and raises the "not you?" banner event. */
export function register(store, body, { userAgent, logDir } = {}) {
  const rp = requireRp()
  const challenge = store.getChallenge(body?.challenge_id)
  if (!challenge || challenge.kind !== 'register') fail('PASSKEY_INVALID', 'unknown or expired challenge', 403)
  // A challenge handed out while enrollment was open (no passkeys yet) must
  // not outlive that window: once any passkey exists, only a challenge an
  // existing passkey signed off on can add another.
  let verified
  try {
    verified = verifyRegistration({ credential: body?.credential, expectedChallenge: b64url(challenge.challenge), expectedOrigin: rp.origin, rpId: rp.rpId })
  } catch (error) {
    if (error instanceof WebAuthnError) fail('PASSKEY_INVALID', error.message, 403)
    throw error
  }
  return store.transaction(() => {
    if (!challenge.authorized && store.countCredentials() > 0)
      fail('PASSKEY_INVALID', 'a passkey was added meanwhile; approve this one with it', 403)
    if (!store.consumeChallenge(challenge.id, { kind: 'register' }, { inTransaction: true }))
      fail('PASSKEY_INVALID', 'the passkey assertion is invalid, expired, or already used', 403)
    const label = `Passkey · ${new Date().toISOString().slice(0, 10)}`
    store.addCredential({
      id: verified.credentialId,
      publicKeyJwk: verified.publicKeyJwk,
      alg: verified.alg,
      signCount: verified.signCount,
      label,
      createdVia: 'enrollment',
      userAgent: clip(userAgent, 200),
    })
    const event = store.addPasskeyEvent({ kind: 'enrolled', credentialId: verified.credentialId, label, via: 'enrollment' })
    appendEnrollmentLog(logDir, { credentialId: verified.credentialId, aaguid: verified.aaguid, userAgent })
    return { id_suffix: verified.credentialId.slice(-8), label, event_id: event.id }
  })
}

export function listPasskeys(store) {
  return {
    credentials: store.listCredentials().map((c) => ({ id_suffix: c.id.slice(-8), label: c.label, created_at: c.createdAt })),
    banner: store.listBannerEvents(),
  }
}

export function dismissBanner(store, body) {
  if (!body?.event_id) fail('PASSKEY_INVALID', 'event_id is required', 400)
  store.dismissBannerEvent(body.event_id)
  return {}
}

/** `POST /api/passkeys/approve/options {ticket}`. `ask` is already resolved by the route (so a missing ticket is a plain 404). */
export function approveOptions(store, ask) {
  const rp = requireRp()
  if (!store.countCredentials()) fail('PASSKEY_REQUIRED', 'enroll a passkey to approve', 403)
  const challenge = randomBytes(32)
  const challengeId = store.saveChallenge({ kind: 'approve', challenge, askId: ask.id, revision: ask.revision, ttlMs: CHALLENGE_TTL_MS })
  return {
    challenge_id: challengeId,
    challenge: b64url(challenge),
    rpId: rp.rpId,
    allowCredentials: credentialsPublic(store),
    userVerification: 'required',
    timeout: 60000,
  }
}

/**
 * Verify (but do not yet consume) the assertion an approval answer carries.
 * Returns what `store.answer` needs to consume the challenge and record the
 * new sign count atomically with the answer itself. Throws `PASSKEY_REQUIRED`
 * with no credentials at all — there is no fallback to Tailscale headers —
 * and `PASSKEY_INVALID` for anything forged, replayed, or mis-bound.
 */
export function verifyApprovalAssertion(store, ask, revision, assertion) {
  const rp = requireRp()
  if (!store.countCredentials()) fail('PASSKEY_REQUIRED', 'enroll a passkey to approve', 403)
  if (!assertion) fail('PASSKEY_REQUIRED', 'a passkey assertion is required to approve', 403)
  const { challenge, credential, newSignCount } = verifyWithChallenge(store, assertion, 'approve', rp)
  if (challenge.ask_id !== ask.id || challenge.revision !== revision)
    fail('PASSKEY_INVALID', 'the passkey assertion is bound to a different ask or revision', 403)
  return { challengeId: challenge.id, credentialId: credential.id, newSignCount }
}

/**
 * `DELETE /api/passkeys/:id`. Needs an assertion from a different stored
 * credential, unless the one being removed is the last one left.
 */
export function removeCredential(store, id, body) {
  const rp = requireRp()
  const target = store.getCredential(id)
  if (!target) fail('PASSKEY_INVALID', 'unknown credential', 403)
  const { challenge, credential, newSignCount } = verifyWithChallenge(store, body?.assertion, 'enroll_auth', rp)
  return store.transaction(() => {
    if (store.countCredentials() > 1 && credential.id === id)
      fail('PASSKEY_INVALID', 'use a different passkey to remove this one', 403)
    if (!store.consumeChallenge(challenge.id, { kind: 'enroll_auth' }, { inTransaction: true }))
      fail('PASSKEY_INVALID', 'the passkey assertion is invalid, expired, or already used', 403)
    store.updateCredentialSignCount(credential.id, newSignCount)
    store.removeCredential(id)
    return {}
  })
}

/**
 * `<stateDir>/passkey-enrollments.log`, tab-separated: ISO time, the first 8
 * characters of the credential id, the AAGUID in hex, and the user agent
 * (clipped, control characters stripped). Mode 0600 like every other file in
 * state — this is an audit trail of a security-sensitive event, not a
 * convenience log.
 */
function appendEnrollmentLog(stateDir, { credentialId, aaguid, userAgent }) {
  if (!stateDir) return
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, 'passkey-enrollments.log')
  const line = [new Date().toISOString(), credentialId.slice(0, 8), aaguid, clip(userAgent, 200)].join('\t') + '\n'
  appendFileSync(file, line, { mode: 0o600 })
  chmodSync(file, 0o600)
}

export { PASSKEY_CREDENTIAL_CAP }
