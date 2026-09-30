import { groupOf, isMissing, sortAsks, unansweredFields } from './queue-model.js'
import { APPROVAL_PURPOSES } from './schema.js'

const clean = (value) => String(value ?? '').replace(/https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S*|\bub_[\w-]+\b/gi, 'the queue page').trim()
const sentence = (value) => { const text = clean(value); return text + (/[.?!]$/.test(text) ? '' : '.') }
const midSentence = (value) => {
  const text = clean(value).replace(/\.$/, '')
  return /^[A-Z][A-Z]/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1)
}
const object = (properties, required = []) => ({ type: 'OBJECT', properties, required })
const number = { type: 'INTEGER', description: 'One-based number from the voice list.' }
const project = { type: 'STRING', description: 'Optional project name to filter the queue.' }
const answer = object({ field: { type: 'STRING', description: 'Question number, field name, or spoken label.' }, value: { type: 'STRING', description: 'The human’s spoken answer; never a secret.' }, context: { type: 'STRING', description: 'The human’s qualification or condition on this answer.' } }, ['field', 'value'])
const answerArgs = object({ n: number, answers: { type: 'ARRAY', items: answer, description: 'Answers explicitly spoken by the human.' }, accept_all_recommended: { type: 'BOOLEAN', description: 'Only when the human explicitly accepts recommendations; never covers must_decide fields.' } })

export function xaiTools(tools = VOICE_TOOLS) {
  const lowerTypes = (node) => {
    if (Array.isArray(node)) return node.map(lowerTypes)
    if (!node || typeof node !== 'object') return node
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === 'type' && typeof value === 'string' ? value.toLowerCase() : lowerTypes(value)]))
  }
  return tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters: lowerTypes(parameters) }))
}

export const VOICE_TOOLS = [
  { name: 'queue_summary', description: 'Start here. A short spoken overview with counts and three priorities; read speech aloud.', parameters: object({ project }) },
  { name: 'queue_list', description: 'List voice-eligible asks with their one-based numbers. Screen-only asks cannot be answered by voice.', parameters: object({ project }) },
  { name: 'ask_read', description: 'Read ONE voice-eligible ask by its current list number. Say the returned speech verbatim, then wait for the human.', parameters: object({ n: number }) },
  { name: 'ask_preview', description: 'Normalize what the human said and read it back BEFORE sending. Read speech aloud and wait for explicit spoken yes.', parameters: answerArgs },
  { name: 'ask_answer', description: 'Send only after explicit spoken yes to the immediately matching ask_preview. Repeat exactly the same arguments as the preview.', parameters: answerArgs },
  { name: 'ask_skip', description: 'Move this ask to the end of the voice list for this session; do not answer it.', parameters: object({ n: number }) },
  { name: 'ask_send_back', description: 'Send an ask back only with the human’s own requested correction. Do not decide for them.', parameters: object({ n: number, note: { type: 'STRING', description: 'The human’s own words explaining what the agent should rework.' } }, ['note']) },
  { name: 'show_queue', description: 'Show the queue, optionally filtering to a project or clearing the filter with all.', parameters: object({ project, all: { type: 'BOOLEAN' } }) },
  { name: 'show_answered', description: 'Show answered asks.', parameters: object({}) },
  { name: 'show_screen_ask', description: 'Show a screen-only ask by its number in the screen list.', parameters: object({ n: number }, ['n']) },
  { name: 'open_link', description: 'Open a link from an ask, by number or spoken label.', parameters: object({ n: number, which: { type: 'STRING', description: 'Link number or spoken label.' } }) },
  { name: 'show_details', description: 'Open or close the ask details.', parameters: object({ n: number, open: { type: 'BOOLEAN' } }) },
  { name: 'file_issue', description: 'File a problem or requested change immediately; no read-back needed.', parameters: object({ title: { type: 'STRING', description: 'Short imperative title.' }, details: { type: 'STRING', description: 'The human’s own words, without secrets.' }, about: { type: 'STRING', enum: ['unblock', 'dashboard', 'other'] } }, ['title', 'details', 'about']) },
  { name: 'set_speed', description: 'Change speaking speed immediately, without a read-back.', parameters: object({ speed: { type: 'NUMBER', description: 'Speaking speed multiplier, from 0.7 to 1.5.' }, change: { type: 'STRING', enum: ['faster', 'slower', 'normal'] } }) },
  { name: 'end_call', description: 'Finish the voice call.', parameters: object({}) },
]

export const VOICE_SYSTEM_PROMPT = `You are triaging the human’s unblock queue by voice. You NEVER make decisions for them. Every answer comes from their mouth; if unsure, ask again. Open with queue_summary and read its speech. Ask whether to work through the queue, jump to a project, or hear queue_list. When they say go, start at one. Work on one ask at a time: ask_read, read its speech VERBATIM, then stop and wait. Never read another until this is answered, skipped, or sent back. A number, label or yes is their answer; "accept all" means accept_all_recommended only when they explicitly say it. A must_decide field always needs their explicit answer. If they qualify an answer, put the qualification in that field's context. Always call ask_preview and read its speech aloud. Wait for an explicit spoken yes BEFORE ask_answer with the exact same arguments; if they change anything, preview again. After sending, briefly confirm and move on. Skip only when they ask to skip; send back only with their own note. Never read ticket IDs or URLs aloud. Screen-only asks need a passkey, credential or paste to answer: mention them once as needing the queue page, then move on. You can skip or send back any open ask, including screen-only asks; neither action needs its credential. When the human reports a problem, asks for something to work differently, or says "file an issue", call file_issue at once. Use a short imperative title and their own words as details. Confirm with the issue number; no read-back is needed because filing is reversible. You are also the human’s hands on the page: when they ask to see, open, filter, go back, show answered, open a link, show details or hang up, call the matching tool immediately and confirm in a few words. Never name tools aloud. Never announce that you are about to call a tool; just do it. If a tool fails, say its speech once and wait; never retry the same tool with the same arguments. After end_call, say nothing more. Never ask for or repeat a secret. Do not submit partial answers if the human goes quiet. Do not argue with a rejected recommendation. Keep your own words short. Close with how many are left.
When the owner asks to talk faster, slower, or at a set speed, call set_speed at once and don't read anything back.`

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
  const lines = [`Question ${n}: ${sentence(field.label || field.name)}`]
  if (field.type === 'choice') {
    const choices = field.choices || []
    lines.push(`Options: ${choices.map((choice, i) => sentence(`${i + 1}, ${clean(choice.label || choice.value)}`)).join(' ')}`)
    if (field.must_decide) lines.push('This one is yours to call, so I am not recommending.')
    else if (field.recommend) {
      const idx = choices.findIndex((choice) => choice.value === field.recommend.value)
      lines.push(sentence(`I recommend ${idx >= 0 ? `option ${idx + 1}` : clean(field.recommend.value)}, because ${midSentence(field.recommend.why)}`))
    }
    lines.push('Say the number, or say skip.')
  } else if (field.type === 'confirm') {
    lines.push('Say yes when it is done, or say skip.')
  } else if (field.type === 'secret' || field.type === 'paste') {
    lines.push(`This one needs a ${field.type === 'secret' ? 'credential' : 'paste from your machine'}, which does not go over voice. Open the queue page for it. Say skip to move on.`)
  } else {
    if (!field.must_decide && field.recommend) lines.push(sentence(`I suggest ${clean(field.recommend.value)}, because ${midSentence(field.recommend.why)}`))
    lines.push('Say your answer, or say skip.')
  }
  return lines.join(' ')
}

export function askSpeech(ask, now = Date.now()) {
  const fields = unansweredFields(ask)
  const lines = [
    `${ask.purpose === 'blocker' ? 'A blocker' : 'A decision'} on ${clean(groupOf(ask))}, ${age(ask.created_at, now)}. ${sentence(ask.title)}`,
    clean(ask.why),
    ask.gating === 'park' || ask.gating === true ? 'An agent is stopped waiting on this.' : '',
  ]
  if (ask.steps?.length) lines.push(`Steps: ${ask.steps.map((step, i) => sentence(`${i + 1}, ${clean(step)}`)).join(' ')}`)
  lines.push(fields.length === 1 ? 'There is one question.' : `There are ${fields.length} questions.`)
  fields.forEach((field, i) => lines.push(fieldSpeech(field, i + 1)))
  if (fields.length > 1 && fields.every((field) => !field.must_decide && field.recommend)) lines.push('You can say "accept all recommended" to take every recommendation at once.')
  const links = askLinks(ask)
  if (links.length) lines.push(links.length === 1 ? 'It has a link; say open the link to see it.' : `It has ${links.length} links; say open a link to see them.`)
  return lines.filter(Boolean).join(' ')
}

function askLinks(ask) {
  const seen = new Set()
  const links = [...(ask.links || []), ...(ask.fields || []).filter((field) => field.url).map((field) => ({ url: field.url, label: field.label }))]
  return links.filter(({ url }) => {
    if (!url || seen.has(url)) return false
    seen.add(url)
    return true
  })
}

function linkHost(url) {
  try { return new URL(url).hostname || 'the link' } catch { return 'the link' }
}

export function confirmSpeech(ask, values, skipped = [], context = {}) {
  const said = Object.entries(values).filter(([name]) => (ask.fields || []).some((field) => field.name === name)).map(([name, value]) => {
    const field = ask.fields.find((item) => item.name === name)
    if (field.type === 'secret') return `${clean(field.label || name)}: on the queue page`
    const choice = field.type === 'choice' ? (field.choices || []).find((item) => item.value === value) : null
    return `${clean(field.label || name)}: ${value === null ? 'unanswered' : clean(choice?.label || value)}${context[name] ? `, with the condition ${clean(context[name])}` : ''}`
  })
  const parts = []
  if (said.length) parts.push(sentence(`I have ${said.join('; ')}`))
  if (skipped.length) parts.push(sentence(`Skipping ${skipped.map(clean).join(', ')}`))
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
  let focus = null
  let shown = null
  const deck = async () => {
    const fresh = voiceDeck((await deps.getAsks()).filter((ask) => ask.status === 'open' && !completed.has(ask.ticket) && (!focus || groupOf(ask) === focus)))
    const later = fresh.voice.filter((ask) => skipped.includes(ask.ticket))
      .sort((a, b) => skipped.indexOf(a.ticket) - skipped.indexOf(b.ticket))
    return { voice: [...fresh.voice.filter((ask) => !skipped.includes(ask.ticket)), ...later], screen: [...fresh.screen.filter(({ ask }) => !skipped.includes(ask.ticket)), ...fresh.screen.filter(({ ask }) => skipped.includes(ask.ticket))] }
  }
  const get = (current, n) => Number.isInteger(n) && n >= 1 ? current.voice[n - 1] :
    n === undefined ? (shown ? current.voice.find((ask) => ask.ticket === shown) || current.screen.find(({ ask }) => ask.ticket === shown)?.ask : undefined) || current.voice[0] : undefined
  const nextSpeech = async (n) => {
    try {
      const current = await deck()
      const next = current.voice.length ? current.voice[Math.min(n, current.voice.length) - 1] : undefined
      return next ? { speech: ` Next is number ${current.voice.indexOf(next) + 1}, ${sentence(next.title)}`, ticket: next.ticket } : { speech: ' That was the last one.' }
    } catch {
      return { speech: '' }
    }
  }
  const after = async (n) => {
    const next = await nextSpeech(n)
    shown = next.ticket || null
    return { speech: next.speech, ui: next.ticket ? { do: 'show_ask', ticket: next.ticket } : { do: 'show_list' } }
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
        if (name === 'set_speed') {
          if (deps.provider === 'gemini') return fail('I can only change my speed on GPT or Grok.')
          if (typeof args.speed === 'number' && Number.isFinite(args.speed)) {
            const value = Math.round(Math.max(0.7, Math.min(1.5, args.speed)) * 10) / 10
            return { ok: true, speech: `Okay, ${value} times.`, ui: { do: 'speed', value } }
          }
          if (!['faster', 'slower', 'normal'].includes(args.change)) return fail('Tell me a speed, or say faster, slower, or normal.')
          const speech = { faster: 'Okay, faster.', slower: 'Okay, slower.', normal: 'Back to normal speed.' }[args.change]
          return { ok: true, speech, ui: { do: 'speed', change: args.change } }
        }
        if (name === 'end_call') return { ok: true, speech: 'Talk soon.', ui: { do: 'end_call' } }
        if (name === 'file_issue') {
          if (!deps.fileIssue) return fail("I can't file issues from here.")
          const title = typeof args.title === 'string' ? args.title.trim() : ''
          const details = typeof args.details === 'string' ? args.details : ''
          if (!title || !['unblock', 'dashboard', 'other'].includes(args.about)) return fail("That didn't file. Try again.")
          try {
            const { number, url } = await deps.fileIssue({ title, details, about: args.about, ...(shown ? { ticket: shown } : {}) })
            return { ok: true, speech: `Filed as issue ${number}.`, ui: { do: 'filed', number, url } }
          } catch { return fail("That didn't file. Try again.") }
        }
        if (name === 'show_answered') {
          const answered = (await deps.getAsks()).filter((ask) => ask.status === 'answered')
            .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
          return { ok: true, speech: `Showing ${answered.length} answered.${answered.length ? ` Newest is ${clean(answered[0].title)}.` : ''}`, ui: { do: 'show_answered' } }
        }
        if (name === 'show_queue') {
          if (args.all === true) focus = null
          else if (args.project) {
            const open = (await deps.getAsks()).filter((ask) => ask.status === 'open' && !completed.has(ask.ticket))
            const projects = [...new Set(open.map(groupOf))]
            const sought = String(args.project).trim().toLowerCase()
            const exact = projects.find((item) => item.toLowerCase() === sought)
            const partial = projects.filter((item) => item.toLowerCase().includes(sought))
            const resolved = exact || (partial.length === 1 ? partial[0] : null)
            if (!resolved) return fail(`No project called ${args.project}. Projects are ${projects.map(clean).join(', ') || 'none'}.`)
            focus = resolved
          }
          shown = null
          const current = await deck()
          const count = current.voice.length + current.screen.length
          return { ok: true, speech: `Showing ${count}${focus ? ` on ${clean(focus)}` : ' in the queue'}.`, ui: args.all === true ? { do: 'show_list', all: true } : focus ? { do: 'show_list', project: focus } : { do: 'show_list' } }
        }
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
          const top = eligible.slice(0, 3).map((ask, i) => sentence(`${i + 1}, ${clean(ask.title)}`)).join(' ')
          return { ok: true, speech: `${scoped.length} open: ${spread}. ${top ? `The ones that matter: ${top} ` : ''}${onScreen ? `${onScreen} ${onScreen === 1 ? 'needs' : 'need'} the screen. ` : ''}Say read one to hear the first, or name a project to filter.` }
        }
        if (name === 'queue_list') {
          const voice = args.project ? current.voice.filter((ask) => groupOf(ask).toLowerCase() === String(args.project).toLowerCase()) : current.voice
          const screen = (args.project ? current.screen.filter(({ ask }) => groupOf(ask).toLowerCase() === String(args.project).toLowerCase()) : current.screen)
          const spoken = voice.length ? voice.map((ask) => `${current.voice.indexOf(ask) + 1}. ${sentence(groupOf(ask))} ${sentence(ask.title)} ${age(ask.created_at, now())}.`).join(' ') : 'No voice asks in that project.'
          return { ok: true, speech: spoken + (screen.length ? ` On screen only: ${screen.map(({ ask }, i) => `${i + 1}, ${clean(ask.title)}`).join('; ')}. Say show screen one to open it.` : '') }
        }
        if (name === 'show_screen_ask') {
          const item = Number.isInteger(args.n) && args.n >= 1 ? current.screen[args.n - 1] : null
          if (!item) return fail('That number is not in the screen list. Hear the list again.')
          ticket = shown = item.ask.ticket
          const need = { approval: 'your passkey', secret: 'a credential', paste: 'a paste' }[item.reason]
          return { ok: true, ticket, speech: `That one needs ${need}; it's on screen now.`, ui: { do: 'show_ask', ticket } }
        }
        if (name === 'ask_answer' && shown && pending.has(shown) &&
            !(current.voice.some((item) => item.ticket === shown) || current.screen.some(({ ask }) => ask.ticket === shown))) {
          const prior = (await deps.getAsks()).find((item) => item.ticket === shown)
          if (prior && prior.status !== 'open') {
            pending.delete(shown)
            return fail('That one is already closed.', shown)
          }
        }
        const ask = get(current, args.n)
        if (!ask) return fail('That number is not in the voice queue. Hear the list again.')
        ticket = ask.ticket
        if (name === 'ask_answer' && pending.has(ticket) && pending.get(ticket).revision !== ask.revision) {
          pending.delete(ticket)
          return fail('The agent changed that one. Read it again.', ticket)
        }
        if (current.screen.some(({ ask: item }) => item.ticket === ticket) && !['open_link', 'show_details', 'ask_skip', 'ask_send_back'].includes(name)) return fail('That one needs the screen.', ticket)
        if (name === 'ask_read') {
          shown = ticket
          return { ok: true, ticket, speech: askSpeech(ask, now()), ui: { do: 'show_ask', ticket } }
        }
        if (name === 'open_link') {
          const links = askLinks(ask)
          if (!links.length) return fail('That one has no links.', ticket)
          const which = args.which === undefined ? '' : String(args.which).trim().toLowerCase()
          const words = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5 }
          const numbered = which.match(/^(?:(?:the|link|number)\s+)*(\d+|one|first|two|second|three|third|four|fourth|five|fifth)(?:\s+link)?$/)
          const generic = /^(?:the\s+)?(?:link|it|that|this|doc|page)$/.test(which)
          let link = links.length === 1 || !which || generic ? links[0] : numbered ? links[(Number(numbered[1]) || words[numbered[1]]) - 1] : undefined
          if (!link && which && !numbered && !generic) {
            const label = links.filter((item) => String(item.label || '').toLowerCase().includes(which))
            const host = links.filter((item) => linkHost(item.url).toLowerCase().includes(which))
            link = label.length === 1 ? label[0] : host.length === 1 ? host[0] : undefined
          }
          if (!link) return fail(`Which one: ${links.map((item) => clean(item.label || linkHost(item.url))).join(' or ')}?`, ticket)
          const label = link.label || linkHost(link.url)
          const spoken = clean(label)
          return { ok: true, ticket, speech: spoken === 'the queue page' ? 'Opening the link.' : `Opening ${spoken}.`, ui: { do: 'open_link', url: link.url, label } }
        }
        if (name === 'show_details') return { ok: true, ticket, speech: args.open === false ? 'Details closed.' : 'Details open.', ui: { do: 'details', ticket, open: args.open !== false } }
        if (name === 'ask_skip') {
          if (!skipped.includes(ticket)) skipped.push(ticket)
          pending.delete(ticket)
          const next = await after(current.voice.includes(ask) ? (args.n || current.voice.indexOf(ask) + 1) : 1)
          return { ok: true, ticket, speech: `Skipped for now.${next.speech}`, ui: next.ui }
        }
        if (name === 'ask_send_back') {
          if (typeof args.note !== 'string' || !args.note.trim()) return fail('Tell me what to send back first.', ticket)
          await deps.postAnswer({ ticket, revision: ask.revision, reply: args.note, bounce: true })
          pending.delete(ticket)
          completed.add(ticket)
          const next = await after(current.voice.includes(ask) ? (args.n || current.voice.indexOf(ask) + 1) : 1)
          return { ok: true, ticket, changed: true, speech: `Sent back to the agent.${next.speech}`, ui: next.ui }
        }
        if (name === 'ask_preview' || name === 'ask_answer') {
          const result = bodyFor(ask, args)
          if (result.error) {
            pending.delete(ticket)
            return fail(result.error, ticket)
          }
          if (name === 'ask_preview') {
            pending.set(ticket, structuredClone(result.body))
            shown = ticket
            return { ok: true, ticket, speech: confirmSpeech(ask, result.body.values, [], result.body.field_context), ui: { do: 'fill', ticket, values: result.body.values, field_context: result.body.field_context } }
          }
          if (canonical(result.body) !== canonical(pending.get(ticket))) return fail('Read it back with a preview first.', ticket)
          await deps.postAnswer(result.body)
          pending.delete(ticket)
          completed.add(ticket)
          const next = await after(args.n || current.voice.indexOf(ask) + 1)
          return { ok: true, ticket, changed: true, speech: `Sent to the agent.${next.speech}`, ui: next.ui }
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
