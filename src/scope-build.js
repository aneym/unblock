// The ```build fence: a scope's fan-out plan as JSON, shared by the daemon (lint on write) and the page (graph).
// Body: { "pieces": [{ id, label, deps[], p50_min, p90_min, runs_on }], "scenario"?: { label, p50_min, p90_min, runs_on, deps? } }
// The scenario runs last: by default it waits on every piece nothing else waits on.
const ID = /^[A-Za-z0-9][\w.-]{0,39}$/
const minutes = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000

function readPiece(raw, where, errors, scenario = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${where} must be an object`); return null }
  const id = scenario ? (raw.id ?? 'scenario') : raw.id
  if (typeof id !== 'string' || !ID.test(id)) { errors.push(`${where} needs an id of letters, digits, dot, dash or underscore`); return null }
  const piece = { id, label: typeof raw.label === 'string' ? raw.label.trim().slice(0, 120) : '', deps: raw.deps ?? [], p50_min: raw.p50_min, p90_min: raw.p90_min, runs_on: typeof raw.runs_on === 'string' ? raw.runs_on.trim().slice(0, 60) : '', scenario }
  if (!piece.label) errors.push(`piece ${id} needs a label`)
  if (!Array.isArray(piece.deps) || piece.deps.some(dep => typeof dep !== 'string')) { errors.push(`piece ${id}: deps must be a list of piece ids`); piece.deps = [] }
  if (!minutes(piece.p50_min) || !minutes(piece.p90_min)) errors.push(`piece ${id}: p50_min and p90_min must be positive minutes`)
  else if (piece.p50_min > piece.p90_min) errors.push(`piece ${id}: p50_min is above p90_min`)
  if (raw.runs_on !== undefined && typeof raw.runs_on !== 'string') errors.push(`piece ${id}: runs_on must be text`)
  return piece
}

// Returns { pieces, errors }. pieces are in a dependency order (every dep before its dependents) when errors is empty.
export function parseBuild(source) {
  const errors = []
  let body
  try { body = JSON.parse(source) } catch (error) { return { pieces: [], errors: [`not valid JSON (${error.message})`] } }
  if (!body || typeof body !== 'object' || !Array.isArray(body.pieces) || !body.pieces.length) return { pieces: [], errors: ['needs a non-empty "pieces" list'] }
  const pieces = body.pieces.map((raw, index) => readPiece(raw, `piece ${index + 1}`, errors)).filter(Boolean)
  if (body.scenario !== undefined) {
    const scenario = readPiece(body.scenario, 'scenario', errors, true)
    if (scenario) {
      if (body.scenario.deps === undefined) {
        const waited = new Set(pieces.flatMap(piece => piece.deps))
        scenario.deps = pieces.filter(piece => !waited.has(piece.id)).map(piece => piece.id)
      }
      pieces.push(scenario)
    }
  }
  const byId = new Map()
  for (const piece of pieces) {
    if (byId.has(piece.id)) errors.push(`piece id ${piece.id} is used twice`)
    byId.set(piece.id, piece)
  }
  for (const piece of pieces) for (const dep of piece.deps) {
    if (!byId.has(dep)) errors.push(`piece ${piece.id} depends on unknown piece ${dep}`)
    else if (dep === piece.id) errors.push(`piece ${piece.id} depends on itself`)
  }
  if (errors.length) return { pieces, errors }
  // Depth-first topological sort; a grey node seen again closes a cycle.
  const state = new Map(), order = []
  const visit = (piece, trail) => {
    if (state.get(piece.id) === 2) return true
    if (state.get(piece.id) === 1) { errors.push(`dependency cycle ${[...trail.slice(trail.indexOf(piece.id)), piece.id].join(' → ')}`); return false }
    state.set(piece.id, 1)
    for (const dep of piece.deps) if (!visit(byId.get(dep), [...trail, piece.id])) return false
    state.set(piece.id, 2); order.push(piece)
    return true
  }
  for (const piece of pieces) if (!visit(piece, [])) break
  return { pieces: errors.length ? pieces : order, errors }
}

// Longest path through the graph by one weight. Returns { total, path } with path as piece ids, start to end.
function longest(order, weight) {
  const best = new Map()
  for (const piece of order) {
    const from = piece.deps.map(dep => best.get(dep)).reduce((a, b) => (b && (!a || b.total > a.total) ? b : a), null)
    best.set(piece.id, { total: (from?.total ?? 0) + weight(piece), path: [...(from?.path ?? []), piece.id] })
  }
  return [...best.values()].reduce((a, b) => (b.total > a.total ? b : a), { total: 0, path: [] })
}

// Latest estimate and actual per piece from ESTIMATES.jsonl rows of one scope. A piece merged in several
// sub-PRs is done when its last one merges, so its actual is the largest actual_min.
export function actualsByPiece(rows) {
  const out = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.piece !== 'string') continue
    const entry = out[row.piece] ??= {}
    if (minutes(row.p50_min) && minutes(row.p90_min)) { entry.p50_min = row.p50_min; entry.p90_min = row.p90_min }
    if (minutes(row.actual_min)) entry.actual_min = Math.max(entry.actual_min ?? 0, row.actual_min)
  }
  return out
}

// Columns by depth, the critical path by p50, totals as the longest path by p50 and by p90, and actuals.
export function planBuild(pieces, actuals = {}) {
  const depth = new Map()
  for (const piece of pieces) depth.set(piece.id, piece.deps.length ? Math.max(...piece.deps.map(dep => depth.get(dep))) + 1 : 0)
  // The scenario reads as the finish line: it sits in the last column when nothing waits on it.
  const last = Math.max(...depth.values())
  for (const piece of pieces) if (piece.scenario && !pieces.some(other => other.deps.includes(piece.id))) depth.set(piece.id, last)
  const columns = []
  for (const piece of pieces) (columns[depth.get(piece.id)] ??= []).push(piece)
  const p50 = longest(pieces, piece => piece.p50_min), p90 = longest(pieces, piece => piece.p90_min)
  const actual = id => actuals[id]?.actual_min
  const known = pieces.filter(piece => actual(piece.id) !== undefined)
  const total = { p50_min: p50.total, p90_min: p90.total, actual_min: undefined, known: known.length, count: pieces.length }
  if (known.length === pieces.length) total.actual_min = longest(pieces, piece => actual(piece.id)).total
  const over = {}
  for (const piece of known) if (actual(piece.id) > piece.p90_min) over[piece.id] = actual(piece.id) - piece.p90_min
  return { columns, critical: p50.path, total, over, actuals: Object.fromEntries(known.map(piece => [piece.id, actual(piece.id)])) }
}

// Every ```build fence body in a section's markdown, using the page's line rules (the section end closes a fence).
export function buildFences(markdownText) {
  const out = []
  let fence = null
  for (const line of [...String(markdownText ?? '').split('\n'), '```']) {
    if (fence) {
      if (!/^```/.test(line)) { fence.lines.push(line); continue }
      if (fence.build) out.push(fence.lines.join('\n'))
      fence = null
    } else if (/^```/.test(line)) fence = { build: /^```build\s*$/.test(line), lines: [] }
  }
  return out
}

// Write-time check: the first problem in any build fence of the doc, or ''.
export function buildDocError(sections) {
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const source of buildFences(section?.body_md)) {
      const { errors } = parseBuild(source)
      if (errors.length) return `build fence in section ${section.id}: ${errors[0]}`
    }
  }
  return ''
}

export const formatMinutes = (value) => {
  if (value < 120) return `${Math.round(value)} min`
  const hours = Math.round(value / 6) / 10
  return `${String(hours).replace(/\.0$/, '')} h`
}
export const formatRange = (low, high) => {
  if (high < 120) return `${Math.round(low)}–${Math.round(high)} min`
  const h = value => String(Math.round(value / 6) / 10).replace(/\.0$/, '')
  return low < 120 ? `${Math.round(low)} min–${h(high)} h` : `${h(low)}–${h(high)} h`
}
