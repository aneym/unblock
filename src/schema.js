/**
 * The ask schema. This is the contract every client shares, and it is
 * deliberately strict: an agent may only park after it has said exactly what
 * it needs and what filling it in unblocks.
 *
 * The item rules come from the /unblock skill and are enforced here rather
 * than trusted to the agent:
 *   - self-contained (the human never needs the transcript)
 *   - one action per ask
 *   - state the payoff, not the history
 */

export const FIELD_TYPES = ['text', 'secret', 'choice', 'confirm', 'paste']

export const ASK_KINDS = ['file', 'park']

/**
 * Why the agent is asking. The test is: does the agent already know what
 * should happen?
 *
 *   blocker   YES, and it cannot do it. You hold a key it needs, or a console
 *             button only you can click, or an approval only you can give.
 *             The answer already exists; what is missing is your ACTION.
 *             A recommendation is forbidden — there is nothing to recommend.
 *
 *   decision  NO, and it should not guess. It has done the work, formed a
 *             view, and wants you to rule on it. Every field carries the
 *             agent's recommendation, so your job is to ratify, not author.
 *             What is missing is your JUDGEMENT.
 *
 * Blocker = do something. Decision = decide something.
 * Either may be parked or filed; that is a separate axis.
 */
export const ASK_PURPOSES = ['blocker', 'decision']

/**
 * open      registered, unanswered
 * bounced   the human sent it back instead of answering — the question was
 *           wrong, or missing options. Carries their note. A parked agent
 *           resumes on this and must re-ask better, not retry the same thing.
 * answered  every required field filled; a parked agent is wakeable
 * collected the agent has received the answers
 * orphaned  answered (or not) but the agent that asked is gone
 * expired   nobody answered before expires_at
 * cancelled the agent withdrew it (it solved the problem itself)
 */
export const ASK_STATUSES = [
  'open',
  'bounced',
  'answered',
  'collected',
  'orphaned',
  'expired',
  'cancelled',
]

const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/
const MAX_TITLE = 90
const MAX_FIELDS = 12

class ValidationError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message)
    this.name = 'ValidationError'
    this.path = path
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * C0 controls, DEL, and C1 controls. Every one of these is stripped from every
 * string an agent supplies.
 *
 * This is not hygiene, it is the trust boundary. Ask text is written by an LLM,
 * and an LLM can be steered by whatever it just read — a README, an issue, a
 * web page. That text is then rendered into a terminal (where ESC sequences
 * move the cursor, clear the screen, and retitle the window), into markdown
 * (where a newline escapes the heading it was meant to sit in), and into a
 * browser. Stripping here means every renderer downstream is safe by
 * construction instead of each one having to remember.
 *
 * Newlines go too. Prose that needs structure uses `steps`, which is a list.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g

function scrub(value) {
  return value.replace(CONTROL_CHARS, ' ').replace(/[ \t]{2,}/g, ' ')
}

function str(value, path, { max = 2000, min = 1 } = {}) {
  if (typeof value !== 'string') throw new ValidationError('must be a string', path)
  const trimmed = scrub(value).trim()
  if (trimmed.length < min) throw new ValidationError('must not be empty', path)
  if (trimmed.length > max) throw new ValidationError(`must be at most ${max} characters`, path)
  return trimmed
}

function optionalStr(value, path, opts) {
  if (value === undefined || value === null || value === '') return undefined
  return str(value, path, opts)
}

function validateField(raw, index, seen, purpose = 'blocker') {
  const path = `fields[${index}]`
  if (!isPlainObject(raw)) throw new ValidationError('must be an object', path)

  const name = str(raw.name, `${path}.name`)
  if (!NAME_RE.test(name)) {
    throw new ValidationError(
      'must be snake_case, start with a letter, max 48 chars',
      `${path}.name`,
    )
  }
  if (seen.has(name)) throw new ValidationError(`duplicate field name "${name}"`, path)
  seen.add(name)

  const type = str(raw.type, `${path}.type`)
  if (!FIELD_TYPES.includes(type)) {
    throw new ValidationError(`must be one of ${FIELD_TYPES.join(', ')}`, `${path}.type`)
  }

  const field = {
    name,
    type,
    label: str(raw.label ?? name, `${path}.label`, { max: 120 }),
    required: raw.required === undefined ? true : Boolean(raw.required),
    help: optionalStr(raw.help, `${path}.help`, { max: 600 }),
    url: optionalStr(raw.url, `${path}.url`, { max: 2000 }),
  }

  if (field.url && !/^https?:\/\//.test(field.url)) {
    throw new ValidationError('must be an http(s) URL', `${path}.url`)
  }

  if (type === 'choice') {
    if (!Array.isArray(raw.choices) || raw.choices.length < 2) {
      throw new ValidationError('choice fields need at least 2 choices', `${path}.choices`)
    }
    if (raw.choices.length > 12) {
      throw new ValidationError('at most 12 choices', `${path}.choices`)
    }
    field.choices = raw.choices.map((choice, i) => {
      const cpath = `${path}.choices[${i}]`
      if (typeof choice === 'string') return { value: str(choice, cpath), label: str(choice, cpath) }
      if (!isPlainObject(choice)) throw new ValidationError('must be a string or object', cpath)
      const value = str(choice.value, `${cpath}.value`, { max: 200 })
      return { value, label: str(choice.label ?? value, `${cpath}.label`, { max: 200 }) }
    })
    field.multi = Boolean(raw.multi)
  }

  if (type === 'paste') {
    // "run this and paste the output" — the command is the whole point.
    field.command = str(raw.command, `${path}.command`, { max: 1000 })
  }

  if (type === 'text') {
    field.multiline = Boolean(raw.multiline)
    field.placeholder = optionalStr(raw.placeholder, `${path}.placeholder`, { max: 200 })
  }

  if (type === 'secret') {
    // Where the value should end up. The agent never receives it either way;
    // it receives the reference the store hands back.
    field.store = optionalStr(raw.store, `${path}.store`, { max: 20 }) ?? 'auto'
    field.env_name = optionalStr(raw.env_name, `${path}.env_name`, { max: 64 })
    if (field.env_name && !/^[A-Z][A-Z0-9_]*$/.test(field.env_name)) {
      throw new ValidationError('must be SCREAMING_SNAKE_CASE', `${path}.env_name`)
    }
  }

  if (type === 'confirm') {
    field.required = true // "I did the thing" is meaningless as an optional field
  }

  if (purpose === 'decision') {
    // Deliberation never touches the keychain path, and running a command to
    // find something out is the agent's job, not yours.
    if (type === 'secret' || type === 'paste') {
      throw new ValidationError(`a decision cannot ask for a ${type} field`, `${path}.type`)
    }
    if (!isPlainObject(raw.recommend)) {
      throw new ValidationError(
        'every decision field needs recommend: {value, why} — if you have no recommendation, you have not thought it through yet',
        `${path}.recommend`,
      )
    }
    const why = str(raw.recommend.why, `${path}.recommend.why`, { max: 200 })
    const value = raw.recommend.value
    if (type === 'choice') {
      // The one-tap path, so the recommendation must name a real option.
      const allowed = field.choices.map((c) => c.value)
      if (!allowed.includes(value)) {
        throw new ValidationError(
          `must be one of the declared choices: ${allowed.join(', ')}`,
          `${path}.recommend.value`,
        )
      }
    } else if (type === 'confirm') {
      if (typeof value !== 'boolean') {
        throw new ValidationError('must be true or false', `${path}.recommend.value`)
      }
    } else {
      field.recommendIsText = true
    }
    field.recommend = {
      value: type === 'text' ? str(value, `${path}.recommend.value`, { max: 600 }) : value,
      why,
    }
    field.must_decide = Boolean(raw.must_decide)
  } else if (raw.recommend !== undefined) {
    // A pre-filled guess at something only you can know is how accept-all
    // stops being safe.
    throw new ValidationError(
      'a blocker field cannot carry a recommendation — the agent cannot know this value',
      `${path}.recommend`,
    )
  }

  return field
}

/**
 * Validate an incoming ask registration. Returns a normalized ask body
 * (without ids or timestamps — the store adds those).
 */
export function validateAsk(raw) {
  if (!isPlainObject(raw)) throw new ValidationError('ask must be an object')

  const kind = str(raw.kind ?? 'file', 'kind')
  if (!ASK_KINDS.includes(kind)) {
    throw new ValidationError(`must be one of ${ASK_KINDS.join(', ')}`, 'kind')
  }

  const purpose = str(raw.purpose ?? 'blocker', 'purpose')
  if (!ASK_PURPOSES.includes(purpose)) {
    throw new ValidationError(`must be one of ${ASK_PURPOSES.join(', ')}`, 'purpose')
  }

  const title = str(raw.title, 'title', { max: MAX_TITLE })
  const why = str(raw.why, 'why', { max: 1200 })

  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    throw new ValidationError('an ask needs at least one field — say what you need', 'fields')
  }
  if (raw.fields.length > MAX_FIELDS) {
    throw new ValidationError(`at most ${MAX_FIELDS} fields; split the ask`, 'fields')
  }

  const seen = new Set()
  const fields = raw.fields.map((f, i) => validateField(f, i, seen, purpose))

  // Enforce the blocker/decision line instead of trusting the label.
  //
  // The real discriminator is whether the agent could form a view. If it
  // enumerated the options, it knows the option space, so it can recommend one
  // — that is a decision. A value living outside its knowledge (a hostname, a
  // key, an account id) or an act only the human can perform is a blocker.
  //
  // So the rule is narrow on purpose: a blocker may not be made ENTIRELY of
  // choices. Free text, secrets, confirms and pastes are all legitimate
  // blockers. An earlier, tighter rule demanded a secret/confirm/paste and
  // wrongly rejected "what is your staging hostname", which is a real blocker.
  if (purpose === 'blocker' && fields.every((f) => f.type === 'choice')) {
    throw new ValidationError(
      'a blocker cannot be only choices — if you enumerated the options you can recommend one. ' +
        'Set purpose "decision" and give every field a recommendation.',
      'fields',
    )
  }

  // Accept-all is only safe while it cannot rubber-stamp the decisions that
  // actually needed you. Cap the ones that opt out of it.
  if (fields.filter((f) => f.must_decide).length > 3) {
    throw new ValidationError('at most 3 must_decide fields; split the round', 'fields')
  }

  const steps = raw.steps === undefined ? [] : raw.steps
  if (!Array.isArray(steps)) throw new ValidationError('must be an array of strings', 'steps')
  if (steps.length > 12) throw new ValidationError('at most 12 steps', 'steps')

  const links = raw.links === undefined ? [] : raw.links
  if (!Array.isArray(links)) throw new ValidationError('must be an array', 'links')

  return {
    kind,
    purpose,
    title,
    why,
    fields,
    steps: steps.map((s, i) => str(s, `steps[${i}]`, { max: 600 })),
    links: links.map((l, i) => {
      const path = `links[${i}]`
      if (!isPlainObject(l)) throw new ValidationError('must be an object', path)
      const url = str(l.url, `${path}.url`, { max: 2000 })
      if (!/^https?:\/\//.test(url)) throw new ValidationError('must be an http(s) URL', `${path}.url`)
      return { url, label: str(l.label ?? url, `${path}.label`, { max: 160 }) }
    }),
    ttl_seconds: normalizeTtl(raw.ttl_seconds),
  }
}

function normalizeTtl(value) {
  if (value === undefined || value === null) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError('must be a positive number', 'ttl_seconds')
  const MAX = 60 * 60 * 24 * 30
  return Math.min(Math.round(n), MAX)
}

/**
 * Origin is what lets the queue group by workspace and filter by profile.
 * Everything here is best-effort: an agent outside herdr supplies what it can.
 */
export function normalizeOrigin(raw = {}) {
  if (!isPlainObject(raw)) throw new ValidationError('origin must be an object')
  return {
    agent: optionalStr(raw.agent, 'origin.agent', { max: 40 }) ?? 'unknown',
    session_id: optionalStr(raw.session_id, 'origin.session_id', { max: 200 }),
    pane_id: optionalStr(raw.pane_id, 'origin.pane_id', { max: 200 }),
    tab_id: optionalStr(raw.tab_id, 'origin.tab_id', { max: 200 }),
    workspace_id: optionalStr(raw.workspace_id, 'origin.workspace_id', { max: 200 }),
    workspace_name: optionalStr(raw.workspace_name, 'origin.workspace_name', { max: 200 }),
    // A named herdr session is a SEPARATE server with its own state — hard
    // isolation, not a filter. The daemon is machine-global and therefore sees
    // asks from all of them, so record which one an ask came from rather than
    // silently mixing universes. Not a filter in v1; grouping only.
    herdr_session: optionalStr(raw.herdr_session, 'origin.herdr_session', { max: 100 }),
    // Profile membership. In herdr a profile is not a container: it is a tag on
    // workspaces, one active at a time, and the sidebar shows a workspace when
    // the active profile is in its list — or when the active profile is
    // `personal` and the list is empty. A PANE may carry its own profile tags
    // that override its workspace's, so callers should send the pane's
    // effective set (pane tags when present, else the workspace's).
    profiles: Array.isArray(raw.profiles)
      ? raw.profiles.slice(0, 16).map((p, i) => str(p, `origin.profiles[${i}]`, { max: 32 }))
      : [],
    cwd: optionalStr(raw.cwd, 'origin.cwd', { max: 1000 }),
    repo: optionalStr(raw.repo, 'origin.repo', { max: 200 }),
  }
}

/** Scrub an optional free-text value arriving outside validateAsk. */
export function optionalScrub(value, max = 600) {
  if (typeof value !== 'string') return undefined
  const cleaned = scrub(value).trim().slice(0, max)
  return cleaned === '' ? undefined : cleaned
}

export const DEFAULT_PROFILE = 'personal'

/** Herdr's own visibility rule, reimplemented so the queue can never disagree with the sidebar. */
export function matchesProfile(origin, activeProfile) {
  if (!activeProfile || activeProfile === '*') return true
  const profiles = origin?.profiles ?? []
  if (profiles.length === 0) return activeProfile === DEFAULT_PROFILE
  return profiles.includes(activeProfile)
}

/** An answer set is complete when every required field has a value. */
export function missingRequired(ask, answers = {}) {
  return ask.fields
    .filter((f) => f.required)
    .filter((f) => {
      const v = answers[f.name]
      // undefined = never answered. null = the human explicitly chose not to
      // answer this one — a real response, so it does not hold the ask open.
      if (v === undefined) return true
      if (v === null) return false
      if (typeof v === 'string') return v.trim() === ''
      if (Array.isArray(v)) return v.length === 0
      return false
    })
    .map((f) => f.name)
}

export { ValidationError }
