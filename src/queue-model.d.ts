/**
 * Declarations for the shared queue model. They stay generic in the ask type:
 * the browser panel re-exports them through web/src/deck.ts with its own
 * precise Ask and Field types, and the TUI passes its own shape.
 */

export interface DeckItemOf<A> {
  key: string
  project: string
  grouped: boolean
  asks: A[]
}

export interface SelectionOf<A> {
  items: DeckItemOf<A>[]
  projects: [string, number][]
  activeProject: string | null
  current?: DeckItemOf<A>
  remaining: number
}

export const MAX_GROUP_ASKS: number
export const MAX_GROUP_FIELDS: number

export function groupOf<A>(ask: A): string
export function isMissing(value: unknown): boolean
export function unansweredFields<F = unknown, A = unknown>(ask: A): F[]
export function sortAsks<A>(asks: A[]): A[]
export function isShort<A>(ask: A): boolean
export function buildDeck<A>(asks: A[]): DeckItemOf<A>[]
export function projectCounts<A>(asks: A[]): [string, number][]
export function selectDeck<A>(input: {
  asks?: A[]
  project?: string | null
  pinnedTicket?: string | null
  deferredKeys?: string[]
  doneTickets?: ReadonlySet<string>
}): SelectionOf<A>
