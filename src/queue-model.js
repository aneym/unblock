/**
 * How a queue becomes something a human works through.
 *
 * One module, no dependencies, shared by every client: the browser panel, the
 * herdr TUI, and anything else that renders the queue. Ordering, grouping,
 * project scoping and the deep-link rule all live here so two surfaces cannot
 * disagree about what "next" means — and so the rules can be tested without a
 * browser, which is where the filter bugs kept hiding.
 */

/** created_at is epoch ms from the daemon and an ISO string in some fixtures. */
const at = (value) => (typeof value === 'number' ? value : new Date(value).getTime())

/** The project an ask belongs to: what the agent declared, else its origin. */
export function groupOf(ask) {
  const origin = ask.origin || {}
  return (
    ask.project ||
    origin.workspace_name ||
    origin.repo ||
    (origin.cwd ? origin.cwd.split('/').filter(Boolean).pop() : undefined) ||
    origin.agent ||
    'elsewhere'
  )
}

/**
 * Untouched. null is NOT missing: it is an explicit "no answer", a real
 * response the agent acts on.
 */
export function isMissing(value) {
  if (value === undefined) return true
  if (value === null) return false
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return value === false
}

export function unansweredFields(ask) {
  const answered = ask.answers || {}
  return (ask.fields || []).filter((field) => !(field.name in answered))
}

/** Gating first, detected last, oldest first inside each band. */
export function sortAsks(asks) {
  const rank = (ask) => (ask.origin?.detected === true ? 2 : ask.gating ? 0 : 1)
  return [...asks].sort((a, b) => rank(a) - rank(b) || at(a.created_at) - at(b.created_at))
}

/**
 * Short enough to share a card: nothing left in it but taps. A gating ask
 * always gets its own card (an agent is stopped on it), and anything with
 * typing, secrets, or steps deserves the full stage.
 */
export function isShort(ask) {
  if (ask.gating || ask.origin?.detected === true) return false
  if (ask.steps?.length) return false
  const open = unansweredFields(ask)
  if (open.length === 0 || open.length > 2) return false
  return open.every((field) => field.type === 'choice' || field.type === 'confirm')
}

export const MAX_GROUP_ASKS = 3
export const MAX_GROUP_FIELDS = 4

/**
 * Fold a sorted ask list into cards. Short asks from the same project pool
 * into a shared card; the card keeps the position of its first ask, so
 * grouping never reorders the deck's priorities.
 */
export function buildDeck(asks) {
  const items = []
  const openGroup = new Map()
  const fieldCount = (item) =>
    item.asks.reduce((total, ask) => total + unansweredFields(ask).length, 0)

  for (const ask of asks) {
    if (!isShort(ask)) {
      items.push({ key: ask.ticket, project: groupOf(ask), grouped: false, asks: [ask] })
      continue
    }
    const project = groupOf(ask)
    const current = openGroup.get(project)
    if (
      current &&
      current.asks.length < MAX_GROUP_ASKS &&
      fieldCount(current) + unansweredFields(ask).length <= MAX_GROUP_FIELDS
    ) {
      current.asks.push(ask)
      continue
    }
    const item = { key: `g_${ask.ticket}`, project, grouped: true, asks: [ask] }
    openGroup.set(project, item)
    items.push(item)
  }
  return items
}

/** [[project, open ask count]], busiest first, then alphabetical. */
export function projectCounts(asks) {
  const counts = new Map()
  for (const ask of asks) {
    const key = groupOf(ask)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * The whole selection, in one place.
 *
 * `project`      the filter the human chose, or null for everything.
 * `pinnedTicket` a #ask= deep link.
 * `deferredKeys` cards skipped this session, in the order they were skipped.
 * `doneTickets`  answered this session; dropped before the server catches up.
 *
 * The deep-link rule is the part that used to lie. A pinned ask SETS the
 * project rather than being smuggled past the filter: the picker then names
 * the project you are actually looking at. Prepending an out-of-scope card
 * made the filter look broken, because it was.
 */
export function selectDeck({
  asks = [],
  project = null,
  pinnedTicket = null,
  deferredKeys = [],
  doneTickets = new Set(),
} = {}) {
  const live = sortAsks(asks.filter((ask) => ask.status === 'open' && !doneTickets.has(ask.ticket)))
  const projects = projectCounts(live)

  const pinnedAsk = pinnedTicket ? live.find((ask) => ask.ticket === pinnedTicket) : undefined
  const activeProject = pinnedAsk
    ? groupOf(pinnedAsk)
    : project && projects.some(([name]) => name === project)
      ? project
      : null

  const scoped = activeProject ? live.filter((ask) => groupOf(ask) === activeProject) : live
  const deck = buildDeck(scoped)

  const pinnedItem = pinnedAsk
    ? deck.find((item) => item.asks.some((ask) => ask.ticket === pinnedAsk.ticket))
    : undefined
  const rest = deck.filter((item) => item !== pinnedItem)
  const fresh = rest.filter((item) => !deferredKeys.includes(item.key))
  // Skipped cards come back at the end, in the order they were skipped.
  const later = deferredKeys
    .map((key) => rest.find((item) => item.key === key))
    .filter((item) => item !== undefined)

  const items = [...(pinnedItem ? [pinnedItem] : []), ...fresh, ...later]
  return { items, projects, activeProject, current: items[0], remaining: items.length }
}
