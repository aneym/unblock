#!/usr/bin/env node
import readline from 'node:readline'
import { api } from './paths.js'
import { activeProfile } from './herdr.js'
import { applyKey, initialValues, missingFor, redactValue, sortAsks } from './queue-model.js'

const stdin = process.stdin
const stdout = process.stdout
const interactive = Boolean(stdin.isTTY)
const color = !process.env.NO_COLOR && stdout.isTTY
const accent = color ? '\x1b[38;5;202m' : ''
const dim = color ? '\x1b[2m' : ''
const reset = color ? '\x1b[0m' : ''

let restored = false
function restore() {
  if (restored) return
  restored = true
  if (interactive && stdin.isRaw) stdin.setRawMode(false)
  if (interactive) stdout.write('\x1b[?25h\x1b[?1049l')
}
process.once('exit', restore)
process.once('SIGINT', () => { restore(); process.exit(0) })
process.once('SIGTERM', () => { restore(); process.exit(0) })
process.once('uncaughtException', (error) => {
  restore()
  console.error(error?.stack || error)
  process.exit(1)
})

function age(createdAt) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim()

/** Visible columns in a string, ignoring colour codes. */
const VISIBLE_RE = /\x1b\[[0-9;]*m/g
const wide = (text) => [...String(text).replace(VISIBLE_RE, '')].length
const terminalWidth = () => Math.max(24, stdout.columns || Number(process.env.COLUMNS) || 120)

/**
 * Word-wrap plain text to `width` columns. A word longer than a row (a URL, a
 * continuous identifier) is split rather than pushed out whole, so nothing is
 * ever unreachable: there is no horizontal scroll in an alt-screen terminal.
 */
function wrap(text, width) {
  const limit = Math.max(1, width)
  const rows = []
  let row = ''
  const place = (piece) => {
    if (row && wide(row) + 1 + wide(piece) <= limit) { row = `${row} ${piece}`; return }
    if (row) rows.push(row)
    row = piece
  }
  for (const word of oneLine(text).split(' ').filter(Boolean)) {
    let rest = word
    while (wide(rest) > limit) {
      if (row) { rows.push(row); row = '' }
      const chars = [...rest]
      rows.push(chars.slice(0, limit).join(''))
      rest = chars.slice(limit).join('')
    }
    if (rest) place(rest)
  }
  if (row) rows.push(row)
  return rows.length ? rows : ['']
}
function meta(ask) {
  const origin = ask.origin || {}
  return [origin.agent || 'agent', origin.workspace_name || 'workspace', origin.pane_id ? `pane ${origin.pane_id}` : 'pane ?', age(ask.created_at)].join(' · ')
}

function plainListing(data) {
  const asks = sortAsks((data.asks || []).filter((ask) => ask.status === 'open'))
  const gating = asks.filter((ask) => ask.gating).length
  const scope = data.profile || '*'
  const lines = [`UNBLOCK   ${asks.length} asks · ${gating} gating   profile ${scope}`]
  if (asks.length === 0) lines.push('', 'Queue is clear.')
  for (const ask of asks) {
    lines.push('', `${ask.gating ? '! ' : ''}${oneLine(ask.title)}`)
    lines.push(`  ${meta(ask)}`)
    lines.push(`  ${oneLine(ask.why)}`)
    const unanswered = (ask.fields || []).filter((field) => !(field.name in (ask.answers || {})))
    if (unanswered.length) lines.push(`  needs: ${unanswered.map((field) => field.label || field.name).join(', ')}`)
  }
  return lines.join('\n') + '\n'
}

const activeScope = await activeProfile()
let profile = activeScope || '*'
let data = { asks: [], hidden: 0, profile }
let selected = 0
let expanded = null
let scroll = 0
/** Set by arrows: hold the window where the human put it, until they move on. */
let manualScroll = null
let fieldIndex = 0
let states = new Map()
let footer = ''
let draftTimer
let isEditing = false
let busy = false

const asks = () => sortAsks((data.asks || []).filter((ask) => ask.status === 'open'))
const selectedAsk = () => asks()[selected]

function valuesFor(ask) {
  return Object.fromEntries(
    (ask.fields || []).map((field) => [field.name, states.get(`${ask.ticket}:${field.name}`)?.value])
      .filter(([, value]) => value !== undefined),
  )
}

function initialize() {
  for (const ask of asks()) {
    const values = initialValues(ask)
    for (const field of ask.fields || []) {
      const key = `${ask.ticket}:${field.name}`
      if (!states.has(key)) states.set(key, { value: values[field.name] })
    }
  }
}

async function refresh({ renderAfter = true } = {}) {
  if (isEditing || busy) return
  busy = true
  try {
    data = await api(`/api/asks?profile=${encodeURIComponent(profile)}`)
    selected = Math.min(selected, Math.max(0, asks().length - 1))
    initialize()
    footer = ''
  } catch (error) {
    footer = error.message
  } finally {
    busy = false
    if (renderAfter && interactive) render()
  }
}

if (!interactive) {
  data = await api(`/api/asks?profile=${encodeURIComponent(profile)}`)
  data.profile = profile
  stdout.write(plainListing(data))
  process.exit(0)
}

/** True when the open card needs more rows than the window can show. */
function overflows(ask) {
  if (!ask) return false
  const rows = Math.max(10, stdout.rows || Number(process.env.LINES) || 40)
  const width = terminalWidth()
  let height = 2 + wrap(ask.title, width - 3).length + wrap(ask.why, width - 3).length
  for (const step of ask.steps || []) height += wrap(step, width - 5).length
  for (const link of ask.links || []) {
    height += wrap(link.label || link.url, width - 5).length
    if (link.label && link.url) height += Math.ceil(oneLine(link.url).length / Math.max(16, width - 5))
  }
  for (const field of unansweredFields(ask)) {
    const shown = redactValue(field, states.get(`${ask.ticket}:${field.name}`)?.value)
    height += wrap(`${field.label || field.name}: ${shown}`, width - 4).length + 1
  }
  return height > Math.max(1, rows - 3)
}

function unansweredFields(ask) {
  return (ask.fields || []).filter((field) => !(field.name in (ask.answers || {})))
}

function render() {
  const queue = asks()
  const gating = queue.filter((ask) => ask.gating).length
  const lines = [`UNBLOCK   ${queue.length} asks · ${gating} gating   profile ${profile}`, '']
  queue.forEach((ask, index) => {
    const focused = index === selected
    const marker = focused ? `${accent}>${reset}` : ' '
    const gate = ask.gating ? `${accent}!${reset}` : ' '
    lines.push(`${marker}${gate} ${dim}${meta(ask)}${reset}`)
    // An open card is read, not clipped. A folded row stays one line: it is the
    // index, and a long preview would push the rest of the queue off screen.
    const openCard = expanded === ask.ticket
    const body = (text, indent, tone = '') => {
      if (!openCard) return lines.push(`${indent}${tone}${oneLine(text)}${reset}`)
      for (const row of wrap(text, terminalWidth() - wide(indent))) lines.push(`${indent}${tone}${row}${reset}`)
    }
    body(ask.title, '   ', focused ? accent : '')
    body(ask.why, '   ')
    if (!openCard) return lines.push('')

    for (const step of ask.steps || []) {
      // A continuation row hangs under the text, not under the bullet.
      wrap(step, terminalWidth() - 5).forEach((row, n) => lines.push(n === 0 ? `   - ${row}` : `     ${row}`))
    }
    for (const link of ask.links || []) {
      // The label is prose and wraps; the URL is one token and is split on a
      // natural break so it can still be read and pasted back together.
      for (const row of wrap(link.label || link.url, terminalWidth() - 5)) lines.push(`   ${row}`)
      if (link.label && link.url) {
        const room = Math.max(16, terminalWidth() - 5)
        let rest = oneLine(link.url)
        while (wide(rest) > room) {
          const chars = [...rest]
          let at = room
          for (let i = room; i > room / 2; i -= 1) if ('/ ?&=_-'.includes(chars[i - 1])) { at = i; break }
          lines.push(`     ${chars.slice(0, at).join('')}`)
          rest = chars.slice(at).join('')
        }
        if (rest) lines.push(`     ${rest}`)
      }
    }
    const fields = unansweredFields(ask)
    fields.forEach((field, i) => {
      const state = states.get(`${ask.ticket}:${field.name}`) || { value: undefined }
      const focus = i === fieldIndex
      const required = field.required ? '*' : ''
      let shown = redactValue(field, state.value)
      if (field.type === 'choice') shown = shown || (field.choices || []).map((c, n) => `${n + 1}:${c.label}`).join(' | ')
      if (field.type === 'confirm') shown = state.value ? '[x]' : '[ ]'
      // A long question, and a long answer a human typed, both wrap.
      const rows = wrap(`${field.label || field.name}${required}: ${shown}`, terminalWidth() - 4)
      lines.push(`   ${focus ? accent + '>' + reset : ' '} ${rows[0]}`)
      for (const row of rows.slice(1)) lines.push(`     ${row}`)
      if (field.type === 'paste' && field.command) {
        for (const row of wrap(`run: ${field.command}`, terminalWidth() - 7)) lines.push(`     ${row}`)
      }
    })
    lines.push('')
  })
  if (queue.length === 0) lines.push('Queue is clear.', '')

  const ask = selectedAsk()
  const missing = ask && expanded === ask.ticket ? missingFor(ask, valuesFor(ask)) : []
  let status = footer
  if (!status && missing.length) status = `still needed: ${missing.join(', ')}`
  if (!status) status = 'j/k move · enter expand · tab fields · ctrl-enter/s submit · r refresh · p scope · l link · q quit'
  for (const row of wrap(status, terminalWidth() - 1)) lines.push(row)

  // A card taller than the window must not have its own fields cut off. The
  // header (two rows) and the footer stay put; the middle is a window that the
  // arrows move, and it holds the human's position until they change card.
  const rows = Math.max(10, stdout.rows || Number(process.env.LINES) || 40)
  const fixed = 3
  const budget = Math.max(1, rows - fixed)
  const body = lines.slice(2, lines.length - 1)
  if (body.length > budget) {
    if (manualScroll === null) {
      scroll = Math.max(0, Math.min(scroll, body.length - budget))
    } else {
      scroll = Math.max(0, Math.min(manualScroll, body.length - budget))
    }
    const windowRows = body.slice(scroll, scroll + budget)
    const more = `${scroll > 0 ? '↑' : ' '}${scroll + budget < body.length ? '↓' : ' '}`
    const frame = [...lines.slice(0, 2), ...windowRows, more, lines[lines.length - 1]]
    return stdout.write(`\x1b[H\x1b[2J${frame.join('\n')}`)
  }
  scroll = 0
  if (manualScroll !== null) manualScroll = null
  stdout.write(`\x1b[H\x1b[2J${lines.join('\n')}`)
}

function safeDraft(ask) {
  const secretNames = new Set((ask.fields || []).filter((field) => field.type === 'secret').map((field) => field.name))
  return Object.fromEntries(Object.entries(valuesFor(ask)).filter(([name]) => !secretNames.has(name)))
}

function scheduleDraft(ask, field) {
  if (field.type === 'secret') return
  clearTimeout(draftTimer)
  draftTimer = setTimeout(async () => {
    try { await api(`/api/asks/${encodeURIComponent(ask.ticket)}/draft`, { values: safeDraft(ask) }) }
    catch (error) { footer = error.message; render() }
  }, 700)
}

async function submit() {
  const ask = selectedAsk()
  if (!ask || expanded !== ask.ticket) return
  const missing = missingFor(ask, valuesFor(ask))
  if (missing.length) { footer = `still needed: ${missing.join(', ')}`; return render() }
  busy = true
  try {
    const result = await api(`/api/asks/${encodeURIComponent(ask.ticket)}/answer`, { values: valuesFor(ask) })
    footer = result.complete && ask.gating ? `waking ${ask.origin?.agent || 'agent'}` : result.complete ? 'answered' : 'saved'
    expanded = null
    data.asks = data.asks.filter((item) => item.ticket !== ask.ticket || !result.complete)
  } catch (error) { footer = error.message }
  finally { busy = false; render() }
}

async function mintLink() {
  try {
    const result = await api('/api/links', { ttl_seconds: 3600 })
    footer = `${result.url} (expires ${result.expires_at})`
  } catch (error) { footer = error.message }
  render()
}

function finishEditingSoon() {
  isEditing = true
  clearTimeout(finishEditingSoon.timer)
  finishEditingSoon.timer = setTimeout(() => { isEditing = false }, 700)
}

readline.emitKeypressEvents(stdin)
stdin.setRawMode(true)
stdout.write('\x1b[?1049h\x1b[?25l')
process.on('SIGWINCH', render)
stdin.on('keypress', (_text, key) => {
  if (busy) return
  if ((key.ctrl && key.name === 'c') || key.name === 'q') { restore(); process.exit(0) }
  if (key.ctrl && (key.name === 'return' || key.name === 'enter')) return void submit()
  const queue = asks()
  const ask = selectedAsk()
  const fields = ask ? unansweredFields(ask) : []

  if (expanded === ask?.ticket && fields.length) {
    if (key.name === 'tab') {
      fieldIndex = (fieldIndex + (key.shift ? -1 : 1) + fields.length) % fields.length
      footer = ''
      return render()
    }
    const field = fields[fieldIndex]
    const stateKey = `${ask.ticket}:${field.name}`
    const previous = states.get(stateKey) || { value: undefined }
    const next = applyKey(previous, key, field)
    if (next !== previous) {
      states.set(stateKey, next)
      finishEditingSoon()
      scheduleDraft(ask, field)
      footer = ''
      return render()
    }
  }

  // Arrows scroll a card taller than the window; with nothing to scroll they
  // move the selection, as they always did. j/k always move.
  if (key.name === 'j') { selected = Math.min(queue.length - 1, selected + 1); manualScroll = null }
  else if (key.name === 'k') { selected = Math.max(0, selected - 1); manualScroll = null }
  else if (key.name === 'down' || key.name === 'up') {
    if (expanded !== ask?.ticket || !overflows(ask)) {
      selected = key.name === 'down'
        ? Math.min(queue.length - 1, selected + 1)
        : Math.max(0, selected - 1)
      manualScroll = null
    } else {
      manualScroll = Math.max(0, (manualScroll ?? scroll) + (key.name === 'down' ? 1 : -1))
    }
  } else if (key.name === 'pagedown' || key.name === 'pageup') {
    const page = Math.max(1, (stdout.rows || 40) - 6)
    manualScroll = Math.max(0, (manualScroll ?? scroll) + (key.name === 'pagedown' ? page : -page))
  } else if (key.name === 'home') manualScroll = 0
  else if (key.name === 'end') manualScroll = Number.MAX_SAFE_INTEGER
  else if (key.name === 'return' || key.name === 'enter') {
    expanded = expanded === ask?.ticket ? null : ask?.ticket
    fieldIndex = 0
    manualScroll = null
  } else if (key.name === 's') return void submit()
  else if (key.name === 'r') return void refresh()
  else if (key.name === 'p') { profile = profile === '*' ? (activeScope || '*') : '*'; return void refresh() }
  else if (key.name === 'l') return void mintLink()
  else return
  footer = ''
  render()
})

await refresh()
setInterval(() => { if (!isEditing) void refresh() }, 6000).unref()
