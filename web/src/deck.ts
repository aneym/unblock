/**
 * The deck model. The queue arrives as a flat list of asks; the page shows it
 * one card at a time. A card is either one ask (anything with weight: gating,
 * secrets, free text, steps) or a small group of short same-project asks —
 * choice/confirm questions a human can clear in a few taps.
 */

export type Scalar = string | boolean
/** null is an explicit "no answer" — a real response, distinct from untouched. */
export type FieldValue = Scalar | string[] | null
export type Values = Record<string, FieldValue>
/** field name → send-back note ('' = no note yet). */
export type Bounced = Record<string, string>

export interface Choice { value: string; label: string }

export interface Field {
  name: string
  type: 'text' | 'secret' | 'choice' | 'confirm' | 'paste'
  label: string
  required?: boolean
  multiline?: boolean
  multi?: boolean
  choices?: Choice[]
  help?: string
  url?: string
  command?: string
  placeholder?: string
  recommend?: { value: FieldValue; why: string }
  must_decide?: boolean
}

export interface Ask {
  ticket: string
  kind: 'file' | 'park'
  purpose: 'blocker' | 'decision'
  gating: boolean
  status: string
  title: string
  why: string
  project?: string
  fields: Field[]
  steps?: string[]
  links?: { label: string; url: string }[]
  origin: {
    agent?: string
    workspace_name?: string
    pane_id?: string
    tab_id?: string
    workspace_id?: string
    repo?: string
    cwd?: string
    detected?: boolean
  }
  answers?: Record<string, unknown>
  draft?: Values
  draft_reply?: string
  draft_updated_at?: number
  field_context?: Record<string, string>
  missing?: string[]
  created_at: number
}

export interface QueueData { asks: Ask[]; hidden: number; profile: string }

export interface DeckItem {
  key: string
  project: string
  grouped: boolean
  asks: Ask[]
}

/** The project an ask belongs to: what the agent declared, else its origin. */
export function groupOf(ask: Ask): string {
  return (
    ask.project ||
    ask.origin.workspace_name ||
    ask.origin.repo ||
    (ask.origin.cwd ? ask.origin.cwd.split('/').filter(Boolean).pop() : undefined) ||
    ask.origin.agent ||
    'elsewhere'
  )
}

export function ago(createdAt: number) {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

export function isMissing(value: FieldValue | undefined) {
  if (value === undefined) return true
  if (value === null) return false // explicitly skipped — answered
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return value === false
}

export function unansweredFields(ask: Ask): Field[] {
  return ask.fields.filter((field) => !(field.name in (ask.answers || {})))
}

/** Gating first, detected last, oldest first within each band. */
export function sortAsks(asks: Ask[]): Ask[] {
  return [...asks].sort(
    (a, b) =>
      Number(b.gating) - Number(a.gating) ||
      Number(a.origin.detected === true) - Number(b.origin.detected === true) ||
      a.created_at - b.created_at,
  )
}

/**
 * Short enough to share a card: nothing but taps left in it. A gating ask
 * always gets its own card (an agent is stopped on it), and anything with
 * typing, secrets, or steps deserves the full stage.
 */
export function isShort(ask: Ask): boolean {
  if (ask.gating || ask.origin.detected === true) return false
  if (ask.steps?.length) return false
  const open = unansweredFields(ask)
  if (open.length === 0 || open.length > 2) return false
  return open.every((field) => field.type === 'choice' || field.type === 'confirm')
}

/**
 * Fold a sorted ask list into deck items. Short asks from the same project
 * pool into a shared card — up to 3 asks and 4 open fields — and the card
 * keeps the position of its first ask, so grouping never reorders the deck's
 * priorities.
 */
export function buildDeck(asks: Ask[]): DeckItem[] {
  const items: DeckItem[] = []
  const openGroup = new Map<string, DeckItem>()
  const openCount = (item: DeckItem) =>
    item.asks.reduce((total, ask) => total + unansweredFields(ask).length, 0)

  for (const ask of asks) {
    if (!isShort(ask)) {
      items.push({ key: ask.ticket, project: groupOf(ask), grouped: false, asks: [ask] })
      continue
    }
    const project = groupOf(ask)
    const current = openGroup.get(project)
    if (current && current.asks.length < 3 && openCount(current) + unansweredFields(ask).length <= 4) {
      current.asks.push(ask)
      continue
    }
    const item: DeckItem = { key: `g_${ask.ticket}`, project, grouped: true, asks: [ask] }
    openGroup.set(project, item)
    items.push(item)
  }
  return items
}
