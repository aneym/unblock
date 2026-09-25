import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export class WebAuthnError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebAuthnError';
    this.code = 'PASSKEY_INVALID';
  }
}

const invalid = (message) => { throw new WebAuthnError(message); };
const hash = (data) => createHash('sha256').update(data).digest();
export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export function fromB64url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) invalid('Invalid base64url encoding');
  const value = Buffer.from(str, 'base64url');
  if (b64url(value) !== str) invalid('Invalid base64url encoding');
  return value;
}

// CBOR maps remain Maps so numeric COSE labels are never confused with text keys.
function readCbor(buf, start = 0) {
  if (start >= buf.length) invalid('Malformed CBOR length');
  const head = buf[start];
  const major = head >> 5;
  const additional = head & 31;
  let offset = start + 1;
  const take = (n) => {
    if (n > buf.length - offset) invalid('Malformed CBOR length');
    const pos = offset;
    offset += n;
    return pos;
  };
  let length;
  if (additional < 24) length = additional;
  else if (additional === 24) length = buf.readUInt8(take(1));
  else if (additional === 25) length = buf.readUInt16BE(take(2));
  else if (additional === 26) length = buf.readUInt32BE(take(4));
  else if (additional === 27) {
    length = Number(buf.readBigUInt64BE(take(8)));
    if (!Number.isSafeInteger(length)) invalid('Malformed CBOR length');
  } else invalid('Unsupported CBOR type or length');

  if (major === 0 || major === 1) return { value: major === 0 ? length : -1 - length, offset };
  if (major === 2 || major === 3) {
    const pos = take(length);
    return { value: major === 2 ? buf.subarray(pos, offset) : buf.toString('utf8', pos, offset), offset };
  }
  if (major === 4 || major === 5) {
    const count = major === 5 ? length * 2 : length;
    // Each member requires at least one byte; reject impossible counts before allocating.
    if (count > buf.length - offset) invalid('Malformed CBOR length');
    const items = [];
    for (let i = 0; i < count; i++) {
      const result = readCbor(buf, offset);
      items.push(result.value);
      offset = result.offset;
    }
    if (major === 4) return { value: items, offset };
    const map = new Map();
    for (let i = 0; i < items.length; i += 2) {
      if (map.has(items[i])) invalid('Duplicate CBOR map key');
      map.set(items[i], items[i + 1]);
    }
    return { value: map, offset };
  }
  if (major === 7 && additional === 20) return { value: false, offset };
  if (major === 7 && additional === 21) return { value: true, offset };
  if (major === 7 && additional === 22) return { value: null, offset };
  invalid('Unsupported CBOR type');
}

export function decodeCbor(data) {
  if (!Buffer.isBuffer(data)) invalid('CBOR requires a Buffer');
  const result = readCbor(data);
  if (result.offset !== data.length) invalid('Trailing CBOR bytes');
  return result.value;
}

function clientData(encoded, type, challenge, origin) {
  const bytes = fromB64url(encoded);
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { invalid('Invalid clientDataJSON'); }
  if (data?.type !== type) invalid('Wrong clientData type');
  if (data.challenge !== challenge) invalid('Wrong challenge');
  if (data.origin !== origin) invalid('Wrong origin');
  if (data.crossOrigin === true) invalid('crossOrigin is true');
  return bytes;
}

function authData(bytes, rpId) {
  if (bytes.length < 37) invalid('Malformed authenticatorData length');
  const expected = hash(Buffer.from(rpId));
  if (!timingSafeEqual(bytes.subarray(0, 32), expected)) invalid('Wrong rpIdHash');
  const flags = bytes[32];
  if (!(flags & 0x01)) invalid('UP flag missing');
  if (!(flags & 0x04)) invalid('UV flag missing');
  return { flags, signCount: bytes.readUInt32BE(33) };
}

function coseJwk(key) {
  if (!(key instanceof Map)) invalid('Unsupported COSE kty');
  const kty = key.get(1);
  const alg = key.get(3);
  if (kty === 2 && alg === -7) {
    if (key.get(-1) !== 1) invalid('Unsupported COSE crv');
    const x = key.get(-2);
    const y = key.get(-3);
    if (!Buffer.isBuffer(x) || x.length !== 32 || !Buffer.isBuffer(y) || y.length !== 32) invalid('Invalid COSE EC key');
    return { alg, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) } };
  }
  if (kty === 3 && alg === -257) {
    const n = key.get(-1);
    const e = key.get(-2);
    if (!Buffer.isBuffer(n) || !n.length || !Buffer.isBuffer(e) || !e.length) invalid('Invalid COSE RSA key');
    return { alg, publicKeyJwk: { kty: 'RSA', n: b64url(n), e: b64url(e) } };
  }
  if (kty !== 2 && kty !== 3) invalid('Unsupported COSE kty');
  invalid('Unsupported COSE alg');
}

function checked(fn) {
  try { return fn(); }
  catch (err) {
    if (err instanceof WebAuthnError) throw err;
    throw new WebAuthnError('Malformed WebAuthn credential');
  }
}

export function verifyRegistration({ credential, expectedChallenge, expectedOrigin, rpId }) {
  return checked(() => {
    if (credential?.type !== 'public-key') invalid('Wrong credential type');
    clientData(credential.response?.clientDataJSON, 'webauthn.create', expectedChallenge, expectedOrigin);
    const attestation = decodeCbor(fromB64url(credential.response?.attestationObject));
    if (!(attestation instanceof Map) || attestation.get('fmt') !== 'none' || !Buffer.isBuffer(attestation.get('authData')))
      invalid('Invalid attestationObject format');
    const bytes = attestation.get('authData');
    const { flags, signCount } = authData(bytes, rpId);
    if (!(flags & 0x40)) invalid('AT flag missing');
    if (bytes.length < 55) invalid('Malformed attested credential data');
    const idLength = bytes.readUInt16BE(53);
    const keyStart = 55 + idLength;
    if (!idLength || keyStart >= bytes.length) invalid('Malformed attested credential data');
    const credentialId = b64url(bytes.subarray(55, keyStart));
    if (credential.id !== credentialId || credential.rawId !== credentialId) invalid('Registration credential id mismatch');
    const parsed = readCbor(bytes, keyStart);
    if (flags & 0x80) {
      const extension = readCbor(bytes, parsed.offset);
      if (extension.offset !== bytes.length) invalid('Trailing authenticatorData bytes');
    } else if (parsed.offset !== bytes.length) invalid('Trailing authenticatorData bytes');
    const { alg, publicKeyJwk } = coseJwk(parsed.value);
    createPublicKey({ key: publicKeyJwk, format: 'jwk' });
    return { credentialId, publicKeyJwk, alg, signCount };
  });
}

export function verifyAssertion({ assertion, expectedChallenge, expectedOrigin, rpId, credential }) {
  return checked(() => {
    if (assertion?.id !== credential?.id || assertion?.rawId !== credential?.id) invalid('Assertion credential id mismatch');
    const client = clientData(assertion.response?.clientDataJSON, 'webauthn.get', expectedChallenge, expectedOrigin);
    const bytes = fromB64url(assertion.response?.authenticatorData);
    const { flags, signCount } = authData(bytes, rpId);
    if (flags & 0x40 || flags & 0x80 || bytes.length !== 37) invalid('Malformed assertion authenticatorData');
    if (!Number.isInteger(credential.signCount) || credential.signCount < 0 ||
        (signCount <= credential.signCount && !(signCount === 0 && credential.signCount === 0)))
      invalid('signCount did not increase');
    if (!((credential.alg === -7 && credential.publicKeyJwk?.kty === 'EC' && credential.publicKeyJwk.crv === 'P-256') ||
          (credential.alg === -257 && credential.publicKeyJwk?.kty === 'RSA'))) invalid('Unsupported credential alg');
    const key = createPublicKey({ key: credential.publicKeyJwk, format: 'jwk' });
    const signature = fromB64url(assertion.response?.signature);
    if (!verify('sha256', Buffer.concat([bytes, hash(client)]), key, signature)) invalid('Bad signature');
    return { newSignCount: signCount };
  });
}
