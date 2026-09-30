import { orderThreads, anchorInSection, headingOf } from './scope-doc.js'

const object = (properties, required = []) => ({ type: 'OBJECT', properties, required })
const string = { type: 'STRING' }
export const SCOPE_VOICE_TOOLS = [
  { name: 'next_question', description: 'When asked for next, focus and read the next open thread.', parameters: object({}) },
  { name: 'previous_question', description: 'When asked for back, focus and read the previous open thread.', parameters: object({}) },
  { name: 'read_thread', description: 'When asked to read it, read the focused thread.', parameters: object({}) },
  { name: 'next_section', description: 'Move to the next document section.', parameters: object({}) },
  { name: 'previous_section', description: 'Move to the previous document section.', parameters: object({}) },
  { name: 'go_to_section', description: 'Move to a section named by its heading or id.', parameters: object({ name: string }, ['name']) },
  { name: 'show_resolved', description: 'Show or hide resolved threads when asked.', parameters: object({ on: { type: 'BOOLEAN' } }, ['on']) },
  { name: 'scroll', description: 'Scroll the document up or down when asked.', parameters: object({ direction: { type: 'STRING', enum: ['up', 'down'] } }, ['direction']) },
  { name: 'explain', description: 'Answer a question about what something means, why, how it works or the options. Reads context only; never writes.', parameters: object({ question: string }, ['question']) },
  { name: 'note_lane', description: 'Leave a quiet clarification note for the lane, never a comment from Alex.', parameters: object({ text: string }, ['text']) },
  { name: 'answer', description: 'His answer, decision or feedback on the focused thread, in his own words, filler removed. Never a question to you.', parameters: object({ text: string }, ['text']) },
  { name: 'take_recommendation', description: 'When he says take the recommendation or go with yours.', parameters: object({}) },
  { name: 'reject', description: 'When he says no, try again, or give me options about the recommendation.', parameters: object({ reason: string }) },
  { name: 'park', description: 'When he says not now about the focused question.', parameters: object({}) },
  { name: 'confirm', description: 'When he says yes to the proposed answer.', parameters: object({}) },
  { name: 'cancel', description: 'When he says no to the proposed answer.', parameters: object({}) },
  { name: 'resolve', description: 'When asked to resolve this, propose a decision or confirm the pending one.', parameters: object({ decision: string }) },
  { name: 'comment', description: 'Feedback he wants on the doc, or his yes to Want me to note that on the doc? Post on the selection or section.', parameters: object({ text: string }, ['text']) },
  { name: 'reply', description: 'Send his reply to the focused thread.', parameters: object({ text: string }, ['text']) },
  { name: 'set_speed', description: 'Change speaking speed immediately, without a read-back.', parameters: object({ speed: { type: 'NUMBER', description: 'Speaking speed multiplier, from 0.7 to 1.5.' }, change: { type: 'STRING', enum: ['faster', 'slower', 'normal'] } }) },
  { name: 'end_call', description: 'Finish the voice call when asked.', parameters: object({}) },
]

export const SCOPE_VOICE_KICKOFF = 'The call has started. Say "Ready." and nothing else, then wait for him.'
export const SCOPE_VOICE_PROMPT = `You are a quiet voice on a scoping doc written by a lane (an AI agent). Alex leads. Route intent, not focus.
Questions to you (what does X mean, explain, why, how would that work, what are the options): call explain, then answer aloud from its context in three sentences or fewer. If context does not cover it, say "I don't know from the doc." Never guess. Then ask once: "Want me to note that on the doc?" Call comment only on yes; no thanks writes nothing. If the answer shows the doc is unclear, you may note_lane: "Alex asked <X>; <section> should explain it." Do not note a point the doc already explains.
Feedback, decisions and answers to the doc's questions: answer on the focused thread (a comment gets a reply). Read its confirm line and wait: yes calls confirm; no calls cancel; changes call answer again. Explicit replies call reply. "Take the recommendation" or "go with yours" calls take_recommendation. "No", "I hate it", "try again" or "give me options" about a recommendation calls reject with any reason. "Do X instead" calls answer. "Not now" calls park. Doc feedback or "comment on this" calls comment. "Resolve this" calls resolve.
Unclear intent: ask exactly "Want that as a comment, or just an answer?" Write nothing.
"Next" or "what's next": next_question; "back" or "previous": previous_question; "read it": read_thread. Navigate with next_section, previous_section, go_to_section, scroll, show_resolved.
"Faster", "slower", "normal speed" or a speed number: set_speed at once, no read-back. Say tool speech as given, except explain supplies context for your spoken answer. Never read ids, links or tool names aloud or announce tool calls. On failure, say its speech once and wait. After end_call say nothing. Keep your own words under twelve, except spoken explanations.`

const clean = (value, stripIdentifiers = true) => {
  let text = String(value ?? '').replace(/https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|so|co|sh|me|us|uk)\b(?::\d+)?(?:\/\S*)?/gi, 'a link').replace(/\bT\d+\b/g, '')
  if (stripIdentifiers) text = text.replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi, '')
  return text.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim()
}
const cut = (value, limit, stripIdentifiers = true) => {
  const words = clean(value, stripIdentifiers).split(/\s+/).filter(Boolean)
  return words.slice(0, limit).join(' ') + (words.length > limit ? '…' : '')
}
const sentence = (value) => { const text = clean(value); return text ? text + (/[.?!]$/.test(text) ? '' : '.') : '' }
const result = (speech, ui) => ({ ok: true, speech: clean(speech), ...(ui ? { ui } : {}) })
const fail = (speech) => ({ ok: false, speech: clean(speech) })
const textOf = (value) => typeof value === 'string' ? value.trim() : ''

export function createScopeVoiceSession(deps) {
  let pending = null
  return {
    async handle(name, args = {}) {
      const proposal = pending
      if (name !== 'confirm' && name !== 'set_speed') pending = null
      let scope, context, thread, postedThread, wrote = false
      const run = async () => {
        try {
          ;({ scope } = await deps.getScope())
          context = deps.getContext()
          thread = scope.threads.find((item) => item.id === context.thread)
          const sections = scope.doc.sections
          const send = async (post, speech) => {
            try { const posted = await post(); postedThread = posted?.thread?.id; wrote = true; return result(speech) }
            catch (error) { return fail(`That didn't send: ${cut(error?.message || 'Please try again', 9)}`) }
          }
          const confirm = async () => {
            if (!proposal) return fail('Nothing to confirm.')
            pending = proposal
            const sent = await send(() => deps.postResolve(proposal.thread, { decision: proposal.text, alex_words: proposal.text, how: proposal.how, via: 'voice' }), 'Resolved.')
            if (sent.ok) pending = null
            return sent
          }
          const propose = (text) => {
            if (!text) return fail("I didn't catch that.")
            if (!thread) return fail('Which one? Say next question.')
            if (thread.status === 'parked') return fail('That one is parked for later.')
            if (thread.status !== 'open') return fail('That one is already resolved.')
            pending = { thread: thread.id, text, how: thread.kind === 'comment' ? 'resolve' : 'own' }
            const spoken = cut(text, 8, false)
            return { ok: true, speech: `Resolve this as: ${spoken}${/[.?!…]$/.test(spoken) ? '' : '.'} Yes?` }
          }
          const answer = (text) => {
            if (!text) return fail("I didn't catch that.")
            if (!thread) return fail('Which one? Say next question.')
            if (thread.kind === 'comment') return send(() => deps.postReply(thread.id, { text, via: 'voice' }), 'Sent.')
            return propose(text)
          }
          if (name === 'explain') {
            const question = textOf(args.question)
            if (!question) return fail("I didn't catch that.")
            const briefThread = (item) => [
              `Thread (${item.kind}, ${item.status}): ${item.messages[0]?.text || ''}`,
              item.recommendation && `Recommendation: ${item.recommendation}`,
              item.options?.length && `Options: ${item.options.join('; ')}`,
              item.why && `Why: ${item.why}`,
              ...item.messages.slice(-2).map(message => `${message.from}: ${message.text}`),
            ].filter(Boolean).join('\n')
            const parts = [thread && `Focused thread:\n${briefThread(thread)}`,
              ...sections.map(section => `${section.heading}\n${section.body_md.replace(/^[ \t]*```[^\n]*\n[\s\S]*?(?:^[ \t]*```[^\n]*(?:\n|$)|$(?![\s\S]))/gm, '')}`),
              ...scope.threads.map(briefThread)].filter(Boolean)
            let timer
            try {
              const extra = await Promise.race([
                Promise.resolve().then(() => deps.fetchContext?.(question)),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000) }),
              ])
              if (extra?.brief) parts.push(`BRIEF: ${extra.brief}`)
              if (extra?.said?.length) parts.push(`Alex said:\n${extra.said.map(item => `${item.at_et} (${item.source}): ${item.text}`).join('\n')}`)
            } catch { /* Extra context is best-effort; the doc is still available. */ }
            finally { clearTimeout(timer) }
            return { ok: true, speech: '', context: parts.join('\n\n').slice(0, 12000) }
          }
          if (name === 'note_lane') {
            const text = textOf(args.text)
            if (!text) return fail("I didn't catch that.")
            return send(() => deps.postLaneNote({ text, via: 'voice' }), 'Noted for the lane.')
          }
          if (name === 'set_speed') {
            if (deps.getProvider?.() === 'gemini') return fail('I can only change speed on Grok.')
            if (typeof args.speed === 'number' && Number.isFinite(args.speed)) return result('Okay.', { do: 'speed', value: Math.round(Math.max(0.7, Math.min(1.5, args.speed)) * 10) / 10 })
            if (['faster', 'slower', 'normal'].includes(args.change)) return result('Okay.', { do: 'speed', change: args.change })
            return fail('Say faster, slower, or a number.')
          }
          if (name === 'end_call') return result('Talk soon.', { do: 'end_call' })
          if (name === 'confirm') return confirm()
          if (name === 'cancel') return result('Okay, left open.')
          if (name === 'next_question' || name === 'previous_question') {
            const ordered = orderThreads(scope)
            const open = ordered.filter((item) => item.status === 'open')
            const forward = name === 'next_question'
            let target
            if (!thread) target = forward ? open[0] : open.at(-1)
            else if (thread.status === 'open') target = open[open.findIndex((item) => item.id === thread.id) + (forward ? 1 : -1)]
            else {
              const docOrder = orderThreads({ ...scope, threads: scope.threads.map((item) => ({ ...item, status: 'open' })) })
              const index = docOrder.findIndex((item) => item.id === thread.id)
              const isOpen = (item) => open.some((candidate) => candidate.id === item.id)
              target = forward ? docOrder.slice(index + 1).find(isOpen) : docOrder.slice(0, index).reverse().find(isOpen)
            }
            return target ? result(target.messages[0]?.text || '', { do: 'focus_thread', thread: target.id }) : fail(forward ? "That's the last open one." : "That's the first open one.")
          }
          if (name === 'read_thread') {
            if (!thread) return fail('Which one? Say next question.')
            const speech = [sentence(thread.messages[0]?.text)]
            if (thread.recommendation) speech.push(sentence(`I'd suggest: ${thread.recommendation}`))
            if (thread.why) speech.push(sentence(`Because: ${thread.why}`))
            for (const message of thread.messages.slice(1).slice(-2)) speech.push(sentence(`${message.from === 'alex' ? 'You' : 'The lane'} said: ${message.text}`))
            if (thread.status === 'resolved') speech.push(sentence(`Resolved as: ${thread.resolution?.decision || 'Resolved'}`))
            return result(speech.filter(Boolean).join(' '))
          }
          if (['next_section', 'previous_section', 'go_to_section'].includes(name)) {
            let section
            if (name === 'go_to_section') {
              const requested = textOf(args.name).toLowerCase()
              if (requested) section = sections.find((item) => item.id.toLowerCase() === requested) || sections.find((item) => item.heading.toLowerCase().includes(requested))
            } else {
              const index = sections.findIndex((item) => item.id === context.section)
              section = sections[index + (name === 'next_section' ? 1 : -1)]
            }
            return section ? result(headingOf(scope, section.id), { do: 'focus_section', section: section.id }) : fail('No section there.')
          }
          if (name === 'show_resolved') {
            if (typeof args.on !== 'boolean') return fail("I can't do that here.")
            return result(args.on ? 'Showing resolved.' : 'Hiding resolved.', { do: 'show_resolved', on: args.on })
          }
          if (name === 'scroll') {
            if (!['up', 'down'].includes(args.direction)) return fail("I can't do that here.")
            return result('Okay.', { do: 'scroll', direction: args.direction })
          }
          if (name === 'answer') return answer(textOf(args.text))
          if (name === 'take_recommendation') {
            if (!thread) return fail('Which one? Say next question.')
            if (thread.kind !== 'question' || thread.status !== 'open' || !thread.recommendation) return fail('That question has no open recommendation.')
            return send(() => deps.postResolve(thread.id, { decision: thread.recommendation, alex_words: 'Take the recommendation', how: 'take', via: 'voice' }), 'Done. Took the recommendation.')
          }
          if (name === 'reject') {
            if (!thread || thread.kind !== 'question' || thread.status !== 'open' || !thread.recommendation) return fail('Nothing to say no to here.')
            return send(() => deps.postReject(thread.id, { text: textOf(args.reason), via: 'voice' }), 'Sent. Waiting for a new option.')
          }
          if (name === 'park') {
            if (!thread || thread.kind !== 'question' || thread.status !== 'open') return fail('No open question here.')
            return send(() => deps.postPark(thread.id, { via: 'voice' }), 'Parked for later.')
          }
          if (name === 'resolve') {
            const decision = textOf(args.decision)
            if (decision) return propose(decision)
            if (proposal) return confirm()
            if (!thread) return fail('Which one? Say next question.')
            if (thread.kind === 'comment' && thread.status === 'open') return send(() => deps.postResolve(thread.id, { decision: 'Resolved', alex_words: 'Resolved', how: 'resolve', via: 'voice' }), 'Resolved.')
            return fail('Resolve it as what?')
          }
          if (name === 'reply' || name === 'comment') {
            const text = textOf(args.text)
            if (!text) return fail("I didn't catch that.")
            if (name === 'reply') {
              if (!thread) return fail('Which one? Say next question.')
              return send(() => deps.postReply(thread.id, { text, via: 'voice' }), 'Sent.')
            }
            const section = sections.find((item) => item.id === context.section) || sections.find((item) => item.id === 'title') || sections[0]
            const anchor = context.selection || (section && anchorInSection(section, section.heading))
            if (!anchor) return fail('Select some text first.')
            return send(() => deps.postThread({ anchor, text, via: 'voice' }), 'Posted.')
          }
          return fail("I can't do that here.")
        } catch (error) {
          return fail(`That didn't work: ${cut(error?.message || 'Please try again', 9)}`)
        }
      }
      const outcome = await run()
      const quote = (text) => { const words = String(text || '').trim().split(/\s+/); return words.slice(0, 10).join(' ') + (words.length > 10 ? '…' : '') }
      let id, label
      const section = scope?.doc.sections.find(item => item.id === outcome.ui?.section)
      if (!outcome.ok) label = `Not done: ${outcome.speech}`
      else if (name === 'set_speed') label = outcome.ui.value !== undefined ? `Speed ${outcome.ui.value.toFixed(1)}×` : ({ faster: 'Faster', slower: 'Slower', normal: 'Normal speed' })[outcome.ui.change]
      else if (outcome.ui?.do === 'focus_thread') { id = outcome.ui.thread; label = `${name === 'next_question' ? 'Next' : 'Previous'} question: ${id}` }
      else if (section) label = `Went to §${section.heading}`
      else if (name === 'show_resolved') label = args.on ? 'Showing resolved' : 'Hiding resolved'
      else if (name === 'scroll') label = `Scrolled ${args.direction}`
      else if (name === 'end_call') label = 'Ended the call'
      else if (name === 'explain') label = `Answered: "${quote(args.question)}"`
      else if (name === 'note_lane') label = 'Noted for the lane'
      else {
        id = postedThread || (name === 'confirm' || name === 'cancel' || name === 'resolve' && proposal ? proposal?.thread : thread?.id)
        if (name === 'read_thread') label = `Read ${id} aloud`
        else if (name === 'cancel') label = 'Dropped the proposal'
        else if (name === 'answer' && !wrote || name === 'resolve' && textOf(args.decision)) label = `Proposed for ${id}: "${quote(args.text || args.decision)}"`
        else if (name === 'confirm' || name === 'resolve' && proposal) label = `Resolved ${id}: "${quote(proposal.text)}"`
        else if (name === 'take_recommendation') label = `Took the recommendation on ${id}`
        else if (name === 'reject') label = `Said No on ${id}${textOf(args.reason) ? ': "' + quote(args.reason) + '"' : ''}`
        else if (name === 'park') label = `Parked ${id}`
        else if (name === 'resolve') label = `Resolved ${id}`
        else if (name === 'comment') { const anchorSection = context.selection?.section || context.section; const heading = scope.doc.sections.find(item => item.id === anchorSection) || scope.doc.sections.find(item => item.id === 'title') || scope.doc.sections[0]; label = `Commented on §${heading.heading} (${id})` }
        else label = `Replied on ${id}`
      }
      try { deps.onFeed?.({ tool: name, label, ok: outcome.ok, write: outcome.ok && wrote, ...(id ? { thread: id } : {}) }) } catch { /* The feed never changes the tool result. */ }
      return outcome
    },
  }
}
