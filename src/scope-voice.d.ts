/**
 * Voice on a scoping page: read and discuss the doc, answer questions,
 * comment "on this", drop thoughts. Fixed interface shared by the page
 * (web/src/scope/voice-mount.tsx), the daemon (token minting) and tests.
 * Every note goes through the page's normal note path (POST /api/scope/<slug>/note).
 */
import type { Anchor } from './scope-anchor.js'
import type { VoiceToolDeclaration } from './voice.js'

/** Everything the model may call on a scoping page (Gemini schema; xaiTools() converts). */
export const SCOPE_VOICE_TOOLS: VoiceToolDeclaration[]

/** The system instruction for a scoping call. */
export const SCOPE_VOICE_PROMPT: string

/** A part of the doc the model can read or show: 'ask' | 'plan' | 'questions' | 'decisions' | 'thread' | 'Q3'. */
export type ScopePart = 'ask' | 'plan' | 'questions' | 'decisions' | 'thread' | `Q${number}`

/** What the page does for the voice. */
export type ScopeVoiceUi =
  /** Scroll that part into view (a question: its card). */
  | { do: 'show'; part: ScopePart }
  /** End the call once the goodbye has played. */
  | { do: 'end_call' }

export interface ScopeToolResult {
  ok: boolean
  /** Read aloud as-is. Only { ok, speech } goes back to the model. */
  speech: string
  ui?: ScopeVoiceUi
}

/** POST /api/scope/<slug>/note body as voice sends it. */
export interface ScopeNoteBody {
  text: string
  qid?: string
  anchor?: Anchor
  via: 'voice'
}

export interface ScopeVoiceDeps {
  /** Current scope (GET /api/scope/<slug> → { slug, scope }). Called before every tool. */
  getScope(): Promise<{ slug: string; scope: Record<string, any> }>
  /** Send a note through the page's own path (optimistic on the page). Rejects with an Error on failure. */
  postNote(body: ScopeNoteBody): Promise<{ note: { id: number | string } }>
  /**
   * What the human is pointing at: the current text selection, tapped block or
   * open comment box (selection), and the block in the reading area of the
   * viewport (inView). Either may be null.
   */
  getContext(): { selection: Anchor | null; inView: Anchor | null }
}

export interface ScopeVoiceSession {
  /** Run one tool call. Never throws: failures come back as { ok: false, speech }. */
  handle(name: string, args: Record<string, unknown>): Promise<ScopeToolResult>
}

export function createScopeVoiceSession(deps: ScopeVoiceDeps): ScopeVoiceSession
