import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { b64url, decodeCbor, verifyRegistration, verifyAssertion } from '../src/webauthn.js';
import { createAuthenticator } from './helpers/authenticator.js';

const rpId = 'studio.tailf266ac.ts.net';
const origin = `https://${rpId}`;
const challenge = b64url(randomBytes(32));

function fixture(alg = -7) {
  const device = createAuthenticator({ rpId, origin, alg });
  const registered = verifyRegistration({ credential: device.register(challenge), expectedChallenge: challenge, expectedOrigin: origin, rpId });
  const credential = { id: registered.credentialId, publicKeyJwk: registered.publicKeyJwk,
    alg: registered.alg, signCount: registered.signCount };
  return { device, credential };
}
const registration = (device, opts) => verifyRegistration({ credential: device.register(challenge, opts), expectedChallenge: challenge, expectedOrigin: origin, rpId });
const assertion = (device, credential, opts) => verifyAssertion({ assertion: device.assert(challenge, opts), expectedChallenge: challenge, expectedOrigin: origin, rpId, credential });

for (const alg of [-7, -257]) {
  test(`real registration and signed assertion (${alg})`, () => {
    const { device, credential } = fixture(alg);
    assert.equal(credential.alg, alg);
    assert.equal(assertion(device, credential).newSignCount, 1);
    // Authenticators without a counter may legitimately stay at zero.
    assert.equal(assertion(device, { ...credential, signCount: 0 }, { signCount: 0 }).newSignCount, 0);
  });
}

// Each row independently creates a valid credential. The comment names the only
// guard the mutation should reach; in particular altered authData is re-signed.
const negative = [
  // clientData type guard, registration and assertion.
  ['registration type', ({ device }) => registration(device, { type: 'webauthn.get' }), 'type'],
  ['assertion type', ({ device, credential }) => assertion(device, credential, { type: 'webauthn.create' }), 'type'],
  // clientData challenge guard (valid signed clientData, but not the expected challenge).
  ['challenge', ({ device, credential }) => verifyAssertion({ assertion: device.assert(b64url(randomBytes(32))), expectedChallenge: challenge, expectedOrigin: origin, rpId, credential }), 'challenge'],
  // clientData exact origin guard; helper signs the changed clientData.
  ['origin', ({ device, credential }) => assertion(device, credential, { origin: 'https://other.example' }), 'origin'],
  // clientData crossOrigin guard; helper signs the changed clientData.
  ['crossOrigin', ({ device, credential }) => assertion(device, credential, { crossOrigin: true }), 'crossOrigin'],
  // authenticatorData rpIdHash guard; helper signs the changed authData.
  ['rpIdHash', ({ device, credential }) => assertion(device, credential, { rpId: 'other.example' }), 'rpIdHash'],
  // authenticatorData UP guard; helper signs the changed flags.
  ['UP', ({ device, credential }) => assertion(device, credential, { flags: 0x04 }), 'UP'],
  // authenticatorData UV guard; helper signs the changed flags.
  ['UV', ({ device, credential }) => assertion(device, credential, { flags: 0x01 }), 'UV'],
  // attested credential data AT guard (UP and UV remain set).
  ['AT', ({ device }) => registration(device, { flags: 0x05 }), 'AT'],
  // COSE kty guard; the rest of the attestation is valid.
  ['COSE kty', ({ device }) => registration(device, { kty: 9 }), 'kty'],
  // COSE crv guard; valid P-256 key coordinates, wrong declared curve.
  ['COSE crv', ({ device }) => registration(device, { crv: 2 }), 'crv'],
  // COSE alg guard; valid P-256 key, unsupported declared algorithm.
  ['COSE alg', ({ device }) => registration(device, { alg: -8 }), 'alg'],
  // signature guard: all other assertion fields are valid.
  ['signature', ({ device, credential }) => assertion(device, credential, { corruptSignature: true }), 'signature'],
  // counter guard: valid signature over an authenticator counter equal to stored count.
  ['signCount', ({ device, credential }) => assertion(device, { ...credential, signCount: 1 }, { signCount: 1 }), 'signCount'],
  // credential id guard: the clientData, authData and signature stay valid.
  ['credential id', ({ device, credential }) => verifyAssertion({ assertion: { ...device.assert(challenge), id: 'other' }, expectedChallenge: challenge, expectedOrigin: origin, rpId, credential }), 'credential id'],
  // decodeCbor trailing-byte guard on the outer attestationObject.
  ['trailing attestation', ({ device }) => {
    const value = device.register(challenge);
    value.response.attestationObject = b64url(Buffer.concat([Buffer.from(value.response.attestationObject, 'base64url'), Buffer.from([0]) ]));
    return verifyRegistration({ credential: value, expectedChallenge: challenge, expectedOrigin: origin, rpId });
  }, 'Trailing CBOR'],
  // decodeCbor bounded length guard: a declared byte string longer than its payload.
  ['malformed CBOR length', ({ device }) => {
    const value = device.register(challenge);
    value.response.attestationObject = b64url(Buffer.from([0x59, 0xff, 0xff]));
    return verifyRegistration({ credential: value, expectedChallenge: challenge, expectedOrigin: origin, rpId });
  }, 'CBOR length'],
];

test('verifier rejects invalid browser credentials at its boundary', async (t) => {
  for (const [name, invoke, message] of negative) {
    await t.test(name, () => {
      const context = fixture();
      assert.throws(() => invoke(context), (err) => {
        assert.equal(err.code, 'PASSKEY_INVALID');
        assert.match(err.message, new RegExp(message, 'i'));
        return true;
      });
    });
  }
});

test('CBOR supported primitives and rejection of unsupported/trailing values', () => {
  assert.deepEqual(decodeCbor(Buffer.from([0x83, 0x20, 0xf4, 0xf6])), [-1, false, null]);
  assert.equal(decodeCbor(Buffer.from([0xf5])), true);
  assert.throws(() => decodeCbor(Buffer.from([0xf7])), /Unsupported CBOR/);
  assert.throws(() => decodeCbor(Buffer.from([0x00, 0x00])), /Trailing CBOR/);
});
