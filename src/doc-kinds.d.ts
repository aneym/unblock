/**
 * One registry of doc kinds. Pure, no I/O. Shared by the daemon, the CLI and the page.
 */
export type KindId = 'scope' | 'explainer' | 'review' | 'draft' | 'report'

export interface DocKind {
  /** Index group heading. */
  label: string
  /** The margin action and reply verb ("Ask" / "Comment"). */
  margin: 'Ask' | 'Comment'
  /** The doc can be approved. */
  approve: boolean
  /**
   * Comments resolve/park (check button, Resolved chip, show-resolved filter,
   * nav over open comments, "N open" counter). False means every comment stays
   * listed and the nav runs over all of them.
   */
  resolve: boolean
  /** Thread cards render as question and answer ("You asked", "Answer" messages). */
  qa: boolean
  /** Default for the per-doc `answerer: on|off` seam. */
  answerer: boolean
}

export const DOC_KINDS: { readonly [K in KindId]: DocKind }
export const KIND_IDS: readonly KindId[]
export function kindOf(scope: object | null | undefined): KindId
export function kindSpec(scope: object | null | undefined): DocKind
