#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { answerLink, cut, eligible, fileAsk, log, origin, plainify, project, readEntry, register, watcher } from './lib.js'

// Claude treats stdout as a decision; every failure must leave it untouched.
const timer = setTimeout(() => process.exit(0), 3800)
try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (eligible(input)) {
    const source = await origin()
    const questions = input.tool_input?.questions
    if (!Array.isArray(questions) || !questions.length) throw new Error('missing questions')
    const fields = questions.map((q, i) => {
      if (!Array.isArray(q.options) || q.options.length < 2) throw new Error('not enough options')
      const slug = String(q.header || 'question').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      const name = `q${i}_${slug}`.slice(0, 48)
      const choices = q.options.map((o) => plainify(String(o.label).replace(/\s*\(Recommended\)$/i, '')))
      const recommended = q.options.findIndex((o) => /\s*\(Recommended\)$/i.test(o.label))
      const full = plainify(q.question)
      const label = cut(full, 120)
      const help = [label !== full ? full : '', ...q.options.map((o, n) => `${choices[n]}: ${plainify(o.description || '')}`)].filter(Boolean).join(' · ')
      return {
        name, type: 'choice', label, help: cut(help, 600),
        choices: choices.map((value) => ({ value, label: value })), multi: Boolean(q.multiSelect),
        recommend: recommended >= 0
          ? { value: choices[recommended], why: 'The agent marked this one as its recommendation.' }
          : { value: choices[0], why: 'The agent listed this first and did not mark a favourite.' },
      }
    })
    const workspace = source.workspace_name || project(input.cwd)
    const ask = {
      kind: 'file', purpose: 'decision', only_you: 'judgment', project: project(input.cwd),
      title: cut(plainify(questions.length === 1 ? questions[0].question : `Claude has ${questions.length} questions in ${workspace}`), 90),
      why: `Claude asked this in ${source.workspace_name || 'a herdr pane'} instead of guessing. It keeps working on anything that does not depend on the answer; your answer is typed into its pane.`,
      tried: ['Claude raised this in its question dialog instead of guessing; the dialog was routed here so it can keep working meanwhile.'],
      fields, ttl_seconds: 86400,
    }
    const { ticket } = await fileAsk(ask, source)
    const link = await answerLink(ticket)
    if (!readEntry(ticket)) {
      register(ticket, source.pane_id, 'question')
      watcher(ticket)
    }
    const reason = `Routed to unblock as ${ticket}; Alex answers at ${link}. Do not wait: keep doing any work that does not depend on the answer. The answer will be typed into this pane when it arrives; you can also collect it with unblock_check. If nothing else is left, end your turn saying you are waiting on ${ticket}.`
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  }
} catch { log('question hook failed open') }
clearTimeout(timer)
