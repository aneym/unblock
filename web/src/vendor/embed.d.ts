// Declarations for embed.js, the page's half of the embed contract v2 (DESIGN-SYSTEM 8.4).

/** What a framed page may take from the host context (ui/initialize, host-context-changed). */
export interface HostContextLike {
  readonly theme?: string;
  readonly prefs?: { readonly contrast?: string | null; readonly motion?: string | null };
  readonly styles?: { readonly variables?: Readonly<Record<string, unknown>> };
}

/** Whether a host variable may be written onto the page: a --rails-* name and a plain value. */
export declare function isHostVariable(name: unknown, value: unknown): boolean;

/** Writes the host's scheme, contrast and motion onto <html> and every host variable that passes the filter; returns the names written. */
export declare function applyHostContext(context: HostContextLike | null | undefined, root?: HTMLElement): string[];
