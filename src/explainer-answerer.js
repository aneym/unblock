import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { headingOf } from './scope-doc.js'
import { quoteSnippet } from './scope-anchor.js'

const PANE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/
const DROP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
const ROLE = 'You answer Alex\'s margin questions about an explainer doc. Answer in plain short prose: two to five sentences, no headings, and a short list only when you name three or more parallel things. Lead with the direct answer. Cite file:line or the URL for every claim you take from a source. Read the sources before answering when the doc alone does not settle it. If the answer needs a decision or new work from the doc\'s owner, end with one line `NEEDS_OWNER: <why>`.'

const compact = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const positiveInt = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback }

function docMarkdown(scope) {
  const parts = [`# ${scope.title ?? ''}`]
  for (const section of scope.doc?.sections ?? []) parts.push(`## ${section.heading}\n${section.body_md ?? ''}`)
  let doc = parts.join('\n\n')
  if (doc.length > 60000) doc = `${doc.slice(0, 59999)}…`
  return doc
}

function promptFor(scope, thread) {
  const sources = Array.isArray(scope.sources) ? scope.sources : []
  const quote = thread.anchor?.general ? '(whole doc)' : (thread.anchor?.quote ?? '')
  const said = []
  for (const message of thread.messages ?? []) {
    if (message.pending) continue
    said.push(`${message.from === 'alex' ? 'Alex' : 'You'}: ${message.text}`)
  }
  return [
    ROLE, '', 'Source dirs:', ...sources, '', '# Doc', docMarkdown(scope), '', '# Thread',
    headingOf(scope, thread.anchor?.section ?? 'title'), quote, ...said, '', 'Answer Alex\'s last message.', '',
  ].join('\n')
}

function takeAnswer(raw) {
  const trimmed = String(raw ?? '').replace(/\s+$/, '')
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
  const suffix = task ? ` NEEDS YOU: ${why}. Reply in the thread: unblock scope reply ${scope.slug} ${thread.id} "<text>"; fold into the doc: unblock explain doc ${scope.slug} --from <file.md>` : ''
  let q = compact(question)
  let answer = compact(outcome.text)
  const head = () => `[explainer ${scope.slug}] ${thread.id} on §${headingOf(scope, thread.anchor?.section ?? 'title')} "${quote}": Q: ${q} A: `
  let room = 700 - head().length - suffix.length
  if (answer.length > Math.max(0, room)) answer = room > 1 ? `${answer.slice(0, room - 1)}…` : ''
  room = 700 - head().length - suffix.length
  if (room < 0) {
    q = q.slice(0, Math.max(0, q.length + room - 1))
    if (q) q += '…'
    answer = ''
  }
  let line = `${head()}${answer}${suffix}`
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

export function createAnswerer({ readScope, writeAnswer, liveItems, log = console.error }) {
  const queue = []
  const running = new Set()
  const children = new Set()
  let active = 0
  let stopped = false

  function pump() {
    if (stopped) return
    const cap = positiveInt(process.env.UNBLOCK_EXPLAINER_CONCURRENCY, 8)
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

  function argv(sources) {
    const args = ['-p', '--restricted', '--model', process.env.UNBLOCK_ANSWERER_MODEL || 'claude-sonnet-5-5', '--effort', process.env.UNBLOCK_ANSWERER_EFFORT || 'medium',
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
    if (!process.env.UNBLOCK_LANE_POST_BIN && !existsSync(bin)) return Promise.resolve()
    return new Promise((resolve) => {
      execFile(bin, ['post', '--to', pane, '--from', `explainer:${scope.slug}`, '--kind', task ? 'task' : 'info', '--topic', `explainer-${scope.slug}`, '--wake', 'auto', '--text', line], { timeout: 20000, encoding: 'utf8' }, (error, _stdout, stderr) => {
        if (error) log(`unblock: lane-post slug=${scope.slug} pane=${pane} exit=${typeof error.code === 'number' ? error.code : error.killed ? 'timeout' : 'error'} stderr=${String(stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)} text=${line.slice(0, 80)}`)
        resolve()
      })
    })
  }

  function run(job) {
    const scope = readScope(job.slug)
    const thread = scope?.threads?.find((item) => item.id === job.threadId)
    const sources = Array.isArray(scope?.sources) ? scope.sources.filter((dir) => typeof dir === 'string') : []
    const pane = typeof scope?.pane === 'string' ? scope.pane : ''
    const item = (patch) => liveItems?.upsert(job.slug, { thread: job.threadId, to: job.messageAt, by: 'Explainer', ...patch })
    const patch = (outcome) => writeAnswer(job.slug, { threadId: job.threadId, at: job.messageAt, text: outcome.text, pending: false, needs_owner: outcome.needs_owner, handoff: outcome.handoff })
    const settle = async (outcome) => {
      if (stopped) return
      await patch(outcome)
      item({ status: outcome.handoff ? 'failed' : 'done', doing: null, text: outcome.text, ...(outcome.handoff ? { error: outcome.text } : {}) })
      if (!stopped) await postOwner(scope, thread, outcome)
    }
    if (!scope || !thread) return settle({ text: `Couldn't answer: sent to ${pane}`, handoff: true, reason: 'fail' })
    return new Promise((resolve) => {
      let settled = false
      let exited = false
      let partial = ''
      let resultText = null
      let badResult = false
      let partialAt = 0
      let partialTimer = null
      let timer = null
      const finishSlot = () => { if (settled && exited) resolve() }
      const finish = (outcome) => {
        if (settled) return
        if (partialTimer) flushPartial()
        settled = true
        clearTimeout(timer)
        clearTimeout(partialTimer)
        if (stopped) { finishSlot(); return }
        settle(outcome).finally(finishSlot).catch((error) => log(`unblock: explainer settle failed: ${error.message}`))
      }
      const flushPartial = () => {
        partialTimer = null
        partialAt = Date.now()
        if (stopped || settled || !partial) return
        item({ status: 'streaming', text: partial.split('\n').filter(line => !line.startsWith('NEEDS_OWNER')).join('\n'), doing: null })
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
        child = spawn(process.env.UNBLOCK_ANSWERER_BIN || join(homedir(), '.local', 'bin', 'claude-lb-launch'), argv(sources), {
          cwd,
          env: childEnv(job),
          detached: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        })
      } catch {
        exited = true
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
          partial += event.delta.text
          schedulePartial()
        } else if (msg.type === 'assistant') {
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
          else { badResult = false; resultText = msg.result }
        }
      }
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1) }
      })
      child.stdin?.on('error', () => {})
      child.stdin?.write(promptFor(scope, thread))
      child.stdin?.end()
      const onDone = () => {
        exited = true
        if (buf.trim()) handle(buf)
        buf = ''
        if (!settled) finish(resultText != null && !badResult ? takeAnswer(resultText) : { text: `Couldn't answer: sent to ${pane}`, handoff: true, reason: 'fail' })
        else finishSlot()
      }
      child.on('error', onDone)
      child.on('close', onDone)
    })
  }

  function stop() {
    stopped = true
    queue.length = 0
    for (const child of children) killGroup(child)
  }

  return { enqueue, stop }
}
