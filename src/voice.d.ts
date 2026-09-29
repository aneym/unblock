/**
 * Voice triage: the queue as a spoken call. Fixed interface shared by the
 * browser panel (web/src/Voice*.tsx) and the tests; the rules live in
 * voice.js so no surface re-decides what may be said or sent.
 */

/** A Gemini Live function declaration (JSON-schema `parameters`). */
export interface VoiceToolDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Everything the model is allowed to call. Names match [a-zA-Z0-9_]. */
export const VOICE_TOOLS: VoiceToolDeclaration[]

/** The system instruction for the call. */
export const VOICE_SYSTEM_PROMPT: string

/** Why an ask is left for the screen instead of voice. */
export type ScreenReason = 'approval' | 'secret' | 'paste'

export interface VoiceDeck<A> {
  /** Voice-eligible asks in triage order; position n is voice[n - 1]. */
  voice: A[]
  /** Asks voice will not answer, with the reason it says aloud. */
  screen: { ask: A; reason: ScreenReason }[]
}

/** Split and order the open asks. Pure. */
export function voiceDeck<A>(asks: A[]): VoiceDeck<A>

/** What a tool call returns to the model: `speech` is read aloud as-is. */
export interface ToolResult {
  ok: boolean
  speech: string
  /** Set when the call touched one ask, so the page can show that card. */
  ticket?: string
  /** Set after a successful answer or send-back, so the page reloads the queue. */
  changed?: boolean
}

/** The body POST /api/answer takes, exactly as the panel sends it. */
export interface AnswerBody {
  ticket: string
  revision: number
  values?: Record<string, unknown>
  reply?: string
  field_context?: Record<string, string>
  field_bounce?: Record<string, string>
  bounce?: boolean
}

export interface VoiceSessionDeps<A> {
  /** Fresh open asks (GET /api/queue → asks). Called before every tool that addresses a position. */
  getAsks(): Promise<A[]>
  /** POST /api/answer. Rejects with an Error carrying `.code` (e.g. STALE_REVISION, ASK_NOT_OPEN) on failure. */
  postAnswer(body: AnswerBody): Promise<{ complete?: boolean }>
  now?: () => number
}

export interface VoiceSession {
  /** Run one tool call. Never throws: failures come back as { ok: false, speech }. */
  handle(name: string, args: Record<string, unknown>): Promise<ToolResult>
}

/**
 * The stateful half: positions, the preview-before-answer guard, skips.
 * ask_answer succeeds only when its ticket, values and context equal the last
 * ask_preview for that ticket in this session.
 */
export function createVoiceSession<A>(deps: VoiceSessionDeps<A>): VoiceSession

/** POST /api/voice/session response. */
export interface VoiceSessionToken {
  /** Ephemeral Gemini token name ("auth_tokens/…"), single use. */
  token: string
  model: string
  /** ISO time after which a new session cannot start with this token. */
  expires_at: string
}
