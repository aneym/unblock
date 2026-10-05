// Under bypassPermissions, Claude Code still stops for its own checks (an rm with a
// variable or glob target, a command it can't trace). Unattended lanes sat for hours
// on these (p112, 2026-10-04 23:24 to 10-05 08:53 ET). Alex, 2026-10-05: fix it.
// Allow such Bash prompts, except deleting a root or a main checkout, and except
// anything that touches Claude's own settings or hooks (no self-widening).
const ROOTS = new Set(['/', '~', '$HOME', '${HOME}', '/Users', '/Users/aneyman', '/Volumes',
  '/Volumes/StudioExt', '/Volumes/StudioExt/repos', '/Users/aneyman/.agent-rails',
  '/Users/aneyman/.claude', '~/.agent-rails', '~/.claude', '$HOME/.agent-rails', '$HOME/.claude'])
const CHECKOUT = /^\/Volumes\/StudioExt\/repos\/[^/]+$/
const SELF = /(?:~|\$HOME|\$\{HOME\}|\/Users\/aneyman)\/\.claude\/(?:settings[^\s'"]*|hooks\b)|\.claude\/settings[^\s'"]*\.json|unblock\/hooks\//

function protectedTarget(word) {
  let t = word.replace(/['"]/g, '')
  t = t.replace(/\/\*$/, '').replace(/\/+$/, '') || '/'
  return ROOTS.has(t) || CHECKOUT.test(t)
}

export function rmHitsRoot(command) {
  for (const segment of String(command).split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/)
    const at = words.findIndex((w) => /^(?:\/bin\/)?(?:rm|rmdir)$/.test(w))
    if (at < 0) continue
    if (words.slice(at + 1).filter((w) => !w.startsWith('-')).some(protectedTarget)) return true
  }
  return false
}

/** True when this PermissionRequest should be answered "allow" without a human. */
export function bypassAllows(input) {
  if (input?.permission_mode !== 'bypassPermissions' || input?.tool_name !== 'Bash') return false
  const command = String(input?.tool_input?.command ?? '')
  if (!command.trim()) return false
  return !rmHitsRoot(command) && !SELF.test(command)
}

export const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
