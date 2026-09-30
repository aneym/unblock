export type ActionKind = 'read' | 'move' | 'change' | 'send' | 'phone' | 'screen-only';
export interface ActionResult { ok: boolean; speech: string; [key: string]: unknown }
export interface WireAction { id: string; label: string; kind: ActionKind; keys?: string }
export interface PageAction extends WireAction {
  placement?: 'title' | 'menu';
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
  preview?(args?: Record<string, unknown>): unknown | Promise<unknown>;
}
export interface PageMessage {
  v: 1; title: string; back?: { label: string; route: string }; primary?: string; menu?: string[]; actions: WireAction[];
}
export interface PageSpec {
  title: string; app?: string; description?: string; back?: { label: string; route: string }; primary?: string; actions?: PageAction[];
  updatedAt?: number | Date | string; staleAfterMs?: number; onRefresh?(): void; onNavigate?(route: string): void;
  chat?: { open?: boolean; onToggle?(): void }; settings?: { label: string; route: string };
  initialize?: { app: string; version?: string; search?: unknown } | false; hostOrigins?: string[];
}
export interface PageHandle {
  readonly framed: boolean; readonly root: HTMLElement; readonly spec: Readonly<PageSpec>;
  update(patch: Partial<PageSpec>): void; announce(): void; destroy(): void;
}
export interface CommentsState { open: number; index: number; total: number; showResolved: boolean }
export interface CommentsOptions extends CommentsState { onPrev?(): void; onNext?(): void; onShowResolved?(checked: boolean): void }
export declare const VERSION: 'page-chrome@1.0';
export declare function validatePageMessage(params: unknown): { ok: boolean; errors: string[] };
export declare function pageMessage(spec: PageSpec): PageMessage;
export declare function statusLine(updatedAt: number | Date | string | undefined, staleAfterMs: number | undefined, now?: number): string;
export declare function mountPage(root: HTMLElement, spec: PageSpec): PageHandle;
export declare function commentsHeader(root: HTMLElement, opts: CommentsOptions): { update(state: Partial<CommentsOptions>): void; destroy(): void };
export declare function pageSuite(handle: PageHandle, options?: { now?: number }): { ok: boolean; failures: string[] };
