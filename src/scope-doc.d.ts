/**
 * Scoping doc, contract v2: one document plus threads anchored to it
 * (Google Docs model). Fixed interface, shared by the daemon (src/scope.js),
 * the CLI (bin/unblock.js), the voice rules (src/scope-voice.js) and the page
 * (web/src/scope/*). Pure ESM, no Node or DOM APIs.
 *
 * scope.json v2 is written ONLY by the daemon (lanes use the CLI verbs).
 * v1 files (plan_md, questions, decisions, thread) are still read and
 * converted with migrateV1.
 */
import type { Anchor } from './scope-anchor.js'

/** `title` is the doc title (body = lede); a general thought is a comment anchored on it. */
export interface DocSection {
  /** Stable id, SECTION_ID. Unique within the doc. */
  id: string
  /** Shown as the section heading ('' for the title section's body-only use is not allowed: title heading = scope title). */
  heading: string
  /**
   * Markdown: paragraphs, lists, tables, ```svg and ```mermaid fences, `> [!NOTE]` callouts, `Figure: …` captions.
   * A ```svg fence may be followed at once by a ```svg phone fence: the page shows that one under 600px wide.
   */
  body_md: string
}

export interface ThreadMessage {
  from: 'agent' | 'alex'
  text: string
  /** ISO time. */
  at: string
  via?: 'voice'
  /**
   * 'reject': Alex's No to the current recommendation (text = his reason, '' when he gave none).
   * 'option': the lane's new option after a No; it carries the new recommendation.
   */
  kind?: 'reject' | 'option'
  /** On an 'option' message: the recommendation it put on the thread. */
  recommendation?: string
}

export interface Resolution {
  /** What was decided, in plain words. */
  decision: string
  /** His own words when he resolved it ("Take the recommendation", or what he said); null when the lane resolved it. */
  alex_words: string | null
  by: 'alex' | 'agent'
  /**
   * How Alex settled it: 'take' (took the recommendation), 'own' (his own answer, "Something else"),
   * 'resolve' (the ⋯ menu's Resolve). Absent when the lane resolved it.
   */
  how?: 'take' | 'own' | 'resolve'
  at: string
  /** Set when the lane confirms a resolution Alex made (after rewriting the doc). */
  confirmed_at: string | null
  /** Doc revision that states the decision, set on the lane's confirm or resolve. */
  revision: number | null
}

export interface Thread {
  /** 'T1', 'T2', … never reused. */
  id: string
  anchor: Anchor
  author: 'agent' | 'alex'
  kind: 'question' | 'comment'
  /** 'parked': Alex said "Not now"; unanswered, out of the open count, shown with resolved ones. */
  status: 'open' | 'resolved' | 'parked'
  /** Questions only. The current recommendation (a new option after a No replaces it). */
  recommendation?: string
  why?: string
  /** Set by Alex's No; cleared when the lane replies with a new recommendation. The thread stays open. */
  rejected_at?: string | null
  parked_at?: string | null
  /** First message is the question or comment itself. */
  messages: ThreadMessage[]
  resolution?: Resolution
  created_at: string
  /** v1 id this came from ('Q3', 'D1', 'thread'), for the pane line and the migration copy. */
  legacy_id?: string
}

export interface ScopeV2 {
  version: 2
  slug: string
  title: string
  pane: string
  /** Increments on every doc rewrite (not on thread changes). Starts at 1. */
  revision: number
  updated_at: string
  doc: { sections: DocSection[] }
  threads: Thread[]
}

/** /^[a-z][a-z0-9-]{0,39}$/ */
export const SECTION_ID: RegExp
/** /^T\d{1,4}$/ */
export const THREAD_ID: RegExp

/**
 * Convert a v1 scope.json to v2 (pure, deterministic for a given `now`).
 * - sections: `title` (heading = title, body = lede ?? ''), `ask` (heading 'What you asked for',
 *   body = each ask quote as `> "quote"` + `> — source, date` lines), then plan_md split into sections at
 *   `#`/`##`/`###` headings or a paragraph that is only `**Heading**`; text before the first heading is
 *   section `plan` (heading 'The plan'). Ids: slugified heading, deduped with -2, -3.
 *   `unverified` (if present) becomes a last section 'unverified' ('Not verified yet').
 * - questions → question threads (id T<n> in order, legacy_id = Q id): anchored to the first section whose
 *   plain text contains a word-bounded mention of the Q id or of the question's `section` field if any,
 *   else to the title (quote = title). Open (or missing) → status open; answered/decided → resolved with
 *   resolution {decision: answer text, alex_words: answer text, by: 'alex'}; dropped → resolved with
 *   {decision: 'Dropped' + (answer ? ': ' + answer : ''), alex_words: answer ?? null, by: 'alex'}.
 *   Migrated resolutions carry at = answered_at ?? updated_at, confirmed_at = at, revision = 1.
 * - decisions → resolved question threads anchored to the title (legacy_id = decision id).
 * - thread (v1 chat) → ONE comment thread on the title (legacy_id 'thread') holding every message in order,
 *   status open when its last message is from alex, else resolved (by agent, decision 'Answered in thread').
 * - revision 1, version 2; slug/title/pane/updated_at carried over.
 */
export function migrateV1(v1: unknown, now?: string): ScopeV2

/** Validate a v2 object (from disk or a lane's `doc` payload). Returns a list of problems ([] = valid). */
export function validateScope(scope: unknown): string[]

/** Plain text of a section as anchors see it: heading, newline, plainText(body_md) with figures reduced to their caption. */
export function sectionPlain(section: DocSection): string

/** Build an anchor for `quote` inside a section (first occurrence, whitespace-insensitive). Null when not found. */
export function anchorInSection(section: DocSection, quote: string): Anchor | null

/** Open threads first, then resolved and parked; each group in doc order (section index, then position of the quote); detached last. */
export function orderThreads(scope: ScopeV2): Thread[]

/** Next unused thread id ('T1' for none). */
export function nextThreadId(scope: ScopeV2): string

/** The heading of `sectionId`, or the id itself when missing. */
export function headingOf(scope: ScopeV2, sectionId: string): string

/**
 * Parse a lane's markdown doc (`unblock scope doc <slug> --from file.md`). The first `# ` line is the
 * title section (id 'title', heading = its text); text up to the first `## ` is the title body (the lede).
 * Each `## Heading {#id}` starts a section: id from `{#id}` if given, else the slugified heading, deduped
 * with -2, -3. `###` and deeper stay inside the body. Throws Error('the doc needs a "# Title" first line')
 * when there is no `# ` line before the first `## `.
 */
export function docFromMarkdown(md: string): { sections: DocSection[] }

/** Export the current document as markdown, retaining stable section ids. */
export function docToMarkdown(doc: { sections: DocSection[] }): string
