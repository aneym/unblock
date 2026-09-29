import { groupOf, isMissing, sortAsks, unansweredFields } from './queue-model.js'
import { APPROVAL_PURPOSES } from './schema.js'

const clean = (value) => String(value ?? '').replace(/https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S*|\bub_[\w-]+\b/gi, 'the queue page').trim()
const midSentence = (value) => {
  const text = clean(value).replace(/\.$/, '')
  return /^[A-Z][A-Z]/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1)
}
const object = (properties, required = []) => ({ type: 'OBJECT', properties, required })
const number = { type: 'INTEGER', description: 'One-based number from the voice list.' }
const project = { type: 'STRING', description: 'Optional project name to filter the queue.' }
const answer = object({ field: { type: 'STRING', description: 'Question number, field name, or spoken label.' }, value: { type: 'STRING', description: 'The human’s spoken answer; never a secret.' }, context: { type: 'STRING', description: 'The human’s qualification or condition on this answer.' } }, ['field', 'value'])
const answerArgs = object({ n: number, answers: { type: 'ARRAY', items: answer, description: 'Answers explicitly spoken by the human.' }, accept_all_recommended: { type: 'BOOLEAN', description: 'Only when the human explicitly accepts recommendations; never covers must_decide fields.' } }, ['n'])

export const VOICE_TOOLS = [
  { name: 'queue_summary', description: 'Start here. A short spoken overview with counts and three priorities; read speech aloud.', parameters: object({ project }) },
  { name: 'queue_list', description: 'List voice-eligible asks with their one-based numbers. Screen-only asks cannot be answered by voice.', parameters: object({ project }) },
  { name: 'ask_read', description: 'Read ONE voice-eligible ask by its current list number. Say the returned speech verbatim, then wait for the human.', parameters: object({ n: number }, ['n']) },
  { name: 'ask_preview', description: 'Normalize what the human said and read it back BEFORE sending. Read speech aloud and wait for explicit spoken yes.', parameters: answerArgs },
  { name: 'ask_answer', description: 'Send only after explicit spoken yes to the immediately matching ask_preview. Repeat exactly the same arguments as the preview.', parameters: answerArgs },
  { name: 'ask_skip', description: 'Move this ask to the end of the voice list for this session; do not answer it.', parameters: object({ n: number }, ['n']) },
  { name: 'ask_send_back', description: 'Send an ask back only with the human’s own requested correction. Do not decide for them.', parameters: object({ n: number, note: { type: 'STRING', description: 'The human’s own words explaining what the agent should rework.' } }, ['n', 'note']) },
]

export const VOICE_SYSTEM_PROMPT = `You are triaging the human’s unblock queue by voice. You NEVER make decisions for them. Every answer comes from their mouth; if unsure, ask again. Open with queue_summary and read its speech. Ask whether to work through the queue, jump to a project, or hear queue_list. When they say go, start at one. Work on one ask at a time: ask_read, read its speech VERBATIM, then stop and wait. Never read another until this is answered, skipped, or sent back. A number, label or yes is their answer; "accept all" means accept_all_recommended only when they explicitly say it. A must_decide field always needs their explicit answer. If they qualify an answer, put the qualification in that field's context. Always call ask_preview and read its speech aloud. Wait for an explicit spoken yes BEFORE ask_answer with the exact same arguments; if they change anything, preview again. After sending, briefly confirm and move on. Skip only when they ask to skip; send back only with their own note. Never read ticket IDs or URLs aloud. Screen-only asks need a passkey, credential or paste: mention them once as needing the queue page, then move on. Never ask for or repeat a secret. Do not submit partial answers if the human goes quiet. Do not argue with a rejected recommendation. Keep your own words short. Close with how many are left.`

export function voiceDeck(asks) {
  const voice = []
  const screen = []
  for (const ask of sortAsks(asks)) {
    const open = unansweredFields(ask)
    const reason = APPROVAL_PURPOSES.includes(ask.purpose) ? 'approval' :
      open.some((field) => field.type === 'secret') ? 'secret' :
        open.some((field) => field.type === 'paste') ? 'paste' : null
    if (reason) screen.push({ ask, reason })
    else voice.push(ask)
  }
  return { voice, screen }
}

const DAY = 86400000
export function age(date, now = Date.now()) {
  const ms = now - new Date(date).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const mins = Math.round(ms / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} minutes old`
  const hours = Math.round(mins / 60)
  if (hours < 36) return hours === 1 ? 'an hour old' : `${hours} hours old`
  return `${Math.round(ms / DAY)} days old`
}

export function fieldSpeech(field, n) {
  const lines = [`Question ${n}: ${clean(field.label || field.name)}.`]
  if (field.type === 'choice') {
    const choices = field.choices || []
    lines.push(`Options: ${choices.map((choice, i) => `${i + 1}, ${clean(choice.label || choice.value)}`).join('. ')}.`)
    if (field.must_decide) lines.push('This one is yours to call, so I am not recommending.')
    else if (field.recommend) {
      const idx = choices.findIndex((choice) => choice.value === field.recommend.value)
      lines.push(`I recommend ${idx >= 0 ? `option ${idx + 1}` : clean(field.recommend.value)}, because ${midSentence(field.recommend.why)}.`)
    }
    lines.push('Say the number, or say skip.')
  } else if (field.type === 'confirm') {
    lines.push('Say yes when it is done, or say skip.')
  } else if (field.type === 'secret' || field.type === 'paste') {
    lines.push(`This one needs a ${field.type === 'secret' ? 'credential' : 'paste from your machine'}, which does not go over voice. Open the queue page for it. Say skip to move on.`)
  } else {
    if (!field.must_decide && field.recommend) lines.push(`I suggest ${clean(field.recommend.value)}, because ${midSentence(field.recommend.why)}.`)
    lines.push('Say your answer, or say skip.')
  }
  return lines.join(' ')
}

export function askSpeech(ask, now = Date.now()) {
  const fields = unansweredFields(ask)
  const lines = [
    `${ask.purpose === 'blocker' ? 'A blocker' : 'A decision'} on ${clean(groupOf(ask))}, ${age(ask.created_at, now)}. ${clean(ask.title)}.`,
    clean(ask.why),
    ask.gating === 'park' || ask.gating === true ? 'An agent is stopped waiting on this.' : '',
  ]
  if (ask.steps?.length) lines.push(`Steps: ${ask.steps.map((step, i) => `${i + 1}, ${clean(step)}`).join('. ')}.`)
  lines.push(fields.length === 1 ? 'There is one question.' : `There are ${fields.length} questions.`)
  fields.forEach((field, i) => lines.push(fieldSpeech(field, i + 1)))
  if (fields.length > 1 && fields.every((field) => !field.must_decide && field.recommend)) lines.push('You can say "accept all recommended" to take every recommendation at once.')
  return lines.filter(Boolean).join(' ')
}

export function confirmSpeech(ask, values, skipped = [], context = {}) {
  const said = Object.entries(values).filter(([name]) => (ask.fields || []).some((field) => field.name === name)).map(([name, value]) => {
    const field = ask.fields.find((item) => item.name === name)
    if (field.type === 'secret') return `${clean(field.label || name)}: on the queue page`
    const choice = field.type === 'choice' ? (field.choices || []).find((item) => item.value === value) : null
    return `${clean(field.label || name)}: ${value === null ? 'unanswered' : clean(choice?.label || value)}${context[name] ? `, with the condition ${clean(context[name])}` : ''}`
  })
  const parts = []
  if (said.length) parts.push(`I have ${said.join('; ')}.`)
  if (skipped.length) parts.push(`Skipping ${skipped.map(clean).join(', ')}.`)
  parts.push('Say submit to send it, or tell me what to change.')
  return parts.join(' ')
}

export function resolveFieldKey(fields, key) {
  const raw = String(key).trim()
  const lower = raw.toLowerCase()
  const byName = fields.find((field) => field.name.toLowerCase() === lower)
  if (byName) return byName.name
  const numbered = lower.match(/^(?:(?:question|q)\s*)?(\d+)$/)
  if (numbered && fields[Number(numbered[1]) - 1]) return fields[Number(numbered[1]) - 1].name
  const byLabel = fields.find((field) => (field.label || '').toLowerCase() === lower)
  if (byLabel) return byLabel.name
  const partial = lower.length > 3 ? fields.filter((field) => (field.label || '').toLowerCase().includes(lower)) : []
  return partial.length === 1 ? partial[0].name : null
}

export function resolveChoice(field, spoken) {
  const choices = field.choices || []
  const raw = String(spoken).trim().toLowerCase()
  const exact = choices.find((choice) => String(choice.value).toLowerCase() === raw || (choice.label || '').toLowerCase() === raw)
  if (exact) return exact.value
  const bare = raw.replace(/[.,!?]/g, '').replace(/\b(option|number|choice|say|the|please|let'?s|go|with|do|pick|i'?ll|take)\b/g, '').trim()
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }
  const n = /^\d+$/.test(bare) ? Number(bare) : words[bare]
  if (n >= 1 && n <= choices.length) return choices[n - 1].value
  const partial = raw.length > 2 ? choices.filter((choice) => (choice.label || '').toLowerCase().includes(raw)) : []
  return partial.length === 1 ? partial[0].value : null
}

const fail = (speech, ticket) => ({ ok: false, speech: clean(speech), ...(ticket ? { ticket } : {}) })
const canonical = (value) => JSON.stringify(value, function (key, item) {
  if (item && !Array.isArray(item) && typeof item === 'object') {
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  }
  return item
})
const yesNo = (value) => {
  if (value === true || /^(yes|yeah|yep|true|done)$/i.test(String(value).trim())) return true
  if (value === false || /^(no|nope|false|not done)$/i.test(String(value).trim())) return false
  return null
}

export function createVoiceSession(deps) {
  const pending = new Map()
  const skipped = []
  const completed = new Set()
  const now = deps.now || Date.now
  const deck = async () => {
    const fresh = voiceDeck((await deps.getAsks()).filter((ask) => ask.status === 'open' && !completed.has(ask.ticket)))
    const later = fresh.voice.filter((ask) => skipped.includes(ask.ticket))
      .sort((a, b) => skipped.indexOf(a.ticket) - skipped.indexOf(b.ticket))
    return { voice: [...fresh.voice.filter((ask) => !skipped.includes(ask.ticket)), ...later], screen: fresh.screen }
  }
  const get = (current, n) => Number.isInteger(n) && n >= 1 ? current.voice[n - 1] : undefined
  const nextSpeech = async (n) => {
    try {
      const current = await deck()
      const next = current.voice.length ? current.voice[Math.min(n, current.voice.length) - 1] : undefined
      return next ? ` Next is number ${current.voice.indexOf(next) + 1}, ${clean(next.title)}.` : ' That was the last one.'
    } catch {
      return ''
    }
  }
  const bodyFor = (ask, args) => {
    const fields = unansweredFields(ask)
    const values = {}
    const field_context = {}
    if (args.accept_all_recommended === true) {
      for (const field of fields) if (!field.must_decide && field.recommend) values[field.name] = field.recommend.value
    }
    if (args.answers !== undefined && !Array.isArray(args.answers)) return { error: 'Please read that answer again.' }
    for (const item of args.answers || []) {
      if (!item || typeof item !== 'object') return { error: 'Please read that answer again.' }
      const name = resolveFieldKey(fields, item.field)
      if (!name) return { error: 'I could not match that question. Read it again.' }
      const field = fields.find((entry) => entry.name === name)
      if (field.type === 'secret' || field.type === 'paste') return { error: 'That needs the queue page.' }
      const value = field.type === 'choice' ? resolveChoice(field, item.value) :
        field.type === 'confirm' ? yesNo(item.value) : item.value
      if (value === null || value === undefined || (typeof value === 'string' && isMissing(value))) return { error: `Please answer ${clean(field.label || name)} again.` }
      values[name] = value
      if (item.context) field_context[name] = String(item.context)
    }
    for (const field of fields) {
      if (field.must_decide && !(field.name in values)) return { error: `You need to decide ${clean(field.label || field.name)} yourself.` }
      if (field.required && isMissing(values[field.name])) return { error: `Still need ${clean(field.label || field.name)}.` }
      if (!(field.name in values)) values[field.name] = null
    }
    return { body: { ticket: ask.ticket, revision: ask.revision, values, reply: '', field_context, field_bounce: {} } }
  }
  return {
    async handle(name, args = {}) {
      let ticket
      try {
        const current = await deck()
        if (name === 'queue_summary') {
          const all = [...current.voice, ...current.screen.map(({ ask }) => ask)]
          const scoped = args.project ? all.filter((ask) => groupOf(ask).toLowerCase() === String(args.project).toLowerCase()) : all
          if (!scoped.length) return { ok: true, speech: 'The queue is empty. Nothing is waiting on you.' }
          const counts = new Map()
          for (const ask of scoped) counts.set(groupOf(ask), (counts.get(groupOf(ask)) || 0) + 1)
          const spread = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${n} on ${clean(p)}`).join(', ')
          const eligible = current.voice.filter((ask) => scoped.includes(ask))
          const onScreen = current.screen.filter(({ ask }) => scoped.includes(ask)).length
          const top = eligible.slice(0, 3).map((ask, i) => `${i + 1}, ${clean(ask.title)}`).join('. ')
          return { ok: true, speech: `${scoped.length} open: ${spread}. ${top ? `The ones that matter: ${top}. ` : ''}${onScreen ? `${onScreen} need the screen. ` : ''}Say read one to hear the first, or name a project to filter.` }
        }
        if (name === 'queue_list') {
          const voice = args.project ? current.voice.filter((ask) => groupOf(ask).toLowerCase() === String(args.project).toLowerCase()) : current.voice
          return { ok: true, speech: voice.length ? voice.map((ask) => `${current.voice.indexOf(ask) + 1}. ${clean(groupOf(ask))}. ${clean(ask.title)}. ${age(ask.created_at, now())}.`).join(' ') : 'No voice asks in that project.' }
        }
        const ask = get(current, args.n)
        if (!ask) return fail('That number is not in the voice queue. Hear the list again.')
        ticket = ask.ticket
        if (name === 'ask_read') return { ok: true, ticket, speech: askSpeech(ask, now()) }
        if (name === 'ask_skip') {
          if (!skipped.includes(ticket)) skipped.push(ticket)
          pending.delete(ticket)
          return { ok: true, ticket, speech: `Skipped for now.${await nextSpeech(args.n)}` }
        }
        if (name === 'ask_send_back') {
          if (typeof args.note !== 'string' || !args.note.trim()) return fail('Tell me what to send back first.', ticket)
          await deps.postAnswer({ ticket, revision: ask.revision, reply: args.note, bounce: true })
          pending.delete(ticket)
          completed.add(ticket)
          return { ok: true, ticket, changed: true, speech: `Sent back to the agent.${await nextSpeech(args.n)}` }
        }
        if (name === 'ask_preview' || name === 'ask_answer') {
          const result = bodyFor(ask, args)
          if (result.error) {
            pending.delete(ticket)
            return fail(result.error, ticket)
          }
          if (name === 'ask_preview') {
            pending.set(ticket, structuredClone(result.body))
            return { ok: true, ticket, speech: confirmSpeech(ask, result.body.values, [], result.body.field_context) }
          }
          if (canonical(result.body) !== canonical(pending.get(ticket))) return fail('Read it back with a preview first.', ticket)
          await deps.postAnswer(result.body)
          pending.delete(ticket)
          completed.add(ticket)
          return { ok: true, ticket, changed: true, speech: `Sent to the agent.${await nextSpeech(args.n)}` }
        }
        return fail('That voice tool is not available.', ticket)
      } catch (error) {
        pending.delete(ticket)
        if (error?.code === 'STALE_REVISION') return fail('The agent changed that one. Read it again.', ticket)
        if (error?.code === 'ASK_NOT_OPEN') return fail('That one is already closed.', ticket)
        return fail('That did not work. Please try again.', ticket)
      }
    },
  }
}
