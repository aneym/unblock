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

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  if (response.status === 410) throw new FinishedError('finished')
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}
