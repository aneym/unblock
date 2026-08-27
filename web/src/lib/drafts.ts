import type { Bounced, Values } from '../deck'

/**
 * The local mirror: every keystroke lands in localStorage synchronously,
 * BEFORE the debounced server draft. This is what makes a reload lossless
 * even when the tab dies, the daemon is briefly down, or the draft POST never
 * got to fire. Secrets never enter it; they stay in component state only.
 */
export interface LocalDraft {
  values: Values
  notes: Record<string, string>
  reply: string
  bounced: Bounced
  t: number
}

const localKey = (ticket: string) => `ub_local_${ticket}`

export function readLocal(ticket: string): LocalDraft | null {
  try {
    return JSON.parse(localStorage.getItem(localKey(ticket)) || 'null')
  } catch {
    return null
  }
}

export function writeLocal(ticket: string, draft: Omit<LocalDraft, 't'>) {
  try {
    localStorage.setItem(localKey(ticket), JSON.stringify({ ...draft, t: Date.now() }))
  } catch {
    /* private mode etc. */
  }
}

export function clearLocal(ticket: string) {
  try {
    localStorage.removeItem(localKey(ticket))
  } catch {
    /* ignore */
  }
}
