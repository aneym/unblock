import { makeAnchor, normalizeAnchor, plainText, sectionLabel } from './scope-anchor.js'

const object = (properties, required = []) => ({ type: 'OBJECT', properties, required })
const string = { type: 'STRING' }
export const SCOPE_VOICE_TOOLS = [
  { name: 'scope_overview', description: 'Read a short overview of this scope.', parameters: object({}) },
  { name: 'scope_read', description: 'Read a part of the scope; more continues a long plan.', parameters: object({ part: string, more: { type: 'BOOLEAN' } }, ['part']) },
  { name: 'answer_question', description: 'Send the human’s answer to a question.', parameters: object({ q: string, text: string, take_recommendation: { type: 'BOOLEAN' } }, ['q']) },
  { name: 'comment', description: 'Send a comment anchored to a named part or the text on screen.', parameters: object({ text: string, on: string }, ['text']) },
  { name: 'thought', description: 'Send an unanchored thought.', parameters: object({ text: string }, ['text']) },
  { name: 'show', description: 'Show a part of the scope.', parameters: object({ part: string }, ['part']) },
  { name: 'end_call', description: 'Finish the voice call.', parameters: object({}) },
]

export const SCOPE_VOICE_PROMPT = `You are the human's voice on a scoping doc. A lane, an AI agent, wrote this doc to agree the scope of some work with him before building it. You help him read it, talk it through, and send his notes to the lane. You never decide for him. Open with scope_overview and say its speech. Read parts with scope_read when he asks; say the speech as given, and for a long part offer to go on (more: true). You may explain or discuss what the doc says, briefly, but never invent facts that are not in it; say so when the doc doesn't cover something. When he answers a question, call answer_question with his words; "take the recommendation", "go with yours" or "yes to that" means take_recommendation: true. When he talks about something on screen ("on this", "this part", "here"), call comment with on: this; it anchors to his selection or what he is looking at. If he names a part, pass it as on. Anything else he wants the lane to hear goes as a thought. Send as soon as he has said it; no read-back. Pass his own words with filler removed; never add your own content or opinions to a note. If it is unclear which question he means, ask. After a send, confirm in a few words. When he asks to see a part, call show. Never read ids, URLs or tool names aloud, and never announce a tool call. If a tool fails, say its speech once and wait. After end_call, say nothing more. Keep your own words short.`

const clean = (value) => String(value ?? '').replace(/https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/\S*/gi, 'a link').trim()
const sentence = (value) => { const text = clean(value); return text ? text + (/[.?!]$/.test(text) ? '' : '.') : '' }
const result = (speech, ui) => ({ ok: true, speech: clean(speech), ...(ui ? { ui } : {}) })
const fail = (speech) => ({ ok: false, speech: clean(speech) })
const questionId = (value) => {
  const match = String(value ?? '').trim().match(/^(?:(?:question|q)\s*)?(\d{1,3})$/i)
  return match ? `Q${Number(match[1])}` : null
}
const partOf = (value) => questionId(value) || String(value ?? '').trim().toLowerCase()
const list = (value) => Array.isArray(value) ? value : []

function planChunk(text, start) {
  if (text.length - start <= 1200) return { speech: text.slice(start).trim(), end: text.length }
  const window = text.slice(start, start + 1200)
  let cut = window.lastIndexOf('\n')
  if (cut <= 0) {
    const sentences = [...window.matchAll(/[.!?](?=\s)/g)]
    cut = sentences.length ? sentences.at(-1).index + 1 : window.lastIndexOf(' ')
  }
  if (cut <= 0) cut = 1200
  return { speech: text.slice(start, start + cut).trim(), end: start + cut }
}

export function createScopeVoiceSession(deps) {
  const cursors = new Map()
  return {
    async handle(name, args = {}) {
      try {
        const { scope } = await deps.getScope()
        const questions = list(scope.questions).filter((q) => q && typeof q.id === 'string')
        const open = questions.filter((q) => q && (!q.status || q.status === 'open')).slice(0, 12)
        const questionList = () => open.map((q) => sentence(`Question ${Number(q.id.slice(1))}, ${q.text}`)).join(' ')
        const show = (part) => ({ do: 'show', part })
        const send = async (body, speech, ui) => {
          try { await deps.postNote({ ...body, via: 'voice' }); return result(speech, ui) }
          catch (error) { return fail(`That didn't send: ${sentence(error?.message || 'Please try again')}`) }
        }
        if (name === 'end_call') return result('Talk soon.', { do: 'end_call' })
        if (name === 'scope_overview') {
          const count = questions.filter((q) => q && (!q.status || q.status === 'open')).length
          const decided = list(scope.decisions).length
          return result(`${sentence(scope.title)} ${count} open ${count === 1 ? 'question' : 'questions'}: ${questionList()} ${decided ? `${decided} decided. ` : ''}Say where to start, or ask me to read the plan.`)
        }
        if (name === 'scope_read' || name === 'show') {
          const part = partOf(args.part)
          const q = questions.find((q) => q?.id === part)
          if (!['ask', 'plan', 'decisions', 'thread', 'questions', 'this'].includes(part) && !q) return fail(`There's no question ${args.part}.`)
          if (part === 'this') {
            const context = deps.getContext()
            const anchor = context.selection ?? context.inView
            return anchor ? result(`On screen, in ${sectionLabel(anchor.section)}: ${anchor.quote}`) : fail('Nothing is selected or on screen.')
          }
          if (name === 'show') return result(`Showing ${q ? `question ${Number(part.slice(1))}` : part}.`, show(part))
          let speech
          if (part === 'plan') {
            const text = plainText(scope.plan_md)
            const prior = cursors.get(part)
            const start = args.more === true && prior?.text === text ? prior.end : 0
            if (start >= text.length) speech = "That's the end of the plan."
            else {
              const chunk = planChunk(text, start)
              cursors.set(part, { text, end: chunk.end })
              speech = chunk.speech + (args.more === true && chunk.end === text.length ? " That's the end of the plan." : '')
            }
          } else if (q) {
            speech = [sentence(`Question ${Number(part.slice(1))}: ${q.text}`), q.recommendation ? sentence(`Recommended: ${q.recommendation}`) : '', q.why ? sentence(`Why: ${q.why}`) : '', q.status === 'answered' && q.answer ? sentence(`Answered: ${q.answer}`) : ''].filter(Boolean).join(' ')
          } else if (part === 'questions') speech = questionList()
          else if (part === 'ask') speech = list(scope.ask).map((a) => `You said: "${clean(a.quote)}"${a.date ? `, ${clean(a.date)}` : ''}.`).join('\n')
          else if (part === 'decisions') speech = list(scope.decisions).map((d) => sentence(`${d.id}: ${d.decision}`)).join('\n')
          else speech = list(scope.thread).slice(-6).map((n) => clean(n.text)).join('\n')
          return result(speech, show(part))
        }
        if (name === 'answer_question') {
          const q = questions.find((q) => q?.id === questionId(args.q))
          if (!q) return fail(`There's no question ${args.q}.`)
          if (args.take_recommendation === true && !q.recommendation) return fail('That question has no recommendation.')
          const spoken = typeof args.text === 'string' ? args.text.trim() : ''
          const text = args.take_recommendation === true ? `Take the recommendation: ${q.recommendation}${spoken ? ` ${spoken}` : ''}` : spoken
          if (!text) return fail("I didn't catch the note.")
          return send({ text, qid: q.id }, `Sent on question ${Number(q.id.slice(1))}.`, show(q.id))
        }
        if (name === 'thought' || name === 'comment') {
          const text = typeof args.text === 'string' ? args.text.trim() : ''
          if (!text) return fail("I didn't catch the note.")
          if (name === 'thought') return send({ text }, 'Sent.')
          const part = args.on === undefined ? 'this' : partOf(args.on)
          let anchor
          if (part === 'this') {
            const context = deps.getContext()
            anchor = normalizeAnchor(context.selection ?? context.inView)
            if (!anchor) return fail('Select some text or scroll to the part you mean, then say it again.')
          } else {
            if (part === 'thread') return fail('Say it as a thought instead.')
            const q = questions.find((q) => q?.id === part)
            const source = part === 'plan' ? plainText(scope.plan_md) : part === 'ask' ? list(scope.ask)[0]?.quote : part === 'decisions' ? list(scope.decisions)[0]?.decision : q?.text
            if (!source) return fail('That part has no text to comment on.')
            const plain = String(source).replace(/\s+/g, ' ').trim()
            let end = Math.min(120, plain.length)
            if (end < plain.length && plain[end] !== ' ') { const cut = plain.lastIndexOf(' ', end); if (cut > 0) end = cut }
            anchor = makeAnchor(q ? `q:${q.id}` : part, plain, 0, end)
            if (!anchor) return fail('That part has no text to comment on.')
          }
          return send({ text, anchor }, `Sent, on ${sectionLabel(anchor.section)}.`)
        }
        return fail('That voice tool is not available.')
      } catch (error) {
        return fail(`That didn't work: ${sentence(error?.message || 'Please try again')}`)
      }
    },
  }
}
