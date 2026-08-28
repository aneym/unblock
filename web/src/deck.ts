/**
 * Types for the queue, plus a typed face on the shared selection model.
 *
 * The rules themselves live in ../../src/queue-model.js — one module for the
 * panel, the TUI, and the tests, because two surfaces disagreeing about what
 * "next" means is exactly how the filter bugs got in.
 */
import {
  buildDeck as buildDeckJs,
  groupOf as groupOfJs,
  isMissing as isMissingJs,
  selectDeck as selectDeckJs,
  sortAsks as sortAsksJs,
  unansweredFields as unansweredFieldsJs,
} from '../../src/queue-model.js'

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

export interface Selection {
  items: DeckItem[]
  projects: [string, number][]
  activeProject: string | null
  current?: DeckItem
  remaining: number
}

export const groupOf: (ask: Ask) => string = groupOfJs
export const isMissing: (value: FieldValue | undefined) => boolean = isMissingJs
export const unansweredFields: (ask: Ask) => Field[] = (ask) => unansweredFieldsJs<Field, Ask>(ask)
export const sortAsks: (asks: Ask[]) => Ask[] = sortAsksJs
export const buildDeck: (asks: Ask[]) => DeckItem[] = buildDeckJs
export const selectDeck: (input: {
  asks?: Ask[]
  project?: string | null
  pinnedTicket?: string | null
  deferredKeys?: string[]
  doneTickets?: ReadonlySet<string>
}) => Selection = selectDeckJs

export function ago(createdAt: number) {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}
