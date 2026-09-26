export interface Viewer {
  login: string
  name: string
}

declare global {
  interface Window {
    __UNBLOCK_TOKEN__?: string
    __UNBLOCK_BOOT__?: { token: string | null; viewer: Viewer | null }
  }
}

const BOOT = window.__UNBLOCK_BOOT__ ?? {
  token: window.__UNBLOCK_TOKEN__ || null,
  viewer: null,
}

/**
 * The page is reachable two ways and speaks the same API from both.
 *
 *   /u/<token>  a shared link; the token IS the capability, so it prefixes.
 *   /           the canonical page; a trusted proxy already identified the
 *               viewer, so there is no token and no prefix.
 */
export const BASE = BOOT.token ? `/u/${BOOT.token}` : ''
export const VIEWER = BOOT.viewer

export class FinishedError extends Error {}
export class ApiError extends Error {
  constructor(message: string, public readonly code?: string, public readonly added_at?: number) { super(message) }
}

export class DraftStaleError extends Error {
  constructor(public draftRev: number) { super('draft is stale') }
}

/** The request never got an HTTP answer (Safari words this "Load failed"). */
export class NetworkError extends Error {}

const RETRY_DELAYS_MS = [400, 1500]

interface ClientEvent {
  at: string; path: string; outcome: 'recovered' | 'failed'; attempts: number
  message: string; online: boolean; visibility: string
}
const pendingReports: ClientEvent[] = []

function note(path: string, outcome: ClientEvent['outcome'], attempts: number, error: unknown) {
  pendingReports.push({
    at: new Date().toISOString(), path, outcome, attempts,
    message: error instanceof Error ? error.message : String(error),
    online: navigator.onLine, visibility: document.visibilityState,
  })
  if (pendingReports.length > 20) pendingReports.shift()
}

/** Sends what went wrong once the daemon is reachable again; best effort. */
function flushReports() {
  if (!pendingReports.length) return
  const events = pendingReports.splice(0)
  fetch(`${BASE}/api/client-log`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }), keepalive: true,
  }).catch(() => undefined)
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/**
 * A phone on the tailnet often wakes with a dead keep-alive connection, and
 * the first request on it fails with no HTTP status. Browsers retry a GET on
 * their own but never a POST, so this does: every call here is safe to
 * repeat (an answer overwrites until the agent collects it; after that the
 * daemon says 410 and the page moves on).
 */
async function send(path: string, retries: number, init: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(BASE + path, init)
      if (attempt > 1) note(path, 'recovered', attempt, lastError)
      return response
    } catch (error) {
      lastError = error
      if (attempt > retries) {
        note(path, 'failed', attempt, error)
        throw new NetworkError(error instanceof Error ? error.message : 'network error')
      }
      await wait(RETRY_DELAYS_MS[attempt - 1])
    }
  }
}

/**
 * `retry: false` for drafts: each one carries the whole latest state, so a
 * late retry of an older draft would overwrite a newer one. The local mirror
 * and the next keystroke cover a lost draft.
 */
export async function api<T>(path: string, body?: unknown, { retry = true } = {}): Promise<T> {
  const response = await send(path, retry ? RETRY_DELAYS_MS.length : 0, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  flushReports()
  if (response.status === 410) throw new FinishedError('finished')
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; code?: string; added_at?: number; draft_rev?: number }
    if (response.status === 409 && payload.code === 'DRAFT_STALE' && typeof payload.draft_rev === 'number') {
      throw new DraftStaleError(payload.draft_rev)
    }
    throw new ApiError(payload.error || `HTTP ${response.status}`, payload.code, payload.added_at)
  }
  return response.json() as Promise<T>
}
