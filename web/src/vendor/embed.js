// The page's half of the embed contract v2 (docs/design/DESIGN-SYSTEM.md section 8.4; ROLLOUT slice
// W1). A page Workspace frames receives the host context over the bridge (ui/initialize and
// ui/notifications/host-context-changed) and calls applyHostContext() with it. That is all it needs
// to follow the host:
//
//   data-scheme, data-contrast and data-motion on <html>, from the host, so rails.css components
//   follow the host through their own v2 tokens (rails-tokens.css keys on those attributes);
//   every --rails-* host variable that passes the filter, for pages that still read the legacy
//   names (embed.css and host.js hold the table).
//
// No v2 token is ever bound to a host variable, so nothing here can loop. Values go through CSSOM
// (style.setProperty), which a strict style-src allows. Pure at import: nothing runs until called.

const HOST_NAME = /^--rails-[a-z0-9-]{1,40}$/;
const UNSAFE_VALUE = /[;{}<>]|url\(/i;
const SCHEMES = new Set(['light', 'dark']);
const CONTRASTS = new Set(['more', 'normal']);
const MOTIONS = new Set(['reduce', 'full']);

/** Whether a host variable may be written onto the page: a --rails-* name and a plain value. */
export function isHostVariable(name, value) {
  return typeof name === 'string' && HOST_NAME.test(name) && typeof value === 'string' && value.length < 200 && !UNSAFE_VALUE.test(value);
}

function setChoice(root, attribute, value, allowed) {
  if (value === undefined) return;
  if (typeof value === 'string' && allowed.has(value)) root.setAttribute(attribute, value);
  else if (value === null || value === '') root.removeAttribute(attribute);
}

/**
 * Applies what the host sent: the scheme (`theme`), the viewer's contrast and motion (`prefs`) and
 * the host variables (`styles.variables`). A field the context leaves out changes nothing; a
 * preference sent as null clears it, so the page follows the system again.
 * @param {{ theme?: string, prefs?: { contrast?: string | null, motion?: string | null }, styles?: { variables?: Record<string, unknown> } }} context
 * @param {HTMLElement} [root]
 * @returns {string[]} the host variables written
 */
export function applyHostContext(context, root = globalThis.document?.documentElement) {
  if (!context || typeof context !== 'object' || !root) return [];
  setChoice(root, 'data-scheme', context.theme, SCHEMES);
  const prefs = context.prefs && typeof context.prefs === 'object' ? context.prefs : {};
  setChoice(root, 'data-contrast', prefs.contrast, CONTRASTS);
  setChoice(root, 'data-motion', prefs.motion, MOTIONS);
  const written = [];
  const variables = context.styles?.variables;
  if (variables && typeof variables === 'object') {
    for (const [name, value] of Object.entries(variables)) {
      if (!isHostVariable(name, value)) continue;
      root.style.setProperty(name, value);
      written.push(name);
    }
  }
  return written;
}
