import { isAbsolute } from 'node:path'
import { KIND_IDS } from './doc-kinds.js'
import { locateAnchor, makeAnchor, normalizeAnchor, plainText, hasEmbedFence } from './scope-anchor.js'

export const SECTION_ID = /^[a-z][a-z0-9-]{0,39}$/
export const THREAD_ID = /^T\d{1,4}$/
export const KPI_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const KPI_SOURCE = /^[a-z][a-z-]{0,31}(:[A-Za-z0-9_.:\/-]{1,64})?$/
const KPI_KEYS = ['id', 'name', 'source', 'target', 'direction', 'window_days']
export const APPS = ['recruiter', 'closer', 'rails-admin']
export function appOf(scope) {
  if (APPS.includes(scope.app)) return scope.app
  if (scope.slug?.startsWith('recruiter')) return 'recruiter'
  if (scope.slug?.startsWith('closer')) return 'closer'
  return 'rails-admin'
}
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const slugify = (text) => {
  let id = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
  if (!/^[a-z]/.test(id)) id = `s-${id}`
  return id.slice(0, 40)
}
function uniqueId(id, used) {
  const base = id
  let n = 2
  while (used.has(id)) { const suffix = `-${n++}`; id = base.slice(0, 40 - suffix.length) + suffix }
  used.add(id)
  return id
}

export function sectionPlain(section) {
  const body = section.body_md.replace(/^\s*```(?:svg|mermaid)[^\n]*\n[\s\S]*?^\s*```\s*$/gm, '')
    .replace(/^\s*!\[[^\]\n]*\]\([^\n]*\)\s*$/gm, '')
    .replace(/^\s*Figure:\s*(.*)$/gm, '$1').replace(/^\s*>\s*\[!(?:NOTE|WARNING|TIP)\]\s*$/gm, '')
  return `${section.heading}\n${plainText(body)}`
}
export function anchorInSection(section, quote) {
  const text = sectionPlain(section)
  const plain = plainText(quote)
  const found = locateAnchor(text, { quote, prefix: '', suffix: '' }) ?? (plain !== quote ? locateAnchor(text, { quote: plain, prefix: '', suffix: '' }) : null)
  return found ? makeAnchor(section.id, text, found.start, found.end) : null
}
export function headingOf(scope, id) { return scope.doc.sections.find((s) => s.id === id)?.heading ?? id }
export function nextThreadId(scope) { return `T${Math.max(0, ...scope.threads.map((t) => Number(t.id.slice(1)))) + 1}` }
export function orderThreads(scope) {
  const position = (thread) => {
    if (thread.anchor.general) return [-1, -1]
    const index = scope.doc.sections.findIndex((s) => s.id === thread.anchor.section)
    if (thread.anchor.embed) return index >= 0 && hasEmbedFence(scope.doc.sections[index], thread.anchor.embed.src) ? [index, scope.doc.sections[index].body_md.indexOf(thread.anchor.embed.src)] : [Infinity, Infinity]
    const found = index < 0 ? null : locateAnchor(sectionPlain(scope.doc.sections[index]), thread.anchor)
    return found ? [index, found.start] : [Infinity, Infinity]
  }
  return [...scope.threads].sort((a, b) => {
    const status = Number(a.status !== 'open') - Number(b.status !== 'open')
    const x = position(a), y = position(b)
    return status || (x[0] !== y[0] ? x[0] - y[0] : 0) || (x[1] !== y[1] ? x[1] - y[1] : 0) || Number(a.id.slice(1)) - Number(b.id.slice(1))
  })
}

export function docToMarkdown(doc) {
  return doc.sections.map((section, index) => `${index === 0 ? `# ${section.heading}` : `## ${section.heading} {#${section.id}}`}${section.body_md ? `\n\n${section.body_md}` : ''}`).join('\n\n')
}

export function docFromMarkdown(md) {
  const sections = [], used = new Set(['title'])
  let fenced = false
  for (const line of String(md).split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const title = !fenced && line.match(/^# (.+)$/)
    const heading = !fenced && line.match(/^## (.+?)(?:\s+\{#([^}]+)\})?\s*$/)
    if (!sections.length) {
      if (heading) throw new Error('the doc needs a "# Title" first line')
      if (title) sections.push({ id: 'title', heading: title[1].trim(), body_md: '' })
      continue
    }
    if (heading) sections.push({ id: uniqueId(heading[2] ?? slugify(heading[1]), used), heading: heading[1].trim(), body_md: '' })
    else sections.at(-1).body_md += `${line}\n`
  }
  if (!sections.length) throw new Error('the doc needs a "# Title" first line')
  for (const section of sections) section.body_md = section.body_md.trim()
  return { sections }
}

export function migrateV1(input, now = '1970-01-01T00:00:00.000Z') {
  const v1 = object(input) ? input : {}
  const at = v1.updated_at ?? now
  const title = String(v1.title ?? '')
  const sections = [{ id: 'title', heading: title, body_md: v1.lede ?? '' },
    { id: 'ask', heading: 'What you asked for', body_md: (v1.ask ?? []).map((ask) => `> "${ask.quote}"\n> — ${ask.source ?? ''}, ${ask.date ?? ''}`).join('\n\n') }]
  const used = new Set(['title', 'ask', 'plan', 'unverified'])
  let current = null, fenced = false
  for (const line of String(v1.plan_md ?? '').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced
    const heading = !fenced && (line.match(/^#{1,3}\s+(.+)$/) || line.match(/^\*\*(.+)\*\*\s*$/))
    if (heading) { current = { id: uniqueId(slugify(heading[1]), used), heading: heading[1].trim(), body_md: '' }; sections.push(current) }
    else {
      if (!current && !line.trim()) continue
      if (!current) { current = { id: 'plan', heading: 'The plan', body_md: '' }; sections.push(current) }
      current.body_md += `${line}\n`
    }
  }
  for (const section of sections) section.body_md = section.body_md.trim()
  if (v1.unverified) sections.push({ id: 'unverified', heading: 'Not verified yet', body_md: Array.isArray(v1.unverified) ? v1.unverified.join('\n') : String(v1.unverified) })
  const scope = { version: 2, slug: v1.slug ?? '', title, pane: v1.pane ?? '', revision: 1, updated_at: at, doc: { sections }, threads: [] }
  const titleAnchor = () => anchorInSection(sections[0], title)
  const resolution = (decision, words, by, time) => ({ decision, alex_words: words, by, at: time, confirmed_at: time, revision: 1 })
  for (const q of v1.questions ?? []) {
    let anchor = null
    for (const section of sections) {
      for (const mention of [q.id, q.section].filter(Boolean)) {
        const escaped = String(mention).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const match = sectionPlain(section).match(new RegExp(`\\b${escaped}\\b`))
        if (match) { anchor = anchorInSection(section, match[0]); break }
      }
      if (anchor) break
    }
    const resolved = ['answered', 'decided', 'dropped'].includes(q.status)
    const answer = q.answer ?? ''
    scope.threads.push({ id: nextThreadId(scope), anchor: anchor ?? titleAnchor(), author: 'agent', kind: 'question', status: resolved ? 'resolved' : 'open',
      ...(q.recommendation ? { recommendation: q.recommendation } : {}), ...(q.why ? { why: q.why } : {}),
      messages: [{ from: 'agent', text: q.text ?? '', at }], created_at: at, legacy_id: q.id,
      ...(resolved ? { resolution: resolution(q.status === 'dropped' ? `Dropped${answer ? `: ${answer}` : ''}` : answer, q.status === 'dropped' ? q.answer ?? null : answer, 'alex', q.answered_at ?? at) } : {}) })
  }
  for (const d of v1.decisions ?? []) scope.threads.push({ id: nextThreadId(scope), anchor: titleAnchor(), author: 'agent', kind: 'question', status: 'resolved', messages: [{ from: 'agent', text: d.decision ?? d.text ?? '', at }], created_at: at, legacy_id: d.id, resolution: resolution(d.decision ?? d.text ?? '', d.decision ?? d.text ?? '', 'alex', d.at ?? at) })
  if (v1.thread?.length) {
    const messages = v1.thread.map((m) => ({ from: m.from, text: m.text, at: m.at ?? at, ...(m.via === 'voice' ? { via: 'voice' } : {}) }))
    const resolved = messages.at(-1).from !== 'alex'
    scope.threads.push({ id: nextThreadId(scope), anchor: titleAnchor(), author: messages[0].from, kind: 'comment', status: resolved ? 'resolved' : 'open', messages, created_at: messages[0].at, legacy_id: 'thread', ...(resolved ? { resolution: resolution('Answered in thread', null, 'agent', messages.at(-1).at) } : {}) })
  }
  return scope
}

export function normalizeKpis(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 3) return { error: 'kpis: 1 to 3 KPIs' }
  const kpis = []
  const ids = new Set()
  for (const item of list) {
    if (!object(item)) return { error: 'kpis: invalid KPI' }
    const id = typeof item.id === 'string' && KPI_ID.test(item.id) ? item.id : ''
    if (!id) return { error: 'kpi: invalid id' }
    if (ids.has(id)) return { error: `kpi ${id}: duplicate id` }
    ids.add(id)
    if (Object.keys(item).some((key) => !KPI_KEYS.includes(key))) return { error: `kpi ${id}: unexpected field` }
    if (typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 80) return { error: `kpi ${id}: name must be a non-empty string of at most 80 characters` }
    if (typeof item.source !== 'string' || !KPI_SOURCE.test(item.source)) return { error: `kpi ${id}: invalid source` }
    if (typeof item.target !== 'number' || !Number.isFinite(item.target)) return { error: `kpi ${id}: target must be a number` }
    if (item.direction !== 'at_least' && item.direction !== 'at_most') return { error: `kpi ${id}: direction must be at_least or at_most` }
    const window_days = item.window_days === undefined ? 14 : item.window_days
    if (!Number.isInteger(window_days) || window_days < 1 || window_days > 365) return { error: `kpi ${id}: window_days must be an integer from 1 to 365` }
    kpis.push({ id, name: item.name, source: item.source, target: item.target, direction: item.direction, window_days })
  }
  return { kpis }
}

export function validateScope(scope) {
  const problems = []
  const check = (ok, message) => { if (!ok) problems.push(message) }
  if (!object(scope)) return ['invalid scope']
  check(scope.version === 2, 'invalid version')
  if (scope.app !== undefined) check(APPS.includes(scope.app), 'invalid app')
  check(typeof scope.slug === 'string' && SLUG.test(scope.slug), 'invalid slug')
  check(typeof scope.title === 'string', 'invalid title')
  check(typeof scope.pane === 'string', 'invalid pane')
  check(Number.isInteger(scope.revision) && scope.revision >= 1, 'invalid revision')
  const sections = scope.doc?.sections
  check(Array.isArray(sections) && sections.length > 0, 'invalid sections')
  if (Array.isArray(sections)) {
    check(sections[0]?.id === 'title', 'first section must be title')
    const ids = new Set()
    for (const section of sections) {
      if (!object(section)) { problems.push('invalid section'); continue }
      check(typeof section.id === 'string' && SECTION_ID.test(section.id) && !ids.has(section.id), 'invalid or duplicate section id')
      ids.add(section.id)
      check(typeof section.heading === 'string' && section.heading.trim().length > 0 && section.heading.length <= 200, 'invalid section heading')
      check(typeof section.body_md === 'string' && section.body_md.length <= 200000, 'invalid section body')
    }
  }
  if (scope.doc?.assets !== undefined) {
    check(object(scope.doc.assets), 'invalid assets')
    if (object(scope.doc.assets)) for (const [id, asset] of Object.entries(scope.doc.assets)) {
      const assetId = (value) => typeof value === 'string' && /^[0-9a-f]{16}\.(png|jpg|webp|gif|svg|html|mock|mp4|webm)$/.test(value)
      const dimension = (value) => value === null || (Number.isFinite(value) && value > 0)
      check(assetId(id) && object(asset) && ['image', 'mock', 'html', 'video'].includes(asset.type) && dimension(asset.width) && dimension(asset.height)
        && (asset.type !== 'mock' || (assetId(asset.light) && (asset.dark === null || assetId(asset.dark)) && assetId(asset.html) && ['desktop', 'phone'].includes(asset.frame))), 'invalid asset metadata')
    }
  }
  if (scope.kind !== undefined && !KIND_IDS.includes(scope.kind)) throw new Error('invalid kind')
  if (scope.answerer !== undefined) check(scope.answerer === 'on' || scope.answerer === 'off', 'invalid answerer')
  if (scope.sources !== undefined) check(Array.isArray(scope.sources) && scope.sources.length >= 1 && scope.sources.length <= 8 && scope.sources.every((dir) => typeof dir === 'string' && isAbsolute(dir)), 'invalid sources')
  if (scope.approve_default !== undefined) check(['try', 'ship'].includes(scope.approve_default), 'invalid approve_default')
  if (scope.ships !== undefined) {
    check(Array.isArray(scope.ships), 'invalid ships')
    for (const ship of Array.isArray(scope.ships) ? scope.ships : []) {
      check(object(ship) && Object.keys(ship).every((key) => ['pr', 'head', 'build', 'by', 'who', 'at', 'at_et', 'client_id'].includes(key))
        && Number.isSafeInteger(ship.pr) && ship.pr > 0 && Number.isSafeInteger(ship.build) && ship.build > 0
        && typeof ship.head === 'string' && /^[0-9a-f]{40}$/.test(ship.head) && ship.by === 'alex'
        && typeof ship.who === 'string' && typeof ship.at === 'string' && Number.isFinite(Date.parse(ship.at)) && typeof ship.at_et === 'string'
        && (ship.client_id === undefined || (typeof ship.client_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ship.client_id))), 'invalid ship')
    }
  }
  if (scope.approval !== undefined) {
    const a = scope.approval
    check(object(a) && ['approve', 'approve_to_try', 'approve_with_changes', 'not_yet'].includes(a.mode) && a.by === 'alex'
      && typeof a.who === 'string' && typeof a.at === 'string' && Number.isFinite(Date.parse(a.at)) && typeof a.at_et === 'string'
      && Number.isInteger(a.revision) && a.revision >= 1 && typeof a.comment === 'string' && a.comment.length <= 4000
      && !/[\x00-\x09\x0b-\x1f\x7f]/.test(a.comment) && (['approve', 'approve_to_try'].includes(a.mode) || !!a.comment.trim())
      && (a.via === undefined || ['voice', 'admin', 'pm-relay'].includes(a.via))
      && (a.quote === undefined || (typeof a.quote === 'string' && a.quote.length <= 4000))
      && (a.via !== 'pm-relay' || (typeof a.quote === 'string' && !!a.quote.trim()))
      && (a.open === undefined || (Number.isInteger(a.open) && a.open >= 0))
      && (a.recorded_at === undefined || (typeof a.recorded_at === 'string' && Number.isFinite(Date.parse(a.recorded_at))))
      && (a.client_id === undefined || (typeof a.client_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(a.client_id))), 'invalid approval')
  }
  if (scope.kpis !== undefined) {
    const normalized = normalizeKpis(scope.kpis)
    const filled = Array.isArray(scope.kpis) && scope.kpis.every((kpi) => object(kpi) && kpi.window_days !== undefined)
    check(!normalized.error && filled, 'invalid kpis')
  }
  check(Array.isArray(scope.threads), 'invalid threads')
  const validImages = images => images === undefined || (Array.isArray(images) && images.length >= 1 && images.length <= 6 && images.every(image => object(image) && typeof image.id === 'string' && /^[0-9a-f]{16}\.(png|jpg|webp|gif)$/.test(image.id) && Number.isFinite(image.width) && image.width > 0 && Number.isFinite(image.height) && image.height > 0))
  const ids = new Set()
  for (const thread of Array.isArray(scope.threads) ? scope.threads : []) {
    if (!object(thread)) { problems.push('invalid thread'); continue }
    check(typeof thread.id === 'string' && THREAD_ID.test(thread.id) && !ids.has(thread.id), 'invalid or duplicate thread id')
    ids.add(thread.id)
    check(typeof thread.anchor?.section === 'string' && SECTION_ID.test(thread.anchor.section) && !!normalizeAnchor(thread.anchor), 'invalid thread anchor')
    check(['question', 'comment'].includes(thread.kind), 'invalid thread kind')
    check(['open', 'resolved', 'parked'].includes(thread.status), 'invalid thread status')
    check(['alex', 'agent'].includes(thread.author), 'invalid thread author')
    if (thread.reaction !== undefined) check(object(thread.reaction) && thread.reaction.emoji === '👀' && thread.reaction.by === 'agent' && typeof thread.reaction.at === 'string', 'invalid reaction')
    if (thread.options !== undefined) check(thread.kind === 'question' && Array.isArray(thread.options) && thread.options.length >= 2 && thread.options.length <= 5 && thread.options.every((option) => typeof option === 'string' && option.length >= 1 && option.length <= 200) && typeof thread.recommendation === 'string' && thread.options[0] === thread.recommendation, 'invalid thread options')
    check(Array.isArray(thread.messages) && thread.messages.length > 0, 'invalid thread messages')
    check(thread.parked_client_id === undefined || (typeof thread.parked_client_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(thread.parked_client_id)), 'invalid parked_client_id')
    for (const key of ['rejected_at', 'parked_at']) check(thread[key] == null || typeof thread[key] === 'string', `invalid ${key}`)
    for (const message of Array.isArray(thread.messages) ? thread.messages : []) check(object(message) && ['alex', 'agent'].includes(message.from) && typeof message.text === 'string' && (!!message.text.trim() || message.kind === 'reject' || message.images?.length > 0) && validImages(message.images) && typeof message.at === 'string' && (message.via === undefined || ['voice', 'admin'].includes(message.via)) && (message.client_id === undefined || (typeof message.client_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(message.client_id))) && (message.kind === undefined || ['reject', 'option'].includes(message.kind)) && (message.recommendation === undefined || typeof message.recommendation === 'string'), 'invalid thread message')
    if (thread.resolution !== undefined) check(object(thread.resolution) && validImages(thread.resolution.images) && (thread.resolution.client_id === undefined || (typeof thread.resolution.client_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(thread.resolution.client_id))) && typeof thread.resolution.decision === 'string' && ['alex', 'agent'].includes(thread.resolution.by) && (thread.resolution.alex_words === null || typeof thread.resolution.alex_words === 'string') && (thread.resolution.how === undefined || ['take', 'own', 'resolve', 'approve'].includes(thread.resolution.how)) && typeof thread.resolution.at === 'string' && (thread.resolution.confirmed_at === null || typeof thread.resolution.confirmed_at === 'string') && (thread.resolution.revision === null || (Number.isInteger(thread.resolution.revision) && thread.resolution.revision >= 1)), 'invalid resolution')
  }
  return problems
}
