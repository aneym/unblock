// Under bypassPermissions, Claude Code still stops for its own checks (an rm with a
// variable or glob target, a command it can't trace). Unattended lanes sat for hours
// on these (p112, 2026-10-04 23:24 to 10-05 08:53 ET). Alex, 2026-10-05: fix it.
// Allow such Bash prompts, except a delete that may hit a root or a main checkout, and
// except anything that may touch Claude's own settings or hooks (no self-widening).
// Fail closed (2026-10-05, after reviews kept finding lexical evasions): allow only what
// resolves with certainty. A delete operand must start with a named variable or be a plain
// path that resolves physically (symlinks before `..`) to an unprotected target; any delete
// the parser can't place, any cd in a deleting command, and any escape near `.claude` ask.
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Physical resolution: realpath each existing prefix before applying the next `..`.
// `up` sees each directory a `..` climbs out of.
function physical(path, base = '/', up = () => {}) {
  let cur = '/'
  for (const part of (isAbsolute(path) ? path : `${base}/${path}`).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { up(cur); cur = dirname(cur); continue }
    const next = join(cur, part)
    try { cur = realpathSync.native(next) } catch { cur = next }
  }
  return cur
}

const HOME = physical(homedir())
const REPOS = [physical('/Volumes/StudioExt/repos'), ...(process.env.UNBLOCK_REPOS_ROOT ? [physical(process.env.UNBLOCK_REPOS_ROOT)] : [])]
const CLAUDE = physical(join(HOME, '.claude'))
const HOOKS = [physical(dirname(fileURLToPath(import.meta.url))), physical(join(CLAUDE, 'hooks'))]
const ROOTS = new Set(['/', '/Users', '/Users/aneyman', HOME, '/Volumes', '/Volumes/StudioExt', ...REPOS,
  join(HOME, '.agent-rails'), CLAUDE, '/Users/aneyman/.agent-rails', '/Users/aneyman/.claude'].map((p) => physical(p)))
const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'srm'])
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'exec', 'env', 'nice', 'nohup', 'time', 'do', 'then', 'else',
  'if', 'while', 'until', '{', '!'])
// Any spelling of a delete verb, counted. More of these than parsed deletes means one is hidden.
const DELETE = /(?:^|[\s\/;&|()`'"$=])(?:rm|rmdir|unlink|shred|trash|srm)(?=$|[\s;&|()`'"])|-delete\b|\bgit\s+clean\b/g
const CD = /(?:^|[\s;&|(){}`'"$=])(?:cd|pushd|popd)(?=$|[\s;&|()`'"])/
const BINDS = /(?:^|[\s;&|(){}])(?:read|getopts|mapfile|readarray|declare|typeset|let|eval|source|\.(?=\s+[^\s;&|()-])|printf\s+-v|select)(?=$|[\s;&|()])/

const within = (path, root) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/')
const strip = (s) => String(s).replace(/\\\n/g, '').replace(/\\(.)/g, '$1').replace(/['"]/g, '')

// Split a command line into simple commands of words, honoring quotes, escapes, $( ) and
// backticks. Each word keeps its raw text. Returns null on anything unbalanced.
function parse(command) {
  const segs = [[]]
  let word = null
  let i = 0
  const s = String(command)
  const push = () => { if (word) segs.at(-1).push(word); word = null }
  const add = (ch) => { word ??= { raw: '', redirect: false }; word.raw += ch }
  let redirect = false
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      if (s[i + 1] === '\n') { i += 2; continue }
      if (i + 1 >= s.length) return null
      add(c + s[i + 1]); i += 2; continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = closing(s, i, c)
      if (end < 0) return null
      add(s.slice(i, end + 1)); i = end + 1; continue
    }
    if (c === '$' && s[i + 1] === '(') {
      const end = closing(s, i + 1, ')')
      if (end < 0) return null
      add(s.slice(i, end + 1)); i = end + 1; continue
    }
    if (c === '(' && word && word.raw.endsWith('=')) {
      const end = closing(s, i, ')')
      if (end < 0) return null
      add(s.slice(i, end + 1)); i = end + 1; continue
    }
    if (c === '<' || c === '>') {
      if (word && /^\d+$/.test(word.raw)) word = null
      push()
      while (s[i] === '<' || s[i] === '>' || s[i] === '&' || s[i] === '|') i++
      if (s[i] === '(') { segs.push([]); continue }
      redirect = true; continue
    }
    if (/[\s;&|()]/.test(c)) {
      push()
      if (c !== ' ' && c !== '\t') segs.push([])
      i++; continue
    }
    add(c)
    if (redirect) { word.redirect = true; redirect = false }
    i++
  }
  push()
  return segs.filter((seg) => seg.length)
}

// Index of the character that closes the quote or paren opened at `open`, or -1.
function closing(s, open, kind) {
  if (kind === "'") { const end = s.indexOf("'", open + 1); return end }
  let depth = 0
  for (let i = open + (kind === ')' ? 0 : 1); i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (kind === ')') {
      if (c === "'" || c === '"' || c === '`') { const end = closing(s, i, c); if (end < 0) return -1; i = end; continue }
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i
    } else if (c === kind) return i
    else if (kind === '"' && c === '$' && s[i + 1] === '(') { const end = closing(s, i + 1, ')'); if (end < 0) return -1; i = end }
  }
  return -1
}

// A main checkout has a .git directory; a worktree root has a .git file and may be removed.
function checkout(path) {
  return REPOS.some((root) => {
    if (within(root, path) || dirname(path) === root) return true
    if (!within(path, root)) return false
    if (/\/\.git(?:\/|$)/.test(path)) return true
    try { return statSync(join(path, '.git')).isDirectory() } catch { return false }
  })
}

// Claude's settings and hooks, in any .claude dir, plus this hook's own directory.
function self(path) {
  if (HOOKS.some((h) => within(path, h))) return true
  const parts = path.toLowerCase().split('/')
  const settings = (i) => /^(?:settings|hooks)/.test(parts[i] ?? '')
  return (within(path.toLowerCase(), CLAUDE.toLowerCase()) && settings(CLAUDE.split('/').length))
    || parts.some((part, i) => part === '.claude' && settings(i + 1))
}

const protectedTarget = (p) => ROOTS.has(p) || checkout(p) || self(p) || [CLAUDE, ...HOOKS].some((d) => within(d, p))

// A word that names one path with no expansion left, as a physical path; null when ambiguous,
// including a `..` that climbs out of a protected directory (repos/../../x).
function plainPath(raw, cwd) {
  if (/[\\{}*?[\]$`]/.test(raw)) return null
  let text = raw.replace(/['"]/g, '')
  if (/^~(?:\/|$)/.test(raw)) text = HOME + text.slice(1)
  else if (raw.startsWith('~')) return null
  if (!text) return null
  if (!isAbsolute(text) && !cwd) return null
  let climbs = false
  const p = physical(text, cwd, (dir) => { climbs ||= protectedTarget(dir) })
  return climbs ? null : p
}

const VARIABLE = /^"?\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)(?::?\?[^}]*)?\})/
const UNSAFE_VARS = new Set(['HOME', 'PWD', 'OLDPWD'])

// True when a delete operand is certainly safe: a named variable we trust, or a plain safe path.
function operandOk(raw, cwd, command, seen = new Set()) {
  const v = raw.match(VARIABLE)
  if (v) {
    const name = v[1] ?? v[2]
    if (UNSAFE_VARS.has(name) || seen.has(name)) return false
    seen.add(name)
    if (new RegExp(`\\$\\{${name}:?[-=+]`).test(command)) return false
    return bindingsOk(name, cwd, command, seen)
  }
  const p = plainPath(raw, cwd)
  return p !== null && !protectedTarget(p)
}

// A variable set in the same command must be set to something we can check.
function bindingsOk(name, cwd, command, seen) {
  const segs = parse(command) ?? []
  for (const seg of segs) {
    for (const [k, w] of seg.entries()) {
      if (w.raw.startsWith(`${name}=`)) {
        const value = w.raw.slice(name.length + 1).replace(/^"(.*)"$/, '$1')
        if (/^\$\(mktemp(?:\s+[\w./-]+)*\)$/.test(value)) continue
        if (!value || !operandOk(value, cwd, command, seen)) return false
      }
      if (w.raw === 'for' && seg[k + 1]?.raw === name) {
        if (seg[k + 2]?.raw !== 'in') return false
        if (!seg.slice(k + 3).every((x) => operandOk(x.raw, cwd, command, seen))) return false
      }
    }
  }
  return !(BINDS.test(command) && new RegExp(`\\b${name}\\b`).test(command.replace(/\$\{?\w+/g, '')))
}

// Every delete the parser can place: its verb and the operands to check.
function deletes(segs) {
  const found = []
  for (const seg of segs) {
    const words = seg.filter((w) => !w.redirect)
    let k = 0
    while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k].raw)) k++
    while (k < words.length && PREFIXES.has(strip(words[k].raw).split('/').at(-1))) {
      k++
      while (k < words.length && (words[k].raw.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[k].raw))) k++
    }
    if (k >= words.length) continue
    const verb = strip(words[k].raw).split('/').at(-1)
    const rest = words.slice(k + 1)
    if (DELETERS.has(verb) || /[$`]/.test(words[k].raw)) {
      const dashdash = rest.findIndex((w) => w.raw === '--')
      found.push({ verb, dynamic: !DELETERS.has(verb), operands: rest.filter((w, j) => (dashdash >= 0 && j > dashdash) || !w.raw.startsWith('-')) })
    } else if (verb === 'find' && rest.some((w) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(strip(w.raw)))) {
      const end = rest.findIndex((w) => /^[-(!]/.test(strip(w.raw)))
      const roots = rest.slice(0, end < 0 ? rest.length : end)
      found.push({ verb, operands: roots.length ? roots : [{ raw: '.' }] })
    } else if (verb === 'git' && rest.some((w) => strip(w.raw) === 'clean')) {
      if (rest.some((w) => /^--(?:git-dir|work-tree)/.test(strip(w.raw)))) found.push({ verb, operands: [{ raw: '$(unknown)' }] })
      else {
        const c = rest.findIndex((w) => w.raw === '-C')
        found.push({ verb, operands: [c >= 0 ? rest[c + 1] ?? { raw: '' } : { raw: '.' }] })
      }
    }
  }
  return found
}

// cd/pushd/popd targets that land in .claude or a hooks dir, or are unknowable near settings or hooks.
function cdAsks(segs, command, cwd) {
  const near = /settings|hooks|claude/i.test(strip(command))
  for (const seg of segs) {
    const words = seg.filter((w) => !w.redirect)
    let k = 0
    while (k < words.length && ['builtin', 'command'].includes(strip(words[k].raw))) k++
    const verb = strip(words[k]?.raw ?? '')
    if (!['cd', 'pushd', 'popd'].includes(verb)) continue
    const args = words.slice(k + 1).filter((w) => !/^-[LPe@]+$/.test(w.raw))
    const p = verb === 'popd' || args[0]?.raw === '-' ? null : args.length ? plainPath(args[0].raw, cwd) : HOME
    if (p === null) { if (near) return true; continue }
    if (self(p) || p.toLowerCase().split('/').includes('.claude') || within(p.toLowerCase(), CLAUDE.toLowerCase())) return true
  }
  return false
}

// Every path-like word anywhere in the text, quotes and escapes dropped, as physical paths.
function paths(command, cwd) {
  return strip(command).split(/[\s;&|()`<>=]+/).filter((w) => w && !w.startsWith('-') && !w.includes('$')).map((word) => {
    const w = word.replace(/^~(?=\/|$)/, HOME).replace(/(?:\/\*)+$/, '') || '/'
    return physical(w, cwd || HOME)
  })
}

// True when the text holds an unquoted brace expansion ({a,b} or {1..3}), including inside
// a $( ) that sits in double quotes. ${...} is parameter expansion and is skipped.
function braceExpands(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const end = s.indexOf("'", i + 1); if (end < 0) return true; i = end; continue }
    if (c === '"') {
      const end = closing(s, i, '"')
      if (end < 0) return true
      const inner = s.slice(i + 1, end)
      for (let j = inner.indexOf('$('); j >= 0; j = inner.indexOf('$(', j + 1)) {
        const close = closing(inner, j + 1, ')')
        if (close < 0 || braceExpands(inner.slice(j + 2, close))) return true
      }
      i = end; continue
    }
    if (c === '$' && s[i + 1] === '{') { const end = s.indexOf('}', i); if (end < 0) return true; i = end; continue }
    if (c !== '{') continue
    let depth = 0
    for (let j = i; j < s.length && !/\s/.test(s[j]); j++) {
      if (s[j] === '{') depth++
      else if (s[j] === '}' && --depth === 0) { if (/,|\.\./.test(s.slice(i + 1, j))) return true; break }
    }
  }
  return false
}

const MKTEMP = /^\$\(mktemp(?:\s+[\w./-]+)*\)$/
const ref = (name) => new RegExp(`\\$(?:${name}(?!\\w)|\\{${name}(?::?\\?[^}]*)?\\})`, 'g')

// Values bound in this line by NAME=v, export/local/readonly NAME=v and `for NAME in v...`,
// each one literal text, a mktemp, or other (anything still holding $ or a backtick).
function bindings(segs) {
  const found = new Map()
  const bind = (name, raw) => {
    const kind = MKTEMP.test(raw.replace(/^"(.*)"$/, '$1')) ? 'mktemp' : /[$`]/.test(raw) ? 'other' : 'literal'
    if (!found.has(name)) found.set(name, [])
    found.get(name).push({ kind, value: kind === 'literal' ? strip(raw) : raw })
  }
  for (const seg of segs) {
    let k = 0
    if (['export', 'local', 'readonly'].includes(seg[0]?.raw)) k = 1
    for (; k < seg.length; k++) {
      const m = seg[k].raw.match(/^([A-Za-z_]\w*)=(.*)$/s)
      if (!m) break
      bind(m[1], m[2])
    }
    const f = seg.findIndex((w) => w.raw === 'for')
    if (f >= 0 && /^[A-Za-z_]\w*$/.test(seg[f + 1]?.raw ?? '') && seg[f + 2]?.raw === 'in') {
      for (const w of seg.slice(f + 3)) bind(seg[f + 1].raw, w.raw)
    }
  }
  return found
}

// Words a command deletes or writes: delete operands, redirect targets, tee files, the
// destination of cp/mv/install/ln (last operand or -t dir) and sed -i files.
function writes(segs) {
  const found = deletes(segs).flatMap((d) => d.operands)
  for (const seg of segs) {
    found.push(...seg.filter((w) => w.redirect))
    const words = seg.filter((w) => !w.redirect)
    let k = 0
    while (k < words.length && (/^[A-Za-z_]\w*=/.test(words[k].raw) || PREFIXES.has(strip(words[k].raw)))) k++
    const verb = strip(words[k]?.raw ?? '').split('/').at(-1)
    const rest = words.slice(k + 1)
    const operands = rest.filter((w) => !w.raw.startsWith('-'))
    if (verb === 'tee') found.push(...operands)
    else if (verb === 'sed' && rest.some((w) => /^-[^-]*i|^--in-place/.test(w.raw))) found.push(...operands)
    else if (['cp', 'mv', 'install', 'ln'].includes(verb)) {
      const t = rest.findIndex((w) => w.raw === '-t' || w.raw.startsWith('--target-directory'))
      found.push(t >= 0 ? rest[t].raw.includes('=') ? rest[t] : rest[t + 1] ?? { raw: '' } : operands.at(-1) ?? { raw: '' })
    }
  }
  return found
}

/** True when this PermissionRequest should be answered "allow" without a human. */
export function bypassAllows(input) {
  if (input?.permission_mode !== 'bypassPermissions' || input?.tool_name !== 'Bash') return false
  const command = String(input?.tool_input?.command ?? '')
  if (!command.trim()) return false
  const cwd = isAbsolute(String(input?.cwd ?? '')) ? physical(String(input.cwd)) : null
  const segs = parse(command)
  if (!segs) return allows(command, cwd)
  const bound = bindings(segs)
  const words = segs.flat()

  // A brace expansion asks, unless it hangs off a mktemp dir and never climbs out of it.
  const mktemp = (name) => bound.get(name)?.every((b) => b.kind === 'mktemp')
  for (const w of words.filter((x) => braceExpands(x.raw))) {
    const m = w.raw.match(/^"?\$\{?([A-Za-z_]\w*)\}?"?\/(.*)$/s)
    if (!m || !mktemp(m[1]) || m[2].includes('..')) return false
  }
  // A variable bound to something we can't read asks when glued to other text in a word
  // that deletes or writes; reads like `ls $R/x` stay allowed.
  const touched = writes(segs)
  for (const [name, list] of bound) {
    if (!list.some((b) => b.kind === 'other')) continue
    if (touched.some((w) => { const hits = w.raw.match(ref(name)); return hits && w.raw.replace(/"/g, '') !== hits[0] })) return false
  }
  // Run every check on the line as written and on each substitution of its literal bindings.
  let variants = [command]
  for (const [name, list] of bound) {
    const literals = list.filter((b) => b.kind === 'literal')
    if (!literals.length || !ref(name).test(command)) continue
    variants = variants.flatMap((v) => literals.map((b) => v.replace(ref(name), () => b.value)))
    if (variants.length > 256) return false
  }
  return allows(command, cwd) && variants.every((v) => allows(v, cwd))
}

function allows(command, cwd) {
  // Self-protect: any mention of .claude with settings or hooks, and any escaped word near .claude.
  for (const text of [command, strip(command)].map((t) => t.toLowerCase())) {
    if (text.includes('.claude') && /settings|hooks/.test(text)) return false
  }
  if (command.split(/\s+/).some((w) => /\\|\$'/.test(w) && strip(w).toLowerCase().includes('claude'))) return false
  if (paths(command, cwd).some(self)) return false

  // Deletes: every spelled delete verb must be one the parser placed, with no cd in the line.
  // A command word that is itself a variable or substitution gets the same operand checks.
  const segs = parse(command)
  const lexical = (strip(command).match(DELETE) ?? []).length
  const found = segs ? deletes(segs) : []
  if (!lexical && !found.length) return !(segs && cdAsks(segs, command, cwd))
  if (segs === null || cdAsks(segs, command, cwd) || CD.test(strip(command))) return false
  if (lexical > found.filter((d) => !d.dynamic).length) return false
  if (paths(command, cwd).some(protectedTarget)) return false
  return found.every(({ operands }) => operands.every((w) => operandOk(w.raw, cwd, command)))
}

export const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
