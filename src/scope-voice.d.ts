/**
 * Voice on a scoping page, contract v2: a quiet router over the doc and its
 * threads. Alex leads; the voice acknowledges, confirms in one line, and
 * moves the page. Fixed interface shared by the page
 * (web/src/scope/voice-mount.tsx), the daemon (token minting) and tests.
 * Pure ESM, no Node or DOM APIs.
 *
 * Speech rules the session enforces (the prompt asks the model to say speech as given):
 * - "Reads" are the only long turns: read_thread, next/previous_question (the question text),
 *   go_to_section / next/previous_section (the heading).
 * - Every other tool's speech is at most 12 words.
 * - Speech never carries thread ids, section ids, URLs or tool names. One exception: the confirm line reads his
 *   own words back (ids and URLs removed, cut to 8 words) even when they name a tool, so he hears what will be sent.
 */
import type { Anchor } from './scope-anchor.js'
import type { ScopeV2, Thread } from './scope-doc.js'
import type { VoiceProvider, VoiceToolDeclaration } from './voice.js'

/** Everything the model may call on a scoping page (Gemini schema; xaiTools() converts). */
export const SCOPE_VOICE_TOOLS: VoiceToolDeclaration[]

/** The system instruction for a scoping call. Never asks for an overview or a batch of questions. */
export const SCOPE_VOICE_PROMPT: string

/** The first user turn the page sends to start the call (instead of 'Start the call.'): the model says "Ready." and waits. */
export const SCOPE_VOICE_KICKOFF: string

/** What the page does for the voice. */
export type ScopeVoiceUi =
  /** Focus the thread's card and scroll its highlight into view (open it on a phone). */
  | { do: 'focus_thread'; thread: string }
  /** Scroll the section's heading into view; focus moves to the section. */
  | { do: 'focus_section'; section: string }
  | { do: 'show_resolved'; on: boolean }
  /** Scroll the doc by about 80% of a screen. */
  | { do: 'scroll'; direction: 'up' | 'down' }
  /** End the call once the goodbye has played. */
  | { do: 'end_call' }
  /** Speaking speed (voice-live applies it; same shape as VoiceUi 'speed'): value is exact, change steps by 0.1 ('normal' = 1). */
  | { do: 'speed'; value?: number; change?: 'faster' | 'slower' | 'normal' }

export interface ScopeToolResult {
  ok: boolean
  /** Said as-is; explain instead returns grounding context for the model. */
  speech: string
  context?: string
  ui?: ScopeVoiceUi
}

/**
 * One row of the page's live tool feed (Alex, 2026-09-29: "live tool call feed and more visibility into what's going on").
 * The session calls deps.onFeed once per handle(), after the tool ran, success or not. Feed text is shown, never spoken,
 * so it may carry thread ids and § headings. <q> is a thread's first message or his words, cut to 10 words with '…'.
 * Labels (exact):
 * - next_question / previous_question → "Next question: T3" / "Previous question: T3"; read_thread → "Read T3 aloud".
 * - next_section / previous_section / go_to_section → "Went to §<heading>".
 * - show_resolved → "Showing resolved" / "Hiding resolved"; scroll → "Scrolled down" / "Scrolled up".
 * - answer on a question, or resolve with a decision → 'Proposed for T3: "<q>"'; cancel → "Dropped the proposal".
 * - confirm → 'Resolved T3: "<q of the decision>"'; take_recommendation → "Took the recommendation on T3";
 *   resolve at once on a comment → "Resolved T4".
 * - reject → "Said No on T3", plus ': "<q of the reason>"' when he gave one; park → "Parked T3".
 * - comment → "Commented on §<heading> (T7)" (the new thread); reply, or answer on a comment → "Replied on T3".
 * - end_call → "Ended the call".
 * - set_speed → "Speed 1.3×" (a set value, as the ui carries it) / "Faster" / "Slower" / "Normal speed".
 * - Any ok:false result → "Not done: <its speech>".
 * write = true only for a call that posted (confirm, take_recommendation, reject, park, an immediate resolve,
 * comment, reply, answer on a comment) and succeeded; thread = the thread it acted on (or moved to), when there is one.
 */
export interface ScopeFeedLine {
  tool: string
  label: string
  ok: boolean
  write: boolean
  thread?: string
}

export interface ScopeVoiceDeps {
  fetchContext?(question: string): Promise<{ brief: string; said: { at_et: string; source: string; text: string }[] }>
  postLaneNote(body: { text: string; via: 'voice' }): Promise<unknown>
  /** Optional: receives one feed line per tool call (see ScopeFeedLine). Never affects the tool result, even if it throws. */
  onFeed?(line: ScopeFeedLine): void
  /** Optional: the provider this call runs on, once known. Speaking speed works only on 'xai'. */
  getProvider?(): VoiceProvider | undefined
  /** Current scope (GET /api/scope/<slug>). Called before every tool. */
  getScope(): Promise<{ slug: string; scope: ScopeV2 }>
  /**
   * What the page has in focus right now: the focused thread (the card in view or last clicked; the
   * page updates it after every focus_thread), the section in the reading area, and the text selection.
   */
  getContext(): { thread: string | null; section: string | null; selection: Anchor | null }
  /** POST /api/scope/<slug>/threads (human). Rejects with an Error on failure. */
  postThread(body: { anchor: Anchor; text: string; via: 'voice' }): Promise<{ thread: Thread }>
  /** POST /api/scope/<slug>/threads/<id>/reply (human). */
  postReply(thread: string, body: { text: string; via: 'voice' }): Promise<{ thread: Thread }>
  /** POST /api/scope/<slug>/threads/<id>/resolve (human). */
  postResolve(thread: string, body: { decision: string; alex_words: string; how: 'take' | 'own' | 'resolve'; via: 'voice' }): Promise<{ thread: Thread }>
  /** POST /api/scope/<slug>/threads/<id>/reject (human): his No; the thread stays open. */
  postReject(thread: string, body: { text: string; via: 'voice' }): Promise<{ thread: Thread }>
  /** POST /api/scope/<slug>/threads/<id>/park (human): "Not now". */
  postPark(thread: string, body: { via: 'voice' }): Promise<{ thread: Thread }>
}

export interface ScopeVoiceSession {
  /** Run one tool call. Never throws: failures come back as { ok: false, speech }. */
  handle(name: string, args: Record<string, unknown>): Promise<ScopeToolResult>
}

/**
 * Tools (names are the contract; the session keeps one pending proposal):
 * - next_question / previous_question {}: step through OPEN threads in orderThreads order from the focused
 *   one (none focused → the first open). A focused thread that is not open (just resolved or parked) steps by
 *   doc position, status ignored: next = the first open thread after it in the doc, previous = the last one before it. ui focus_thread; speech = the thread's first message (a read).
 *   Past the end → ok:false "That's the last open one." / "That's the first open one."
 * - read_thread {}: the focused thread: its first message, then "I'd suggest: <rec>. Because: <why>." when
 *   present, then the last two other messages as "<You|The lane> said: <text>". Resolved: "Resolved as: <decision>."
 * - next_section / previous_section {}, go_to_section { name }: name matches a heading (case-insensitive,
 *   contains) or an id. ui focus_section; speech = the heading.
 * - show_resolved { on: BOOLEAN }: speech "Showing resolved." / "Hiding resolved."
 * - scroll { direction: 'up'|'down' }: speech "Okay."
 * - answer { text }: his words while a thread is focused ("do X instead" is his own answer). On an open question → a proposal: nothing is sent;
 *   speech "Resolve this as: <text>. Yes?" (text cut to 8 words with '…' in speech only). On a comment → a
 *   reply, sent at once, speech "Sent.". No focused thread → ok:false "Which one? Say next question."
 * - take_recommendation {}: focused open question with a recommendation → postResolve at once with
 *   { decision: rec, alex_words: 'Take the recommendation', how: 'take' }; speech "Done. Took the recommendation."
 * - reject { reason?: STRING }: his No ("no", "I hate it", "try again", "give me options") on the focused open
 *   question with a recommendation → postReject at once with text = reason ?? ''; speech
 *   "Sent. Waiting for a new option." Otherwise ok:false "Nothing to say no to here."
 * - park {}: "not now" on the focused open question → postPark at once; speech "Parked for later."
 * - confirm {}: sends the pending proposal (postResolve with decision = alex_words = his text, how 'own'); speech
 *   "Resolved." No pending → ok:false "Nothing to confirm."
 * - cancel {}: drops the pending proposal; speech "Okay, left open."
 * - resolve { decision?: STRING }: with a non-empty decision → a proposal on the focused open thread (question or
 *   comment), confirmed like answer's (a comment confirms with how 'resolve'). Without one:
 *   a pending proposal → confirm it; an open comment → resolve at once as 'Resolved', how 'resolve' (speech "Resolved.");
 *   a question → ok:false "Resolve it as what?".
 * - comment { text }: anchors to the selection, else the focused section (anchorInSection on its heading),
 *   else the title; postThread at once; speech "Posted."
 * - reply { text }: on the focused thread, postReply at once; speech "Sent."
 * - end_call {}: speech "Talk soon.", ui end_call.
 * - set_speed { speed?: NUMBER, change?: 'faster'|'slower'|'normal' }: "talk faster", "slow down", "normal speed",
 *   "go 1.3". Not a proposal: it never touches a pending one. getProvider() === 'gemini' → ok:false
 *   "I can only change speed on Grok." A finite speed → clamp to 0.7–1.5, round to 0.1, speech "Okay." ui { do:'speed', value };
 *   else a valid change → speech "Okay." ui { do:'speed', change }; else ok:false "Say faster, slower, or a number."
 * Any new tool call other than confirm and set_speed drops a pending proposal. Blank text → ok:false "I didn't catch that."
 * A post that rejects → ok:false "That didn't send: <message>."
 */
export function createScopeVoiceSession(deps: ScopeVoiceDeps): ScopeVoiceSession
