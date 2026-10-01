export type ActionKind = 'read' | 'move' | 'change' | 'send' | 'phone' | 'screen-only';
export interface ActionResult { ok: boolean; speech: string; [key: string]: unknown }
export interface WireAction { id: string; label: string; kind: ActionKind; keys?: string }
export interface PageAction extends WireAction {
  placement?: 'title' | 'menu';
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
  preview?(args?: Record<string, unknown>): unknown | Promise<unknown>;
}
export interface PageMessage {
  v: 1; title: string; href?: string; back?: { label: string; route: string }; primary?: string; menu?: string[]; actions: WireAction[];
}
export interface PageSpec {
  /** The page's own shareable link: a path on its origin (preferred), or an https URL on an app origin. Never a one-time grant or token. Absent sends none; the host falls back. */
  href?: string;
  title: string;
  app?: string;
  description?: string;
  back?: { label: string; route: string };
  /** The primary is a title action, never listed in the menu. */
  primary?: string;
  actions?: PageAction[];
  updatedAt?: number | Date | string;
  staleAfterMs?: number;
  onRefresh?(): void;
  onNavigate?(route: string): void;
  chat?: {
    open?: boolean;
    onToggle?(): void;
    /** HTTPS only; defaults to https://app.rails.so. Used by the sheet when nothing takes the toggle. */
    railsUrl?: string;
  };
  settings?: { label: string; route: string };
  /** Framed pages with initialize omitted or false send rails/page and ui/update-model-context at once.
   * With initialize, they wait for the host's answer or 1.5 s before sending them. */
  initialize?: { app: string; version?: string; search?: unknown } | false;
  /** For a framed page, set this to forward the host's ⌘/Ctrl shortcuts as rails/key, or to keep them.
   * When omitted, keys forward only while initialize is a plain object. initialize: false still leaves the handshake to another bridge and forwards nothing. */
  forwardKeys?: boolean;
  hostOrigins?: string[];
}
export interface MountOptions { now?(): number }
export interface PageHandle {
  readonly framed: boolean; readonly root: HTMLElement; readonly spec: Readonly<PageSpec>;
  /** Clock reading used for the last status render. */
  readonly renderedAt: number;
  update(patch: Partial<PageSpec>): void; announce(): void; destroy(): void;
}
export interface CommentsState { open: number; index: number; total: number; showResolved: boolean }
export interface CommentsOptions extends CommentsState { onPrev?(): void; onNext?(): void; onShowResolved?(checked: boolean): void }
export declare const VERSION: 'page-chrome@1.2';
export declare function validatePageMessage(params: unknown): { ok: boolean; errors: string[] };
export declare function pageMessage(spec: PageSpec): PageMessage;
export declare function statusLine(updatedAt: number | Date | string | undefined, staleAfterMs: number | undefined, now?: number): string;
/** Without chat.onToggle, dispatches bubbling, cancelable page-chrome:chat on root.
 * A listener can preventDefault to take the toggle; otherwise a Rails chat sheet opens. */
export declare function mountPage(root: HTMLElement, spec: PageSpec, options?: MountOptions): PageHandle;
export declare function commentsHeader(root: HTMLElement, opts: CommentsOptions): { update(state: Partial<CommentsOptions>): void; destroy(): void };
export declare function pageSuite(handle: PageHandle, options?: { now?: number }): { ok: boolean; failures: string[] };
