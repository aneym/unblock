/**
 * rails-demo/1 messages between a sandboxed demo player and the scope page.
 * Pure, no DOM. Shared by the page (web/src/scope/page.ts) and the tests.
 */
import type { Anchor } from './scope-anchor.js'
import type { Thread } from './scope-doc.js'

export interface DemoRegion {
  x: number
  y: number
  w: number
  h: number
}

export interface DemoNoteMessage {
  type: 'rails-demo/note'
  v: 1
  /** 1..64 chars of [A-Za-z0-9_-]. */
  id: string
  /** Seconds, one decimal, 0..86400. */
  t: number
  /** Step index 0..999, or null when the player sent none or junk. */
  step: number | null
  /** Cut to 200 chars. */
  caption: string
  /** Stage fractions, or null when absent or not a box. */
  region: DemoRegion | null
  /** Trimmed, 1..4000 chars. */
  text: string
  /** A `data:image/png;base64,` URL under 3 MB, or null. */
  shot: string | null
}

export interface DemoStep {
  start: number
  /** Cut to 200 chars. */
  caption: string
}

export interface DemoMeta {
  /** `<app>/<feature>/<screen>`, or null. */
  unit: string | null
  /** 40 hex chars, or null. */
  sha: string | null
  /** 1..80 chars, or null. */
  run: string | null
}

export interface DemoReadyMessage {
  type: 'rails-demo/ready'
  v: 1
  /** Cut to 200 chars. */
  title: string
  /** Seconds, finite, greater than 0 and at most 600. */
  duration: number
  /** At most 100 steps. */
  steps: DemoStep[]
  /** Scene meta, or null when the player sent none. */
  demo: DemoMeta | null
}

export interface DemoTimeMessage {
  type: 'rails-demo/time'
  v: 1
  t: number
  playing: boolean
}

export interface DemoSizeMessage {
  type: 'rails-demo/size'
  v: 1
  /** Content height in px, rounded and clamped to 160..2400. */
  h: number
}

export type DemoMessage = DemoNoteMessage | DemoReadyMessage | DemoTimeMessage | DemoSizeMessage

export interface DemoPin {
  id: string
  t: number
  region: DemoRegion | null
  text: string
  author: 'Alex' | 'Agent'
  resolved: boolean
}

/**
 * A cleaned player message, or null. Accepts only a plain object with `v === 1`
 * and type `rails-demo/ready`, `rails-demo/note`, `rails-demo/time`, or `rails-demo/size`.
 * A note with a bad id, moment or text is null (the message cannot be filed).
 * A bad shot, step or region is nulled on the message and the rest is kept.
 */
export function readDemoMessage(data: unknown): DemoMessage | null

/** The note as a scope comment on the figure caption, with the player's moment, step and region. */
export function demoNote(msg: DemoNoteMessage, captionAnchor: Pick<Anchor, 'section' | 'quote'> & Partial<Anchor>): { anchor: Anchor | null; text: string }

/**
 * `rails-demo/notes` for one figure: threads whose anchor matches `captionAnchor`'s
 * section and quote and has a numeric `t`, earliest first. `region` is null when the thread has none.
 * `author` is 'Alex' when the thread author is 'alex', otherwise 'Agent'. `resolved` when the thread is not open.
 */
export function demoPins(threads: readonly Thread[], captionAnchor: { section: string; quote: string }): { type: 'rails-demo/notes'; v: 1; notes: DemoPin[] }
