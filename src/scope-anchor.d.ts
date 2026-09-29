/**
 * Anchors for comments on a scoping page. Fixed interface shared by the page
 * (web/src/scope/*), the daemon (src/scope.js) and the voice rules
 * (src/scope-voice.js). Pure, no DOM.
 */

/**
 * Where on the page a comment sits. v2 docs: a doc section id (SECTION_ID in
 * scope-doc.d.ts, e.g. 'title', 'plan', 'done-means'). `q:Q3` is kept for
 * round-2 notes stored before v2.
 */
export type AnchorSection = string

export interface Anchor {
  section: AnchorSection
  /** The quoted text, whitespace collapsed to single spaces, trimmed, 1..300 chars. */
  quote: string
  /** Up to 40 chars of text just before the quote (collapsed, trimmed), may be ''. */
  prefix: string
  /** Up to 40 chars of text just after the quote (collapsed, trimmed), may be ''. */
  suffix: string
  t?: number
  t_end?: number
}

/** Matches a valid AnchorSection: /^([a-z][a-z0-9-]{0,39}|q:Q\d{1,3})$/ */
export const ANCHOR_SECTION: RegExp

/**
 * Validate and tidy untrusted input (a request body). Collapses whitespace,
 * trims, keeps the LAST 40 chars of prefix and the FIRST 40 of suffix, cuts
 * quote to 300 chars. Returns null when section is invalid or quote is empty.
 */
export function normalizeAnchor(input: unknown): Anchor | null

/** Anchor for text.slice(start, end) inside a section whose text is `text`. Null when the slice is blank. */
export function makeAnchor(section: AnchorSection, text: string, start: number, end: number): Anchor | null

/**
 * Find the anchor again in `text` (the section's current text) after a rewrite.
 * Matching ignores ALL whitespace (so line breaks, re-wrapping and block
 * joins don't matter); exact case first, then case-insensitive (exact: false).
 * With several matches, the one whose surroundings best match prefix/suffix wins.
 * Returns offsets into the ORIGINAL `text` (start of first quote char, end after
 * the last), or null when the quote is gone.
 */
export function locateAnchor(text: string, anchor: Anchor): { start: number; end: number; exact: boolean } | null

/** Round-2 labels: 'the plan', 'your ask', 'Q3', 'the decisions', 'the thread'; any other id → the id itself. v2 pane lines use `§<heading>` (headingOf) instead. */
export function sectionLabel(section: AnchorSection): string

/** The quote cut to `max` chars (default 80) at a word boundary with '…', double quotes turned into single. */
export function quoteSnippet(quote: string, max?: number): string

/**
 * Plain text of the plan markdown, as read aloud or quoted: markers
 * (#, **, *, _, backticks, list bullets, table pipes and rules, code fences)
 * dropped, [text](url) → text, bare URLs → 'a link', one paragraph per line.
 */
export function plainText(markdown: string): string
