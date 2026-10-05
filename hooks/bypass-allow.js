// Under bypassPermissions, Claude Code still stops for its own checks (an rm with a
// variable or glob target, a command it can't trace). Unattended lanes sat for hours
// on these (p112, 2026-10-04 23:24 to 10-05 08:53 ET). Alex, 2026-10-05: fix it.
// Allow such Bash prompts, except a delete that names a root or a main checkout, and
// except anything that touches Claude's own settings or hooks (no self-widening).
// Deliberately coarse: any delete verb plus any protected path anywhere in the
// command asks, so quoting, subshells, xargs and cd-then-relative all still ask.
const ROOTS = new Set(['/', '~', '$HOME', '/Users', '/Users/aneyman', '/Volumes',
  '/Volumes/StudioExt', '/Volumes/StudioExt/repos', '/Users/aneyman/.agent-rails',
  '/Users/aneyman/.claude', '~/.agent-rails', '~/.claude', '$HOME/.agent-rails', '$HOME/.claude'])
const CHECKOUT = /^\/Volumes\/StudioExt\/repos\/[^/]+$/
const DELETE = /(?:^|[\s;&|()`'"$])(?:rm|rmdir|unlink|shred|trash)(?=$|[\s;&|()`'"])|-delete\b|\bgit\s+clean\b/
const SELF = /(?:^|[\s'"=>(])(?:~|\$HOME|\/Users\/aneyman)?\/?\.claude\/(?:settings|hooks)|unblock\/hooks(?:\/|$|\s)/

// Strip quotes and escapes, turn ${HOME} into $HOME, collapse repeated slashes.
const plain = (command) => String(command).replace(/\\[ntr]/g, ' ').replace(/\\(.)/g, '$1').replace(/['"]/g, '')
  .replace(/\$\{HOME\}/g, '$HOME').replace(/\/{2,}/g, '/')

function protectedPath(word) {
  const t = word.replace(/\/\*$/, '').replace(/\/+$/, '') || '/'
  return ROOTS.has(t) || CHECKOUT.test(t)
}

export function rmHitsRoot(command) {
  const text = plain(command)
  if (!DELETE.test(text)) return false
  return text.split(/[\s;&|()`<>=]+/).filter(Boolean).some(protectedPath)
}

/** True when this PermissionRequest should be answered "allow" without a human. */
export function bypassAllows(input) {
  if (input?.permission_mode !== 'bypassPermissions' || input?.tool_name !== 'Bash') return false
  const command = String(input?.tool_input?.command ?? '')
  if (!command.trim()) return false
  if (SELF.test(plain(command))) return false
  if (/\.claude\//.test(plain(command)) && String(input?.cwd ?? '').replace(/\/+$/, '') === '/Users/aneyman') return false
  return !rmHitsRoot(command)
}

export const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
