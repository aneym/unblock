import { api } from './api'

/** What `GET /api/passkeys` returns. */
export interface PasskeySummary {
  id_suffix: string
  label: string | null
  created_at: number
}
export interface BannerEvent {
  event_id: string
  label: string | null
  at: number
}
export interface PasskeyList {
  credentials: PasskeySummary[]
  banner: BannerEvent[]
}

/** What the page sends back as `values.assertion` on an approval answer. */
export interface Assertion {
  challenge_id: string
  id: string
  rawId: string
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle: string | null
  }
}

interface CredentialDescriptor {
  id: string
  type: 'public-key'
}

interface RegisterOptions {
  challenge_id: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: { alg: number; type: 'public-key' }[]
  authenticatorSelection: { residentKey: string; userVerification: string }
  attestation: string
  excludeCredentials: CredentialDescriptor[]
}

interface RequestOptions {
  challenge_id: string
  challenge: string
  rpId: string
  allowCredentials: CredentialDescriptor[]
  userVerification: string
  timeout: number
}

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** The one shape both a registration and an assertion response reduce to, base64url all the way down. */
function credentialToJson(credential: PublicKeyCredential): {
  id: string; rawId: string; type: string
  response: Record<string, string | null>
} {
  const response = credential.response
  if ('attestationObject' in response) {
    const attestation = response as AuthenticatorAttestationResponse
    return {
      id: credential.id, rawId: toBase64Url(credential.rawId), type: credential.type,
      response: {
        clientDataJSON: toBase64Url(attestation.clientDataJSON),
        attestationObject: toBase64Url(attestation.attestationObject),
      },
    }
  }
  const assertion = response as AuthenticatorAssertionResponse
  return {
    id: credential.id, rawId: toBase64Url(credential.rawId), type: credential.type,
    response: {
      clientDataJSON: toBase64Url(assertion.clientDataJSON),
      authenticatorData: toBase64Url(assertion.authenticatorData),
      signature: toBase64Url(assertion.signature),
      userHandle: assertion.userHandle ? toBase64Url(assertion.userHandle) : null,
    },
  }
}

/**
 * Enroll a new passkey. With no credentials yet this is open; otherwise the
 * daemon demands an existing passkey's assertion first, which is why this
 * always tries the plain options call and lets the daemon ask for more.
 */
export async function enroll(): Promise<void> {
  const options = await api<RegisterOptions>('/api/passkeys/register/options', {}, { retry: false })
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: fromBase64Url(options.challenge),
    rp: options.rp,
    user: { id: fromBase64Url(options.user.id), name: options.user.name, displayName: options.user.displayName },
    pubKeyCredParams: options.pubKeyCredParams,
    authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria,
    attestation: options.attestation as AttestationConveyancePreference,
    excludeCredentials: options.excludeCredentials.map((c) => ({ id: fromBase64Url(c.id), type: 'public-key' as const })),
  }
  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential
  const json = credentialToJson(credential)
  await api('/api/passkeys/register', { challenge_id: options.challenge_id, credential: json }, { retry: false })
}

/** Runs the Touch ID ceremony for one ask and returns the assertion to submit alongside the verdict. */
export async function approveAssertion(ticket: string): Promise<Assertion> {
  const options = await api<RequestOptions>('/api/passkeys/approve/options', { ticket }, { retry: false })
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: fromBase64Url(options.challenge),
    rpId: options.rpId,
    allowCredentials: options.allowCredentials.map((c) => ({ id: fromBase64Url(c.id), type: 'public-key' as const })),
    userVerification: options.userVerification as UserVerificationRequirement,
    timeout: options.timeout,
  }
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential
  const json = credentialToJson(credential)
  return { challenge_id: options.challenge_id, id: json.id, rawId: json.rawId, response: json.response as Assertion['response'] }
}

export function listPasskeys(): Promise<PasskeyList> {
  return api<PasskeyList>('/api/passkeys')
}

export async function dismissBanner(eventId: string): Promise<void> {
  await api('/api/passkeys/banner/dismiss', { event_id: eventId }, { retry: false })
}
