#!/usr/bin/env node
import { log, readEntry, remove, request } from './lib.js'
import { promptPane as herdr } from '../src/pane-notice.js'

const ticket = process.argv[2]
if (!/^ub_[a-z0-9]+$/.test(ticket || '') || readEntry(ticket)?.type !== 'question') process.exit(0)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function collect() {
  await request(`/api/asks/${ticket}/collect`, {})
  remove(ticket)
}

function answerLine(ask) {
  if (ask.status === 'bounced') return `[unblock ${ticket}] Alex sent your question back: ${ask.reply || 'no note'}. Ask again better, or decide yourself if you can.`
  const values = ask.fields.map((field) => {
    const value = ask.answers?.[field.name]
    // A per-field send-back is {$bounce: note|true, value?}, not a plain value.
    if (value && typeof value === 'object' && !Array.isArray(value) && '$bounce' in value) {
      const note = typeof value.$bounce === 'string' ? value.$bounce : 'no note'
      return `${field.label} -> sent back (${note})${value.value !== undefined ? `, leaning ${value.value}` : ''}`
    }
    // null is an explicit skip: the human left it to the agent's recommendation.
    if (value === null) return `${field.label} -> skipped, go with your recommendation${field.recommend ? ` (${field.recommend.value})` : ''}`
    const allowed = field.type === 'choice' ? new Set(field.choices.map((choice) => choice.value)) : null
    const render = (item) => typeof item === 'string' && allowed && !allowed.has(item) ? `in their words: ${item}` : String(item ?? '')
    return `${field.label} -> ${Array.isArray(value) ? value.map(render).join(', ') : render(value)}`
  })
  return `[unblock ${ticket}] Alex answered: ${values.join(' | ')}${ask.reply ? ` | Note: ${ask.reply}` : ''}`
}

async function deliverQuestion(ask, pane) {
  const deadline = Date.now() + 30 * 60 * 1000
  do {
    try {
      await herdr(['agent', 'prompt', pane, answerLine(ask)])
      await collect()
      return true
    } catch {
      if (Date.now() >= deadline) { log('question delivery failed for 30 minutes'); return true }
      await sleep(10000)
    }
  } while (true)
}

const initial = readEntry(ticket)
const deadline = Date.parse(initial.created_at) + 86400000
let missing = 0
while (Date.now() < deadline) {
  const entry = readEntry(ticket)
  if (!entry) break
  try {
    const ask = await request(`/api/asks/${ticket}`)
    if (['cancelled', 'expired', 'orphaned', 'collected'].includes(ask.status)) { remove(ticket); break }
    try {
      await herdr(['pane', 'get', entry.pane_id])
      missing = 0
    } catch {
      if (++missing >= 2) break
      await sleep(3000)
      continue
    }
    if (ask.status === 'answered' || ask.status === 'bounced') {
      await deliverQuestion(ask, entry.pane_id)
      break
    }
  } catch (error) {
    if (error.status === 404) { remove(ticket); break }
    log('pane watcher poll failed')
  }
  await sleep(3000)
}
