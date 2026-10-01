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

/** The voice providers the panel can talk to. */
export type VoiceProvider = 'openai' | 'live' | 'xai' | 'gemini'

/**
 * One thing the page does for the voice, so the human drives the app by
 * talking. The page applies it at once; the model never sees it.
 */
export type VoiceUi =
  /** Open this ask's card (ask_read, show_screen_ask, and the next ask after answer/skip/send-back). */
  | { do: 'show_ask'; ticket: string }
  /** Go to the list. `project` shows only that project (exact groupOf name); `all` clears every product filter; neither keeps the filter. */
  | { do: 'show_list'; project?: string; all?: boolean }
  /** Go to the Answered list. */
  | { do: 'show_answered' }
  /** Open a link from the current ask in a new tab. `label` is what the page shows if the browser blocks the pop-up. */
  | { do: 'open_link'; url: string; label: string }
  /** Open or close the Details section of this ask's card. */
  | { do: 'details'; ticket: string; open: boolean }
  /** Show this ask with the previewed answer filled into its form (null values are left as they are). */
  | { do: 'fill'; ticket: string; values: Record<string, unknown>; field_context: Record<string, string> }
  /** End the call once the goodbye has finished playing. */
  | { do: 'end_call' }
  /** An issue was filed; the capsule shows a small "Filed #n ↗" chip linking to it. */
  | { do: 'filed'; number: number; url: string }
  /** Change how fast the agent talks. `value` is an exact multiplier; `change` steps from the current one. The page clamps to 0.7–1.5. */
  | { do: 'speed'; value?: number; change?: 'faster' | 'slower' | 'normal' }

/** What a tool call returns: `speech` is read aloud as-is; only { ok, speech } goes to the model. */
export interface ToolResult {
  ok: boolean
  speech: string
  /** Set when the call touched one ask. */
  ticket?: string
  /** Set after a successful answer or send-back, so the page reloads the queue. */
  changed?: boolean
  /** What the page should show now. */
  ui?: VoiceUi
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
  /** Fresh asks (GET /api/queue → asks, every status). Called before every tool. */
  getAsks(): Promise<A[]>
  /** POST /api/answer. Rejects with an Error carrying `.code` (e.g. STALE_REVISION, ASK_NOT_OPEN) on failure. */
  postAnswer(body: AnswerBody): Promise<{ complete?: boolean }>
  /** POST /api/voice/issue. Files the owner's request for the agents to pick up. Rejects with an Error on failure. */
  fileIssue?(issue: VoiceIssue): Promise<{ number: number; url: string }>
  /** Which provider this call runs on. Speaking speed only works on 'xai'. */
  provider?: VoiceProvider
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

/** What the owner asked to change, filed as a GitHub issue the agents pick up. */
export interface VoiceIssue {
  /** Short imperative title, e.g. "Show dates on the Answered list". */
  title: string
  /** The owner's own words, lightly tidied; never a secret. */
  details: string
  /** What it is about. */
  about: 'unblock' | 'dashboard' | 'other'
  /** The ticket on screen when it was filed, if any (added by the session, not the model). */
  ticket?: string
}

/** VOICE_TOOLS in the xAI realtime `session.tools` shape (lowercase JSON-schema types). Pure. */
export function xaiTools(tools?: VoiceToolDeclaration[]): { type: 'function'; name: string; description: string; parameters: Record<string, unknown> }[]

/** This month's voice spend against the cap (UTC calendar month). */
export interface VoiceSpend {
  spent_usd: number
  cap_usd: number | null
  /** "YYYY-MM" */
  period: string
}

/** GET /api/voice/providers response. */
export interface VoiceProviders {
  /** The provider a session gets when the request names none (or names one without a key). */
  default: VoiceProvider
  providers: { id: VoiceProvider; label: string; model: string; configured: boolean; usd_per_minute: number }[]
  spend: VoiceSpend
}

/** POST /api/voice/session { provider?: VoiceProvider } response. */
export interface VoiceSessionToken {
  /** The provider actually used: the requested one, else the other configured one. */
  provider: VoiceProvider
  /** Gemini: ephemeral token name ("auth_tokens/…"), single use. xAI: realtime client secret. */
  token: string
  model: string
  /** Provider voice name (Gemini prebuilt voice, xAI voice). */
  voice: string
  /** ISO time after which a new session cannot start with this token. */
  expires_at: string
  /** Spend-ledger reservation id; POST /api/voice/end { session_id, seconds } settles it. */
  session_id: string
  /** The page ends the call after this many minutes (cap headroom and voice_max_minutes). */
  max_minutes: number
  spend: VoiceSpend
}
