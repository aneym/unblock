import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const url = (value) => Buffer.from(value).toString('base64url');
const sha = (value) => createHash('sha256').update(value).digest();

// Independent, definite-length CBOR writer for authenticator fixtures.
function header(major, size) {
  if (size < 24) return Buffer.from([(major << 5) | size]);
  if (size < 256) return Buffer.from([(major << 5) | 24, size]);
  if (size < 65536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(size, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(size, 1);
  return b;
}
function cbor(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return header(value >= 0 ? 0 : 1, value >= 0 ? value : -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([header(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([header(3, bytes.length), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([header(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) {
    const pairs = [...value].flatMap(([k, v]) => [cbor(k), cbor(v)]);
    return Buffer.concat([header(5, value.size), ...pairs]);
  }
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (value === null) return Buffer.from([0xf6]);
  throw new TypeError('Unsupported fixture CBOR value');
}

export function createAuthenticator({ rpId, origin, alg = -7 }) {
  const { publicKey, privateKey } = generateKeyPairSync(alg === -257 ? 'rsa' : 'ec',
    alg === -257 ? { modulusLength: 2048, publicExponent: 0x10001 } : { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = url(randomBytes(32));
  let counter = 0;
  const key = alg === -257
    ? new Map([[1, 3], [3, alg], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]])
    : new Map([[1, 2], [3, alg], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  function client(type, challenge, opts) {
    return Buffer.from(JSON.stringify({ type: opts.type ?? type, challenge, origin: opts.origin ?? origin,
      crossOrigin: opts.crossOrigin ?? false }));
  }
  function auth(flags, count, opts) {
    const bytes = Buffer.alloc(37);
    sha(Buffer.from(opts.rpId ?? rpId)).copy(bytes);
    bytes[32] = flags;
    bytes.writeUInt32BE(count, 33);
    return bytes;
  }
  return {
    id,
    register(challengeB64url, opts = {}) {
      const counterValue = opts.signCount ?? 0;
      counter = counterValue;
      const cose = new Map(key);
      if (opts.kty !== undefined) cose.set(1, opts.kty);
      if (opts.alg !== undefined) cose.set(3, opts.alg);
      if (opts.crv !== undefined) cose.set(-1, opts.crv);
      const idBytes = Buffer.from(id, 'base64url');
      const length = Buffer.alloc(2);
      length.writeUInt16BE(idBytes.length);
      const data = Buffer.concat([auth(opts.flags ?? 0x45, counterValue, opts), Buffer.alloc(16), length, idBytes, cbor(cose)]);
      const attestation = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]));
      return { id, rawId: id, type: 'public-key', response: {
        clientDataJSON: url(client('webauthn.create', challengeB64url, opts)),
        attestationObject: url(attestation),
      } };
    },
    assert(challengeB64url, opts = {}) {
      const count = opts.signCount ?? ++counter;
      counter = count;
      const bytes = auth(opts.flags ?? 0x05, count, opts);
      const clientBytes = client('webauthn.get', challengeB64url, opts);
      const signature = sign('sha256', Buffer.concat([bytes, sha(clientBytes)]), privateKey);
      if (opts.corruptSignature) signature[signature.length - 1] ^= 0x01;
      return { id, rawId: id, type: 'public-key', response: {
        clientDataJSON: url(clientBytes), authenticatorData: url(bytes), signature: url(signature), userHandle: null,
      } };
    },
  };
}
