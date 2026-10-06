import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { kindOf } from './doc-kinds.js'
import { headingOf, sectionHash, MODEL_ALIAS } from './scope-doc.js'
import { remoteScopeHost, scopePostCommand } from './pane-notice.js'
import { quoteSnippet } from './scope-anchor.js'

const PANE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,80}$/
const DROP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
const ROLE = 'You answer Alex\'s margin questions about an explainer doc. Answer in plain short prose: two to five sentences, no headings, and a short list only when you name three or more parallel things. Lead with the direct answer. Cite file:line or the URL for every claim you take from a source. Read the sources before answering when the doc alone does not settle it. If the answer needs a decision or new work from the doc\'s owner, end with one line `NEEDS_OWNER: <why>`.'

// A scope doc's responder answers one margin comment in its own run, so a busy lane never holds it.
// It may rewrite the one section the comment sits on; restructures and open calls stay with the lane.
const SCOPE_ROLE = 'You answer one of Alex\'s margin comments on a scoping doc, on behalf of the lane that owns the doc. The lane is busy; you run in parallel with it and with other responders, so answer this comment only. Reply in plain short prose: one to four sentences, no headings. Lead with the direct answer. Read the scope folder (ALEX-WORDS.md, ALEX-FEED.md, RESUME.md, facts/) when the doc alone does not settle it. Treat a comment as a reply or a question, never a decision. If the comment asks for a change to the section it sits on and you are sure what he wants, make it: after your reply, write a line `EDIT <section-id>`, then the whole new section starting with its `## Heading {#id}` line, then a line `END_EDIT`. Change only what the comment asks; keep the rest of the section word for word. Plain words, short sentences, no em dashes, no semicolons. If the comment needs a restructure, a new mock, research longer than a few reads, or a call only the lane can make, say in one sentence what the lane will do and end with one line `NEEDS_OWNER: <why>`.'
const isScope = (scope) => kindOf(scope) === 'scope'

const compact = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const positiveInt = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback }

function docMarkdown(scope) {
  const parts = [`# ${scope.title ?? ''}`]
  for (const section of scope.doc?.sections ?? []) parts.push(`## ${section.heading}\n${section.body_md ?? ''}`)
  let doc = parts.join('\n\n')
  if (doc.length > 60000) doc = `${doc.slice(0, 59999)}…`
  return doc
}

function otherThreads(scope, thread) {
  const lines = []
  for (const other of scope.threads ?? []) {
    if (other.id === thread.id) continue
    const said = (other.messages ?? []).filter((message) => !message.pending).slice(-3)
      .map((message) => `${message.from === 'alex' ? 'Alex' : 'Lane'}: ${compact(message.text).slice(0, 300)}`)
    const decided = other.resolution?.decision ? ` -> ${compact(other.resolution.decision).slice(0, 200)}` : ''
    lines.push(`${other.id} [${other.status}] §${other.anchor?.section ?? 'title'} "${quoteSnippet(other.anchor?.quote ?? '', 60)}"${decided}`, ...said.map((line) => `  ${line}`))
  }
  return lines
}

function promptFor(scope, thread, scopeDir) {
  const sources = Array.isArray(scope.sources) ? scope.sources : []
  const quote = thread.anchor?.general ? '(whole doc)' : (thread.anchor?.quote ?? '')
  const said = []
  for (const message of thread.messages ?? []) {
    if (message.pending) continue
    said.push(`${message.from === 'alex' ? 'Alex' : 'You'}: ${message.text}`)
  }
  if (isScope(scope)) {
    // The stable part (role, doc, other comments) comes first so the prompt cache covers it across comments.
    return [
      SCOPE_ROLE, '', `Scope folder: ${scopeDir}`, ...(sources.length ? ['Source dirs:', ...sources] : []), '',
      `# Doc (revision ${scope.revision})`, docMarkdown(scope), '', '# Other comments', ...otherThreads(scope, thread), '',
      `# This comment (${thread.id}, section id: ${thread.anchor?.section ?? 'title'})`,
      headingOf(scope, thread.anchor?.section ?? 'title'), quote, ...said, '', 'Answer Alex\'s last message.', '',
    ].join('\n')
  }
  return [
    ROLE, '', 'Source dirs:', ...sources, '', '# Doc', docMarkdown(scope), '', '# Comment',
    headingOf(scope, thread.anchor?.section ?? 'title'), quote, ...said, '', 'Answer Alex\'s last message.', '',
  ].join('\n')
}

function takeAnswer(raw) {
  let trimmed = String(raw ?? '').replace(/\s+$/, '')
  let edit = null
  const block = trimmed.match(/(?:^|\n)EDIT ([A-Za-z0-9_-]+)\n([\s\S]*?)\nEND_EDIT[ \t]*(?=\n|$)/)
  if (block) {
    edit = { id: block[1], markdown: block[2].trim() }
    trimmed = (trimmed.slice(0, block.index) + trimmed.slice(block.index + block[0].length)).replace(/\s+$/, '')
  }
  const answer = takeText(trimmed)
  return edit ? { ...answer, edit } : answer
}

function takeText(trimmed) {
  const match = trimmed.match(/(?:^|\n)NEEDS_OWNER:\s*(.*)$/)
  const body = (match ? trimmed.slice(0, match.index) : trimmed).trim()
  if (!body) return { text: '(no answer)', needs_owner: true, why: match ? match[1].trim() : 'no answer' }
  return match ? { text: body, needs_owner: true, why: match[1].trim() } : { text: body, needs_owner: false }
}

function postLine(scope, thread, outcome) {
  const quote = thread.anchor?.general ? '(whole doc)' : quoteSnippet(thread.anchor?.quote ?? '', 60)
  const question = [...(thread.messages ?? [])].reverse().find((message) => message.from === 'alex' && !message.pending)?.text ?? ''
  const task = outcome.needs_owner || outcome.handoff
  const why = outcome.why || (outcome.reason === 'timeout' ? 'timed out' : 'failed')
  const suffix = !task ? '' : isScope(scope)
    ? ` NEEDS YOU: ${why}. Reply in the comment: unblock scope reply ${scope.slug} ${thread.id} "<text>"; edit the doc: unblock scope patch ${scope.slug} <section> --from <file.md>`
    : ` NEEDS YOU: ${why}. Reply in the comment: unblock scope reply ${scope.slug} ${thread.id} "<text>"; fold into the doc: unblock explain doc ${scope.slug} --from <file.md>`
  let q = compact(question)
  let answer = compact(outcome.text)
  const edited = outcome.edited ? ` (edited §${outcome.edited})` : ''
  const head = () => `[${isScope(scope) ? 'scoping' : 'explainer'} ${scope.slug}]${isScope(scope) ? ' responder' : ''} ${thread.id} on §${headingOf(scope, thread.anchor?.section ?? 'title')} "${quote}": Q: ${q} A: `
  let room = 700 - head().length - suffix.length - edited.length
  if (answer.length > Math.max(0, room)) answer = room > 1 ? `${answer.slice(0, room - 1)}…` : ''
  room = 700 - head().length - suffix.length - edited.length
  if (room < 0) {
    q = q.slice(0, Math.max(0, q.length + room - 1))
    if (q) q += '…'
    answer = ''
  }
  let line = `${head()}${answer}${edited}${suffix}`
  if (line.length > 700) line = `${line.slice(0, 699)}…`
  return { line, task }
}

function killGroup(child) {
  const pid = child?.pid
  if (!pid) return
  try { process.kill(-pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  const timer = setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }, 2000)
  timer.unref()
  child.once('exit', () => clearTimeout(timer))
}

export function createAnswerer({ readScope, writeAnswer, liveItems, stampThread = () => {}, log = console.error }) {
  const queue = []
  const running = new Set()
  const children = new Set()
  let active = 0
  let stopped = false

  function pump() {
    if (stopped) return
    const cap = positiveInt(process.env.UNBLOCK_EXPLAINER_CONCURRENCY, 24)
    for (let i = 0; i < queue.length && active < cap; i++) {
      const job = queue[i]
      const key = `${job.slug}:${job.threadId}`
      if (running.has(key)) continue
      queue.splice(i, 1)
      i--
      running.add(key)
      active++
      run(job).finally(() => { running.delete(key); active--; pump() }).catch((error) => log(`unblock: explainer run failed: ${error.message}`))
    }
  }

  function enqueue(job) {
    if (stopped) return
    queue.push(job)
    pump()
  }

  // Scope comments are a conversation with Alex, so they stay on Opus (Alex took it on comment-latency T2, 2026-10-05).
  // An explainer with `answerer_model` resolves that alias each answer; an alias that does not resolve falls back to
  // UNBLOCK_ANSWERER_MODEL, then Opus, and the fallback is logged (explainer-lane design slice 2, 2026-10-06).
  function modelFor(scope) {
    if (isScope(scope)) return Promise.resolve(process.env.UNBLOCK_SCOPE_ANSWERER_MODEL || 'claude-opus-5-5')
    const alias = scope?.answerer_model
    if (alias === undefined) return Promise.resolve(process.env.UNBLOCK_ANSWERER_MODEL || 'claude-sonnet-5-5')
    const fallback = (why) => {
      const model = process.env.UNBLOCK_ANSWERER_MODEL || 'claude-opus-5-5'
      log(`unblock: answerer_model_fallback slug=${scope.slug} alias=${String(alias).slice(0, 40)} ${why} model=${model}`)
      return model
    }
    if (typeof alias !== 'string' || !MODEL_ALIAS.test(alias)) return Promise.resolve(fallback('invalid-alias'))
    const bin = process.env.UNBLOCK_ROUTE_BIN || 'route'
    const env = { ...process.env, PATH: `${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}` }
    return new Promise((resolve) => {
      execFile(bin, ['resolve', alias], { timeout: 10000, encoding: 'utf8', env }, (error, stdout) => {
        const id = String(stdout ?? '').trim()
        if (!error && MODEL_ID.test(id)) return resolve(id)
        resolve(fallback(`exit=${error ? (typeof error.code === 'number' ? error.code : error.killed ? 'timeout' : 'error') : 'bad-output'}`))
      })
    })
  }

  function argv(sources, scope, model) {
    // A scope may pick its own effort: low answered in about 7 s, medium in 33-55 s with file reads (2026-10-05 burst tests).
    const scopeEffort = ['low', 'medium', 'high'].includes(scope?.answerer_effort) ? scope.answerer_effort : null
    const effort = isScope(scope) ? scopeEffort || process.env.UNBLOCK_SCOPE_ANSWERER_EFFORT || 'low' : process.env.UNBLOCK_ANSWERER_EFFORT || 'medium'
    const args = ['-p', '--restricted', '--model', model, '--effort', effort,
      '--tools', 'Read,Grep,Glob,WebFetch', '--allowedTools', 'Read,Grep,Glob,WebFetch', '--permission-mode', 'dontAsk',
      '--strict-mcp-config', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    for (const dir of sources.slice(1)) args.push('--add-dir', dir)
    return args
  }

  function childEnv(job) {
    const env = { ...process.env }
    for (const key of DROP_ENV) delete env[key]
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??= 'claude-sonnet-5-5'
    // $HOME is a git repo on Studio. Under launchd, Claude Code's startup `git status` there walks TCC-guarded
    // folders and hangs until the timeout (2026-10-03, every live answer). Stop git's repo search below $HOME.
    if (!env.GIT_CEILING_DIRECTORIES) env.GIT_CEILING_DIRECTORIES = homedir()
    env.CLAUDE_LB_SESSION_ID = `explainer-${job.slug}-${job.threadId}-${Date.now()}`
    return env
  }

  function postOwner(scope, thread, outcome) {
    const pane = scope?.pane
    if (typeof pane !== 'string' || !PANE.test(pane) || !thread) return Promise.resolve()
    const { line, task } = postLine(scope, thread, outcome)
    const bin = process.env.UNBLOCK_LANE_POST_BIN || join(homedir(), '.local', 'bin', 'lane-post')
    if (!remoteScopeHost(scope.host) && !process.env.UNBLOCK_LANE_POST_BIN && !existsSync(bin)) return Promise.resolve()
    return new Promise((resolve) => {
      const scoped = isScope(scope)
      // A scope responder's answer is a digest for the lane; only a hand-off wakes it.
      const command = scopePostCommand(bin, ['post', '--to', pane, '--from', `${scoped ? 'scope' : 'explainer'}:${scope.slug}`, '--kind', task ? 'task' : 'info', '--topic', `${scoped ? 'scope' : 'explainer'}-${scope.slug}`, '--wake', scoped && !task ? 'never' : 'auto', '--text', line], scope.host)
      execFile(command.bin, command.args, { timeout: 20000, encoding: 'utf8' }, (error, _stdout, stderr) => {
        if (error && !stopped) log(`unblock: lane-post slug=${scope.slug} pane=${pane} exit=${typeof error.code === 'number' ? error.code : error.killed ? 'timeout' : 'error'} stderr=${String(stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)} text=${line.slice(0, 80)}`)
        resolve()
      })
    })
  }

  // The section edit goes through the same CLI and lint a lane uses, so a responder can't publish what a lane couldn't.
  function applyEdit(slug, scope, outcome) {
    const { edit, ...rest } = outcome
    // The model often drops the heading or its {#id}; the section keeps its own heading and id either way.
    const lines = edit.markdown.split('\n')
    const heading = headingOf(scope, edit.id)
    if (!lines[0].startsWith('## ')) lines.unshift(`## ${heading} {#${edit.id}}`, '')
    else if (!/\{#[A-Za-z0-9_-]+\}\s*$/.test(lines[0])) lines[0] = `${lines[0].trimEnd()} {#${edit.id}}`
    // The doc lint refuses curly quotes, so a section that already holds them would never take an edit.
    edit.markdown = lines.join('\n').replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'")
    const dir = mkdtempSync(join(tmpdir(), 'unblock-edit-'))
    const file = join(dir, 'section.md')
    writeFileSync(file, `${edit.markdown}\n`)
    // The installed daemon copy has no plugin/ beside bin/, so the edit goes through the CLI on PATH, as a lane's does.
    const cli = process.env.UNBLOCK_CLI_BIN || join(homedir(), '.local', 'bin', 'unblock')
    // The edit lands only if the section is still the one this answer read (exit 6 = it changed).
    const read = scope.doc?.sections?.find((section) => section.id === edit.id)
    const guard = read ? ['--if-section-hash', sectionHash(read)] : []
    return new Promise((resolve) => {
      const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
      execFile(cli, ['scope', 'patch', slug, edit.id, '--from', file, ...guard], { timeout: 30000, encoding: 'utf8', env }, (error, _stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true })
        if (!error) return resolve({ ...rest, text: `${rest.text}\n\nEdited §${edit.id} to match.`, edited: edit.id })
        if (error.code === 6) return resolve({ ...rest, conflict: edit.id })
        const why = String(stderr || error.message).replace(/\s+/g, ' ').trim().slice(0, 160)
        log(`unblock: scope responder edit failed slug=${slug} section=${edit.id} ${why}`)
        resolve({ ...rest, text: `${rest.text}\n\n(Couldn't edit §${edit.id}: ${why})`, needs_owner: true, why: rest.why || 'section edit failed' })
      })
    })
  }

  // One model call: resolves with the parsed outcome when it settles; `gone` resolves when the child has exited.
  function ask(job, scope, thread, model, item) {
    const firstText = () => { if (!job.texted) { job.texted = true; stampThread(job.slug, job.threadId, { answer_first_text_at: new Date().toISOString() }) } }
    const sources = Array.isArray(scope?.sources) ? scope.sources.filter((dir) => typeof dir === 'string') : []
    const pane = typeof scope?.pane === 'string' ? scope.pane : ''
    let closed
    const gone = new Promise((resolve) => { closed = resolve })
    const result = new Promise((resolve) => {
      let settled = false
      let exited = false
      let partial = ''
      let resultText = null
      let badResult = false
      let partialAt = 0
      let partialTimer = null
      let timer = null
      const finish = (outcome) => {
        if (settled) return
        if (partialTimer) flushPartial()
        settled = true
        clearTimeout(timer)
        clearTimeout(partialTimer)
        resolve(stopped ? undefined : outcome)
      }
      const flushPartial = () => {
        partialTimer = null
        partialAt = Date.now()
        if (stopped || settled || !partial) return
        const lines = partial.split('\n')
        if (!partial.endsWith('\n')) {
          const tail = lines.at(-1).trimStart()
          if (tail && 'NEEDS_OWNER'.startsWith(tail)) lines.pop()
        }
        item({ status: 'streaming', text: lines.filter(line => !line.trimStart().startsWith('NEEDS_OWNER')).join('\n').trimEnd(), doing: null })
      }
      const schedulePartial = () => {
        if (stopped || settled) return
        const wait = 100 - (Date.now() - partialAt)
        if (wait <= 0) flushPartial()
        else if (!partialTimer) partialTimer = setTimeout(flushPartial, wait)
      }
      let child
      try {
        const cwd = sources[0] && existsSync(sources[0]) ? sources[0] : job.scopeDir
        child = spawn(process.env.UNBLOCK_ANSWERER_BIN || join(homedir(), '.local', 'bin', 'claude-lb-launch'), argv(sources, scope, model), {
          cwd,
          env: childEnv(job),
          detached: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        })
      } catch {
        exited = true
        closed()
        finish({ text: `Couldn't answer: sent to ${pane}`, handoff: true, reason: 'fail' })
        return
      }
      item({ status: 'thinking' })
      children.add(child)
      child.once('close', () => children.delete(child))
      timer = setTimeout(() => {
        killGroup(child)
        finish({ text: `Taking longer: sent to ${pane}`, handoff: true, reason: 'timeout' })
      }, positiveInt(process.env.UNBLOCK_EXPLAINER_TIMEOUT_MS, 180000))
      let buf = ''
      const handle = (line) => {
        let msg
        try { msg = JSON.parse(line) } catch { return }
        const event = msg.event
        if (msg.type === 'stream_event' && event?.type === 'message_start') partial = ''
        else if (msg.type === 'stream_event' && event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          if (event.delta.text) firstText()
          partial += event.delta.text
          schedulePartial()
        } else if (msg.type === 'assistant') {
          if (msg.message?.content?.some(block => block.type === 'text' && block.text)) firstText()
          const tool = msg.message?.content?.filter(block => block.type === 'tool_use').at(-1)
          if (tool) {
            const input = tool.input ?? {}
            let doing = { text: 'Working' }
            if (tool.name === 'Read') doing.text = `Reading ${basename(String(input.file_path ?? ''))}`
            else if (tool.name === 'Grep') doing.text = `Searching for "${String(input.pattern ?? '').slice(0, 40)}"`
            else if (tool.name === 'Glob') doing.text = `Looking for ${input.pattern ?? ''}`
            else if (tool.name === 'WebFetch') {
              try {
                const url = new URL(input.url)
                if (['http:', 'https:'].includes(url.protocol)) doing = { text: `Reading ${url.hostname}`, link: input.url }
              } catch { /* Unknown URL: keep Working. */ }
            }
            doing.text = doing.text.slice(0, 120)
            const current = liveItems?.list(job.slug).find(value => value.id === `${job.threadId}@${job.messageAt}`)
            item({ status: current?.status ?? 'thinking', doing })
          }
        } else if (msg.type === 'result') {
          if (msg.is_error || typeof msg.result !== 'string') badResult = true
          else {
            if (msg.result) firstText()
            badResult = false; resultText = msg.result
          }
        }
      }
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1) }
      })
      child.stdin?.on('error', () => {})
      child.stdin?.write(promptFor(scope, thread, job.scopeDir))
      child.stdin?.end()
      const onDone = () => {
        exited = true
        closed()
        if (buf.trim()) handle(buf)
        buf = ''
        if (!settled) finish(resultText != null && !badResult ? takeAnswer(resultText) : { text: `Couldn't answer: sent to ${pane}`, handoff: true, reason: 'fail' })
      }
      child.on('error', onDone)
      child.on('close', onDone)
    })
    return { result, gone }
  }

  function run(job) {
    stampThread(job.slug, job.threadId, { answer_started_at: new Date().toISOString() })
    let scope = readScope(job.slug)
    let thread = scope?.threads?.find((item) => item.id === job.threadId)
    const pane = typeof scope?.pane === 'string' ? scope.pane : ''
    const item = (patch) => liveItems?.upsert(job.slug, { thread: job.threadId, to: job.messageAt, by: isScope(scope) ? 'Responder' : 'Explainer', ...patch })
    const patch = (outcome) => writeAnswer(job.slug, { threadId: job.threadId, at: job.messageAt, text: outcome.text, pending: false, needs_owner: outcome.needs_owner, handoff: outcome.handoff })
    const settle = async (outcome) => {
      if (stopped) return
      try {
        await patch(outcome)
        if (stopped) return
        item({ status: outcome.handoff ? 'failed' : 'done', doing: null, text: outcome.text, ...(outcome.handoff ? { error: outcome.text } : {}) })
      } catch (error) {
        if (stopped) return
        item({ status: 'failed', doing: null, error: `Couldn't save the answer: ${error.message}`.slice(0, 200) })
        log(`unblock: explainer save failed: ${error.message}`)
      }
      // The slot frees once the answer is saved; a slow lane-post never holds the queue.
      if (!stopped) {
        try { postOwner(scope, thread, outcome).catch((error) => { if (!stopped) log(`unblock: lane-post failed: ${error.message}`) }) } catch (error) { log(`unblock: lane-post failed: ${error.message}`) }
      }
    }
    if (!scope || !thread) return settle({ text: `Couldn't answer: sent to ${pane}`, handoff: true, reason: 'fail' })
    return modelFor(scope).then(async (model) => {
      if (stopped) return
      const exits = []
      // Answer, then apply the edit against the snapshot this answer read; a changed section means answer again once.
      const answer = async () => {
        if (stopped) return
        const call = ask(job, scope, thread, model, item)
        exits.push(call.gone)
        const outcome = await call.result
        return outcome?.edit && !stopped ? applyEdit(job.slug, scope, outcome) : outcome
      }
      let outcome = await answer()
      if (outcome?.conflict) {
        scope = readScope(job.slug)
        thread = scope?.threads?.find((value) => value.id === job.threadId)
        if (stopped) outcome = undefined
        else if (!scope || !thread) outcome = { text: `Couldn't answer: sent to ${pane}`, handoff: true, reason: 'fail' }
        else {
          outcome = await answer()
          if (outcome?.conflict) outcome = { ...outcome, text: `${outcome.text}\n\n(Didn't edit §${outcome.conflict}: it changed again while I answered, so the lane has it.)`, needs_owner: true, why: `§${outcome.conflict} changed while the responder answered` }
        }
      }
      if (outcome) await settle(outcome)
      await Promise.all(exits)
    })
  }

  function stop() {
    stopped = true
    queue.length = 0
    for (const child of children) killGroup(child)
  }

  return { enqueue, stop }
}
