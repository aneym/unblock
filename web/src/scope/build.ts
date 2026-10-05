// The ```build fence on the page: a left-to-right dependency graph of the scope's pieces, the longest path
// drawn in accent, and the "Expected · Actual" line under the title. Estimates and actuals come from the
// daemon (ESTIMATES.jsonl rows of this scope); the fence itself carries the plan.
import { actualsByPiece, buildFences, formatMinutes, formatRange, parseBuild, planBuild } from '../../../src/scope-build.js'
import type { BuildActual, BuildPiece } from '../../../src/scope-build.js'

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
let actuals: Record<string, BuildActual> = {}
let actualsKey = '{}'

// Returns true when the actuals changed, so the page knows to redraw build sections.
export function setBuildEstimates(rows: unknown): boolean {
  const next = actualsByPiece(rows), key = JSON.stringify(next)
  if (key === actualsKey) return false
  actuals = next; actualsKey = key
  return true
}
export const buildSignature = (body: string) => /^```build\s*$/m.test(body) ? actualsKey : ''

const overText = (minutes: number) => `${formatMinutes(minutes)} over its p90`

function node(piece: BuildPiece, critical: boolean, actual: number | undefined, over: number | undefined) {
  const classes = ['build-node', critical && 'crit', piece.scenario && 'scenario', actual !== undefined && 'done', over !== undefined && 'over'].filter(Boolean).join(' ')
  const meta = [piece.scenario ? 'Scenario' : piece.id, piece.runs_on].filter(Boolean).map(esc).join('<span class="build-dot" aria-hidden="true"> · </span>')
  const took = actual === undefined ? '' : `<span class="build-took">Took ${formatMinutes(actual)}</span>${over !== undefined ? `<span class="build-over">${overText(over)}</span>` : ''}`
  return `<li class="${classes}" data-piece="${esc(piece.id)}" data-deps="${esc(piece.deps.join(' '))}">`
    + `<span class="build-label">${esc(piece.label)}</span>`
    + `<span class="build-meta">${meta}</span>`
    + `<span class="build-time"><span class="build-est">${formatRange(piece.p50_min, piece.p90_min)}</span>${took}</span>`
    + (piece.deps.length ? `<span class="build-after">After ${piece.deps.map(esc).join(', ')}</span>` : '')
    + '</li>'
}

export function buildBlock(source: string): string {
  const { pieces, errors } = parseBuild(source)
  if (errors.length) return `<figure class="fig build" data-cm-skip><p class="build-error">Build plan unavailable: ${esc(errors[0])}</p></figure>`
  const plan = planBuild(pieces, actuals), critical = new Set(plan.critical)
  const columns = plan.columns.map((column, index) => {
    const head = column.every(piece => piece.scenario) ? 'Scenario' : `Wave ${index + 1}`
    return `<div class="build-col"><p class="build-col-head">${head}</p><ol>${column.map(piece => node(piece, critical.has(piece.id), plan.actuals[piece.id], plan.over[piece.id])).join('')}</ol></div>`
  }).join('')
  const names = new Map(pieces.map(piece => [piece.id, piece.scenario ? 'scenario' : piece.id]))
  const path = plan.critical.map(id => esc(names.get(id))).join(' → ')
  return `<figure class="fig build" data-cm-skip><div class="build-scroll"><div class="build-graph" data-critical="${esc(plan.critical.join(' '))}" style="--build-cols:${plan.columns.length}"><svg class="build-edges" aria-hidden="true"></svg>${columns}</div></div>`
    + `<figcaption><span class="build-total">${formatRange(plan.total.p50_min, plan.total.p90_min)}</span> along the longest path, ${path}. Each piece shows p50–p90 from dispatch to merged.</figcaption></figure>`
}

// The line under the title for a doc that has a build plan; '' when it has none.
export function buildStrip(sections: { id: string; body_md: string }[]): string {
  for (const section of sections) {
    for (const source of buildFences(section.body_md)) {
      const { pieces, errors } = parseBuild(source)
      if (errors.length) continue
      const { total, over } = planBuild(pieces, actuals)
      const late = Object.keys(over).length
      let actual: string
      if (total.actual_min !== undefined) {
        const past = total.actual_min - total.p90_min
        actual = `<strong>${formatMinutes(total.actual_min)}</strong>${past > 0 ? `<span class="build-over">, ${formatMinutes(past)} over the p90</span>` : ''}`
      } else actual = `<span class="build-pending">${total.known ? `${total.known} of ${total.count} pieces in` : 'not in yet'}</span>`
      const lateText = late && total.actual_min === undefined ? `<span class="build-late"><span class="build-sep" aria-hidden="true">·</span><span class="build-over">${late === 1 ? '1 piece' : `${late} pieces`} over p90</span></span>` : ''
      return `<p class="build-strip" data-cm-skip><a href="#${esc(section.id)}"><span class="build-k">Expected</span> <strong>${formatRange(total.p50_min, total.p90_min)}</strong><span class="build-sep" aria-hidden="true">·</span><span class="build-k">Actual</span> ${actual}${lateText}</a></p>`
    }
  }
  return ''
}

// Edges are drawn after layout, from each dependency's right edge to the piece's left edge.
const watched = new WeakSet<HTMLElement>()
const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => entries.forEach(entry => drawEdges(entry.target as HTMLElement)))
function drawEdges(graph: HTMLElement) {
  const svg = graph.querySelector<SVGSVGElement>(':scope > .build-edges')
  if (!svg) return
  const box = graph.getBoundingClientRect()
  svg.setAttribute('width', String(graph.scrollWidth)); svg.setAttribute('height', String(graph.scrollHeight))
  const nodes = new Map([...graph.querySelectorAll<HTMLElement>('.build-node')].map(n => [n.dataset.piece!, n]))
  const critical = (graph.dataset.critical || '').split(' ')
  const onPath = (from: string, to: string) => { const at = critical.indexOf(from); return at >= 0 && critical[at + 1] === to }
  // A stacked (phone) layout has no left-to-right edges; each piece says "After ..." instead.
  if (getComputedStyle(svg).display === 'none') return
  const paths: string[] = []
  for (const [id, target] of nodes) {
    for (const dep of target.dataset.deps ? target.dataset.deps.split(' ') : []) {
      const source = nodes.get(dep); if (!source) continue
      const a = source.getBoundingClientRect(), b = target.getBoundingClientRect()
      const x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top, x2 = b.left - box.left, y2 = b.top + b.height / 2 - box.top
      const bend = Math.max(16, (x2 - x1) / 2)
      const crit = onPath(dep, id)
      paths.push(`<path class="${crit ? 'crit' : ''}" d="M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + bend).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - bend).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`)
    }
  }
  // Critical edges last, so they draw over the hairlines they cross.
  paths.sort((a, b) => Number(a.includes('"crit"')) - Number(b.includes('"crit"')))
  svg.innerHTML = paths.join('')
}
export function layoutBuildGraphs(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('.build-graph').forEach(graph => {
    drawEdges(graph)
    if (!watched.has(graph)) { watched.add(graph); resize?.observe(graph) }
  })
}
