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
    lines.push(`   ${focused ? accent : ''}${oneLine(ask.title)}${reset}`)
    lines.push(`   ${oneLine(ask.why)}`)
    if (expanded !== ask.ticket) return lines.push('')

    for (const step of ask.steps || []) lines.push(`   - ${oneLine(step)}`)
    for (const link of ask.links || []) lines.push(`   ${link.label || link.url}: ${link.url}`)
    const fields = unansweredFields(ask)
    fields.forEach((field, i) => {
      const state = states.get(`${ask.ticket}:${field.name}`) || { value: undefined }
      const focus = i === fieldIndex
      const required = field.required ? '*' : ''
      let shown = redactValue(field, state.value)
      if (field.type === 'choice') shown = shown || (field.choices || []).map((c, n) => `${n + 1}:${c.label}`).join(' | ')
      if (field.type === 'confirm') shown = state.value ? '[x]' : '[ ]'
      lines.push(`   ${focus ? accent + '>' + reset : ' '} ${field.label || field.name}${required}: ${shown}`)
      if (field.type === 'paste' && field.command) lines.push(`     run: ${field.command}`)
    })
    lines.push('')
  })
  if (queue.length === 0) lines.push('Queue is clear.', '')

  const ask = selectedAsk()
  const missing = ask && expanded === ask.ticket ? missingFor(ask, valuesFor(ask)) : []
  let status = footer
  if (!status && missing.length) status = `still needed: ${missing.join(', ')}`
  if (!status) status = 'j/k move · enter expand · tab fields · ctrl-enter/s submit · r refresh · p scope · l link · q quit'
  lines.push(status)
  stdout.write(`\x1b[H\x1b[2J${lines.join('\n').slice(0, Math.max(0, (stdout.columns || 120) * (stdout.rows || 40) - 1))}`)
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

  if (key.name === 'j' || key.name === 'down') selected = Math.min(queue.length - 1, selected + 1)
  else if (key.name === 'k' || key.name === 'up') selected = Math.max(0, selected - 1)
  else if (key.name === 'return' || key.name === 'enter') {
    expanded = expanded === ask?.ticket ? null : ask?.ticket
    fieldIndex = 0
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
