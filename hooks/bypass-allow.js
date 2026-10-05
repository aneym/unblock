// Under bypassPermissions, Claude Code still stops for its own checks (an rm with a
// variable or glob target, a command it can't trace). Unattended lanes sat for hours
// on these (p112, 2026-10-04 23:24 to 10-05 08:53 ET). Alex, 2026-10-05: fix it.
// Allow such Bash prompts, except a delete that names a root or a main checkout, and
// except anything that touches Claude's own settings or hooks (no self-widening).
// Deliberately coarse: any delete verb plus any protected path anywhere in the
// command asks, so quoting, subshells, xargs and cd-then-relative all still ask.
// Each path word is resolved against the hook's cwd and normalized first, so `./`, `..`
// and relative spellings of a protected path ask too.
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = homedir()
const REPOS = '/Volumes/StudioExt/repos'
const ROOTS = new Set(['/', '/Users', '/Users/aneyman', HOME, '/Volumes', '/Volumes/StudioExt', REPOS,
  join(HOME, '.agent-rails'), join(HOME, '.claude'), '/Users/aneyman/.agent-rails', '/Users/aneyman/.claude'])
const CHECKOUT = /^\/Volumes\/StudioExt\/repos\/[^/]+$/
const DELETE = /(?:^|[\s\/;&|()`'"$])(?:rm|rmdir|unlink|shred|trash)(?=$|[\s;&|()`'"])|-delete\b|\bgit\s+clean\b/
const SELF = /\.claude\/(?:settings|hooks)|unblock\/hooks(?:\/|$|\s)/
const HOOKS = [dirname(fileURLToPath(import.meta.url))]
try { HOOKS.push(realpathSync(HOOKS[0])) } catch {}

// Strip quotes and escapes, turn ${HOME} into $HOME, collapse repeated slashes.
const plain = (command) => String(command).replace(/\\[ntr]/g, ' ').replace(/\\(.)/g, '$1').replace(/['"]/g, '')
  .replace(/\$\{HOME\}/g, '$HOME').replace(/\/{2,}/g, '/')

const within = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/')

// Every path-like word, as absolute normalized paths (and their realpaths when they exist).
// A word with any other variable in it is unknown, so it is skipped: `rm -rf "$X"` stays allowed.
function paths(command, cwd) {
  const base = isAbsolute(String(cwd ?? '')) ? String(cwd) : HOME
  return plain(command).split(/[\s;&|()`<>=]+/).filter((w) => w && !w.startsWith('-')).flatMap((word) => {
    const w = word.replace(/^(?:~|\$HOME)(?=\/|$)/, HOME).replace(/(?:\/\*)+$/, '') || '/'
    if (w.includes('$')) return []
    const abs = resolve(base, w)
    try { return [abs, realpathSync(abs)] } catch { return [abs] }
  })
}

// A main checkout has a .git directory; a worktree root has a .git file and may be removed.
function checkout(path) {
  if (CHECKOUT.test(path)) return true
  if (!within(path, REPOS)) return false
  if (/\/\.git(?:\/|$)/.test(path)) return true
  try { return statSync(join(path, '.git')).isDirectory() } catch { return false }
}

const self = (path) => within(path, join(HOME, '.claude', 'hooks')) || HOOKS.some((h) => within(path, h))
  || (basename(dirname(path)) === '.claude' && basename(path).startsWith('settings'))

export function rmHitsRoot(command, cwd) {
  const text = plain(command)
  // plain() reads \r in `\rm` as a carriage return, so also look for the verb with escapes just dropped.
  const verbs = String(command).replace(/\\(.)/g, '$1').replace(/['"]/g, '')
  if (!DELETE.test(text) && !DELETE.test(verbs)) return false
  return paths(command, cwd).some((p) => ROOTS.has(p) || checkout(p))
}

/** True when this PermissionRequest should be answered "allow" without a human. */
export function bypassAllows(input) {
  if (input?.permission_mode !== 'bypassPermissions' || input?.tool_name !== 'Bash') return false
  const command = String(input?.tool_input?.command ?? '')
  if (!command.trim()) return false
  if (SELF.test(plain(command)) || paths(command, input?.cwd).some(self)) return false
  return !rmHitsRoot(command, input?.cwd)
}

export const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
