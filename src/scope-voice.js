import { orderThreads, anchorInSection, headingOf } from './scope-doc.js'

const object = (properties, required = []) => ({ type: 'OBJECT', properties, required })
const string = { type: 'STRING' }
export const SCOPE_VOICE_TOOLS = [
  { name: 'next_question', description: 'When asked for next, focus and read the next open comment.', parameters: object({}) },
  { name: 'previous_question', description: 'When asked for back, focus and read the previous open comment.', parameters: object({}) },
  { name: 'read_thread', description: 'When asked to read it, read the focused comment.', parameters: object({}) },
  { name: 'next_section', description: 'Move to the next document section.', parameters: object({}) },
  { name: 'previous_section', description: 'Move to the previous document section.', parameters: object({}) },
  { name: 'go_to_section', description: 'Move to a section named by its heading or id.', parameters: object({ name: string }, ['name']) },
  { name: 'show_resolved', description: 'Show or hide resolved comments when asked.', parameters: object({ on: { type: 'BOOLEAN' } }, ['on']) },
  { name: 'scroll', description: 'Scroll the document up or down when asked.', parameters: object({ direction: { type: 'STRING', enum: ['up', 'down'] } }, ['direction']) },
  { name: 'explain', description: 'Answer a question about what something means, why, how it works or the options. Reads context only; never writes.', parameters: object({ question: string }, ['question']) },
  { name: 'note_lane', description: 'Leave a quiet clarification note for the lane, never a comment from Alex.', parameters: object({ text: string }, ['text']) },
  { name: 'answer', description: 'His answer, decision or feedback on the focused comment, in his own words, filler removed. Never a question to you.', parameters: object({ text: string }, ['text']) },
  { name: 'take_recommendation', description: 'When he says take the recommendation or go with yours.', parameters: object({}) },
  { name: 'reject', description: 'When he says no, try again, or give me options about the recommendation.', parameters: object({ reason: string }) },
  { name: 'park', description: 'When he says not now about the focused question.', parameters: object({}) },
  { name: 'confirm', description: 'When he says yes to the proposed answer.', parameters: object({}) },
  { name: 'cancel', description: 'When he says no to the proposed answer.', parameters: object({}) },
  { name: 'resolve', description: 'When asked to resolve this, propose a decision or confirm the pending one.', parameters: object({ decision: string }) },
  { name: 'comment', description: 'Propose a comment on the selection or section in his own words, fillers out, never a summary. Read back and wait for yes.', parameters: object({ text: string }, ['text']) },
  { name: 'reply', description: 'Propose a reply to the focused comment in his own words, fillers out, never a summary. Read back and wait for yes.', parameters: object({ text: string }, ['text']) },
  { name: 'approve_scope', description: 'When he approves the scope (approve it, ship it, move to build) or says not yet. Read back and wait for yes.', parameters: object({ mode: { type: 'STRING', enum: ['approve', 'approve_with_changes', 'not_yet'] }, note: string }, ['mode']) },
  { name: 'set_speed', description: 'Change speaking speed immediately, without a read-back.', parameters: object({ speed: { type: 'NUMBER', description: 'Speaking speed multiplier, from 0.7 to 1.5.' }, change: { type: 'STRING', enum: ['faster', 'slower', 'normal'] } }) },
  { name: 'end_call', description: 'Finish the voice call when asked.', parameters: object({}) },
]

export const SCOPE_VOICE_KICKOFF = 'The call has started. Say "Ready." and nothing else, then wait for him.'
export const SCOPE_VOICE_PROMPT = `You are a quiet voice on a scoping doc written by a lane (an AI agent). Alex leads. Route intent, not focus.
Questions to you (what does X mean, explain, why, how would that work, what are the options): call explain, then answer aloud from its context in three sentences or fewer. If context does not cover it, say "I don't know from the doc." Never guess. If the point is worth keeping on the doc, call comment: its read-back is the offer. Otherwise stop. If the answer shows the doc is unclear, you may note_lane: "Alex asked <X>; <section> should explain it." Do not note a point the doc already explains.
"This", "here" or "that" in his question means the Looking at block and Selected text first.
Feedback, decisions and answers to the doc's questions: answer on the focused comment (a comment gets a reply). Read its confirm line and wait: yes calls confirm; no calls cancel; changes call answer again. Explicit replies call reply. "Take the recommendation" or "go with yours" calls take_recommendation. "No", "I hate it", "try again" or "give me options" about a recommendation calls reject with any reason. "Do X instead" calls answer. "Not now" calls park. Doc feedback or "comment on this" calls comment. "Resolve this" calls resolve.
Wait until he finishes a thought before calling a writing tool. Pass his own words; never paraphrase. Comment and reply read back; wait for his yes, then call confirm.
When he approves the scope or says not yet, use approve_scope; it reads back first.
Unclear intent: ask exactly "Want that as a comment, or just an answer?" Write nothing.
"Next" or "what's next": next_question; "back" or "previous": previous_question; "read it": read_thread. Navigate with next_section, previous_section, go_to_section, scroll, show_resolved.
"Faster", "slower", "normal speed" or a speed number: set_speed at once, no read-back. Say tool speech as given, except explain supplies context for your spoken answer. Never read ids, links or tool names aloud or announce tool calls. On failure, say its speech once and wait. After end_call say nothing. Keep your own words under twelve, except spoken explanations.`

const clean = (value, stripIdentifiers = true) => {
  let text = String(value ?? '').replace(/https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|so|co|sh|me|us|uk)\b(?::\d+)?(?:\/\S*)?/gi, 'a link').replace(/\b(?:(?:[Tt][Hh][Rr][Ee][Aa][Dd][Ss]?|[Qq][Uu][Ee][Ss][Tt][Ii][Oo][Nn][Ss]?|[Cc][Oo][Mm][Mm][Ee][Nn][Tt][Ss]?)\s+)?T\d+\b(?:\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)T\d+\b)*/g, (ids) => (ids.match(/T\d+/g)?.length || 0) > 1 ? 'those' : 'that one')
    .replace(/(?:\b[Ss][Ee][Cc][Tt][Ii][Oo][Nn]\s+)?§[\w-]+/g, 'that section')
    .replace(/(^|[.!?]\s+|["“'(]\s*)(that one|those|that section)\b/g, (_, prefix, phrase) => prefix + phrase[0].toUpperCase() + phrase.slice(1))
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

const words = (value) => {
  let text = textOf(value).replace(/\b(?:um|uh|erm|er|uhm|hmm)(?=[,.?!\s]|$),?/gi, '').trim()
  while (/^(?:(?:so|yeah|okay|ok|well|you know|I mean)(?=[,.?!\s]|$)|(?:like|right)(?=,)),?\s*/i.test(text)) text = text.replace(/^(?:(?:so|yeah|okay|ok|well|you know|I mean)(?=[,.?!\s]|$)|(?:like|right)(?=,)),?\s*/i, '')
  text = text.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1').replace(/\s+/g, ' ').trim()
  return text ? text[0].toUpperCase() + text.slice(1) + (/[.?!]$/.test(text) ? '' : '.') : ''
}
const unfinished = (text) => /(?:…\.?|\.\.\.|[,—-]\.?)$/.test(text) || !/[?!]$/.test(text) && /\b(?:a|an|the|and|or|but|to|of|on|in|at|for|with|about|from|by|into|than|because|if|like|as|my|your|our|their)\.?$/i.test(text)
const norm = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean).join(' ')
const filingQuote = (text, limit = 10) => { const parts = text.split(/\s+/); return parts.slice(0, limit).join(' ') + (parts.length > limit ? '…' : '') }

export function createScopeVoiceSession(deps) {
  let pending = null
  let hasTranscripts = false
  let filed = []
  const now = () => deps.now?.() ?? Date.now()
  const duplicate = (pool, text) => {
    const at = now(), next = new Set(norm(text).split(' '))
    filed = filed.filter(item => at - item.at <= 10000)
    return filed.some(item => {
      if (item.pool !== pool) return false
      const prior = new Set(item.norm.split(' ')), union = new Set([...prior, ...next])
      const intersection = [...next].filter(word => prior.has(word)).length
      return union.size > 0 && intersection / union.size >= 0.75
    })
  }
  return {
    assistantSaid(text) {
      if (!textOf(text)) return
      hasTranscripts = true
      if (!pending || !['comment', 'reply'].includes(pending.kind)) return
      pending.said = `${pending.said} ${text}`
      const expected = norm(pending.readback).split(' ').slice(0, 4).join(' ') || (pending.kind === 'comment' ? 'file it' : 'send it')
      if (` ${norm(pending.said)} `.includes(` ${expected} `)) pending.heard = true
    },
    async handle(name, args = {}) {
      const proposal = pending
      if (name !== 'confirm' && name !== 'set_speed') pending = null
      let scope, context, thread, postedThread, filingLabel, filingThread, wrote = false
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
          const already = (pool, text, id) => {
            filingLabel = `Already filed: "${filingQuote(text)}"`
            filingThread = id
            return result(pool === 'doc' ? 'Already on the doc.' : 'Already noted.')
          }
          const file = async (pool, text, id, post, speech) => {
            if (duplicate(pool, text)) return already(pool, text, id)
            const sent = await send(post, speech)
            if (sent.ok) filed.push({ pool, ...(id || postedThread ? { thread: id || postedThread } : {}), norm: norm(text), at: now() })
            return sent
          }
          const proposeFiling = (kind, text, target) => {
            text = words(text)
            if (!text) return fail("I didn't catch that.")
            if (unfinished(text)) { filingLabel = 'Waiting for the rest'; return fail('Go on.') }
            if (duplicate('doc', text)) return already('doc', text, kind === 'reply' ? target : undefined)
            const readback = clean(filingQuote(text, 20), false)
              .replace(/\b[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+\b/gu, identifier => identifier.replace(/_/g, ' '))
              .replace(/\b[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+){2,}\b/gu, identifier => identifier.replace(/-/g, ' '))
              .replace(/^([\p{L}\p{N}]+-[\p{L}\p{N}]+)([.?!]?)$/u, (_, identifier, punctuation) => identifier.replace(/-/g, ' ') + punctuation)
            const speech = result(`${kind === 'comment' ? 'Comment' : 'Reply'}: "${readback}" ${kind === 'comment' ? 'File it?' : 'Send it?'}`).speech
            pending = { kind, text, readback, speech, heard: false, said: '', ...(kind === 'reply' ? { thread: target } : { anchor: target }) }
            filingThread = pending.thread
            filingLabel = kind === 'comment' ? `Proposed comment: "${filingQuote(text)}"` : `Proposed reply on ${target}: "${filingQuote(text)}"`
            return result(speech)
          }
          const confirm = async () => {
            if (!proposal) return fail('Nothing to confirm.')
            pending = proposal
            if (hasTranscripts && ['comment', 'reply'].includes(proposal.kind) && !proposal.heard) return fail(`First, the ${proposal.kind}: "${proposal.readback}" ${proposal.kind === 'comment' ? 'File it?' : 'Send it?'}`)
            let sent
            if (proposal.kind === 'approve') {
              sent = await send(() => deps.postApprove({ mode: proposal.mode, comment: proposal.note ?? '', via: 'voice', client_id: proposal.client_id }), ({ approve: 'Approved. The lane moves to build.', approve_with_changes: 'Approved with changes.', not_yet: 'Sent. The lane keeps scoping.' })[proposal.mode])
              if (sent.ok) filingLabel = ({ approve: 'Approved the scope', approve_with_changes: 'Approved with changes', not_yet: 'Sent: not yet' })[proposal.mode]
            }
            else if (proposal.kind === 'comment') sent = await file('doc', proposal.text, undefined, () => deps.postThread({ anchor: proposal.anchor, text: proposal.text, via: 'voice' }), 'Posted.')
            else if (proposal.kind === 'reply') sent = await file('doc', proposal.text, proposal.thread, () => deps.postReply(proposal.thread, { text: proposal.text, via: 'voice' }), 'Sent.')
            else sent = await send(() => deps.postResolve(proposal.thread, { decision: proposal.text, alex_words: proposal.text, how: proposal.how, via: 'voice' }), 'Resolved.')
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
            if (thread.kind === 'comment') return proposeFiling('reply', text, thread.id)
            return propose(text)
          }
          if (name === 'explain') {
            const question = textOf(args.question)
            if (!question) return fail("I didn't catch that.")
            const briefThread = (item) => [
              `Comment (${item.kind}, ${item.status}): ${item.messages[0]?.text || ''}`,
              item.recommendation && `Recommendation: ${item.recommendation}`,
              item.options?.length && `Options: ${item.options.join('; ')}`,
              item.why && `Why: ${item.why}`,
              ...item.messages.slice(-2).map(message => `${message.from}: ${message.text}`),
            ].filter(Boolean).join('\n')
            context = deps.getContext()
            thread = scope.threads.find(item => item.id === context.thread)
            const lookingAt = sections.find(section => section.id === context.section)
            const bodyOf = section => section.body_md.replace(/^[ \t]*```[^\n]*\n[\s\S]*?(?:^[ \t]*```[^\n]*(?:\n|$)|$(?![\s\S]))/gm, '')
            const looking = [
              lookingAt && `Looking at: ${lookingAt.heading}\n${bodyOf(lookingAt).slice(0, 6000)}`,
              context.selection && `Selected text: "${context.selection.quote}"`,
            ].filter(Boolean).join('\n')
            const parts = [looking, thread && `Focused comment:\n${briefThread(thread)}`,
              ...sections.filter(section => section !== lookingAt).map(section => `${section.heading}\n${bodyOf(section)}`),
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
            const text = words(args.text)
            if (!text) return fail("I didn't catch that.")
            return file('lane', text, undefined, () => deps.postLaneNote({ text, via: 'voice' }), 'Noted for the lane.')
          }
          if (name === 'approve_scope') {
            const mode = args.mode, note = words(args.note)
            if (!['approve', 'approve_with_changes', 'not_yet'].includes(mode)) return fail("I can't do that here.")
            if (['approve', 'approve_with_changes'].includes(scope.approval?.mode)) return fail('This scope is already approved.')
            if (scope.approval?.mode === 'approve_to_try') return fail('This scope is approved to try. Press Ship it when the build is ready.')
            if (!deps.postApprove) return fail("I can't approve from here. Use the Approve button.")
            if (unfinished(note)) { filingLabel = 'Waiting for the rest'; return fail('Go on.') }
            if (!note && mode === 'approve_with_changes') return fail('What should the lane change first?')
            if (!note && mode === 'not_yet') return fail("What's missing?")
            pending = { kind: 'approve', mode, note, client_id: crypto.randomUUID() }
            filingLabel = 'Proposed approval'
            if (mode === 'approve_with_changes') return result(`Approve with changes: "${note}" The lane folds it in, then builds. Send it?`)
            if (mode === 'not_yet') return result(`Not yet: "${note}" Send it?`)
            const count = scope.threads.filter(item => item.status === 'open').length
            return result(`Approve this scope and move to build?${count ? count === 1 ? " 1 open question closes with the lane's recommendation." : ` ${count} open questions close with the lane's recommendations.` : ''}${note ? ` Your note: "${note}"` : ''}`)
          }
          if (name === 'set_speed') {
            if (['gemini', 'live'].includes(deps.getProvider?.())) return fail('I can only change speed on GPT Realtime or Grok.')
            if (typeof args.speed === 'number' && Number.isFinite(args.speed)) return result('Okay.', { do: 'speed', value: Math.round(Math.max(0.7, Math.min(1.5, args.speed)) * 10) / 10 })
            if (['faster', 'slower', 'normal'].includes(args.change)) return result('Okay.', { do: 'speed', change: args.change })
            return fail('Say faster, slower, or a number.')
          }
          if (name === 'end_call') return result('Talk soon.', { do: 'end_call' })
          if (name === 'confirm') return confirm()
          if (name === 'cancel') return result(proposal?.kind ? 'Okay, dropped.' : 'Okay, left open.')
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
            if (thread.status !== 'open' || !thread.recommendation) return fail('That comment has no open recommendation.')
            return send(() => deps.postResolve(thread.id, { decision: thread.recommendation, alex_words: 'Take the recommendation', how: 'take', via: 'voice' }), 'Done. Took the recommendation.')
          }
          if (name === 'reject') {
            if (!thread || thread.status !== 'open' || !thread.recommendation) return fail('Nothing to say no to here.')
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
              return proposeFiling('reply', text, thread.id)
            }
            const section = sections.find((item) => item.id === context.section) || sections.find((item) => item.id === 'title') || sections[0]
            const anchor = context.selection || (section && anchorInSection(section, section.heading))
            if (!anchor) return fail('Select some text first.')
            return proposeFiling('comment', text, anchor)
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
      if (filingLabel) { label = filingLabel; id = filingThread }
      else if (!outcome.ok) label = `Not done: ${outcome.speech}`
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
        else if ((name === 'confirm' || name === 'resolve' && proposal) && proposal?.kind === 'comment') { const heading = scope.doc.sections.find(item => item.id === proposal.anchor.section); label = `Commented on §${heading?.heading ?? proposal.anchor.section} (${id})` }
        else if ((name === 'confirm' || name === 'resolve' && proposal) && proposal?.kind === 'reply') label = `Replied on ${id}`
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
