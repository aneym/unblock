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
  embed?: { src: string; quote: string; prefix: string; suffix: string }
  general?: true
  /** Seconds into a recording or demo, one decimal, from 0 to 86400. */
  t?: number
  /** End of a span on a recording, one decimal, after `t`. */
  t_end?: number
  /** Demo step index, an integer from 0 to 999. Kept only together with `t`. */
  step?: number
  /**
   * Highlighted region of a demo frame, as fractions of the stage.
   * `x` and `y` are in [0, 1]; `w` and `h` are clamped to the remainder and rounded to 3 decimals.
   * Kept only together with `t`, and only when `w` and `h` are above 0 after clamping.
   */
  region?: { x: number; y: number; w: number; h: number }
}

/** Box on a demo frame. Null when `input` is not a plain object of four finite numbers, or when `w` or `h` is 0 after clamping. */
export function cleanRegion(input: unknown): { x: number; y: number; w: number; h: number } | null

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

/** Round-2 labels: 'the plan', 'your ask', 'Q3', 'the decisions', 'the comment'; any other id → the id itself. v2 pane lines use `§<heading>` (headingOf) instead. */
export function sectionLabel(section: AnchorSection): string

/** The quote cut to `max` chars (default 80) at a word boundary with '…', double quotes turned into single. */
export function quoteSnippet(quote: string, max?: number): string

/**
 * Plain text of the plan markdown, as read aloud or quoted: markers
 * (#, **, *, _, backticks, list bullets, table pipes and rules, code fences)
 * dropped, [text](url) → text, bare URLs → 'a link', one paragraph per line.
 */
export function plainText(markdown: string): string

export function hasEmbedFence(section: { body_md: string }, src: string): boolean

/** Exact embed quote with at least one retained context edge when supplied. */
export function locateEmbed(text: string, anchor: { quote: string; prefix?: string; suffix?: string }): { start: number; end: number; exact: boolean } | null
