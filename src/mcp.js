import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'unblock', version: '0.1.0' }
const HOST = '127.0.0.1'
const DAEMON_PATH = join(dirname(fileURLToPath(import.meta.url)), 'daemon.js')

function stateDir() {
  return (
    process.env.UNBLOCK_STATE_DIR ||
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')
  )
}

function configuredPort() {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'daemon.json'), 'utf8')).port
  } catch {
    return Number(process.env.UNBLOCK_PORT || 4488)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Where to send the human for one ask.
 *
 * ONE link per install, not one per ask. When the daemon has a canonical
 * origin — a tailnet host where a trusted proxy already identifies the viewer —
 * every park points at that same stable URL with the ticket in the fragment.
 * It is bookmarkable, it survives restarts, and a person who has answered once
 * already has it open.
 *
 * Minting a fresh token per park was the old behaviour and it was wrong: a new
 * unguessable URL every time is useless as a bookmark, and it trains the human
 * to click whatever link an agent hands them. Tokens still exist, but as a
 * SHARING mechanism (send one ask to someone off the tailnet), not the front
 * door — and they are the fallback when no canonical origin is configured.
 */
async function answerLink(ticket) {
  try {
    const health = await daemonFetch('/health')
    if (health?.public_origin) {
      return { url: `${health.public_origin.replace(/\/$/, '')}/#ask=${ticket}`, canonical: true }
    }
  } catch {
    /* fall through to a token */
  }
  const link = await daemonFetch('/links', {
    method: 'POST',
    body: JSON.stringify({ ticket, ttl_seconds: 900 }),
  })
  return { url: link.url, canonical: false }
}

/** The daemon's local secret, re-read each call so a restart is picked up. */
function daemonAuth() {
  if (process.env.UNBLOCK_AUTH) return process.env.UNBLOCK_AUTH
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'daemon.json'), 'utf8')).auth ?? null
  } catch {
    return null
  }
}

async function daemonFetch(pathname, options = {}) {
  let lastError
  for (let attempt = 0; attempt < 27; attempt += 1) {
    const port = configuredPort()
    try {
      const auth = daemonAuth()
      const response = await fetch(`http://${HOST}:${port}/api${pathname}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          ...(options.headers || {}),
        },
      })
      const body = await response.json()
      if (!response.ok) {
        const error = new Error(body.error || `daemon returned ${response.status}`)
        error.status = response.status
        error.data = body
        throw error
      }
      return body
    } catch (error) {
      if (error.status) throw error
      lastError = error
      if (attempt === 0) {
        spawn(process.execPath, [DAEMON_PATH], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        }).unref()
      }
      await sleep(200)
    }
  }
  throw new Error(`unblock daemon did not start: ${lastError?.message || 'unknown error'}`)
}

function origin() {
  return {
    agent: process.env.UNBLOCK_AGENT || 'claude',
    pane_id: process.env.HERDR_PANE_ID,
    tab_id: process.env.HERDR_TAB_ID,
    workspace_id: process.env.HERDR_WORKSPACE_ID,
    session_id: process.env.HERDR_SESSION_ID || process.env.CLAUDE_SESSION_ID,
    cwd: process.cwd(),
  }
}

const askProperties = {
  // Blocker = the human must DO something only they can do (supply a key,
  // click a console button, confirm an act). No recommendation is possible.
  // Decision = the human must DECIDE; the agent has a view and every field
  // MUST carry recommend {value, why}. The daemon rejects a mismatch, so this
  // is a real contract, not a hint.
  purpose: { type: 'string', enum: ['blocker', 'decision'], default: 'blocker' },
  title: { type: 'string', maxLength: 90 },
  why: { type: 'string', maxLength: 1200 },
  fields: {
    type: 'array',
    minItems: 1,
    maxItems: 12,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        type: { type: 'string', enum: ['text', 'secret', 'choice', 'confirm', 'paste'] },
        label: { type: 'string' },
        required: { type: 'boolean' },
        // Required on every field when purpose is "decision"; rejected on a
        // blocker. `why` is the reason in one line, not a restatement.
        recommend: {
          type: 'object',
          properties: { value: {}, why: { type: 'string', maxLength: 200 } },
          required: ['value', 'why'],
        },
        // Renders empty and is excluded from accept-all, so the human has to
        // engage with it. At most 3 per ask.
        must_decide: { type: 'boolean' },
        help: { type: 'string' },
        url: { type: 'string' },
        choices: { type: 'array' },
        multi: { type: 'boolean' },
        command: { type: 'string' },
        multiline: { type: 'boolean' },
        placeholder: { type: 'string' },
        store: { type: 'string' },
        env_name: { type: 'string' },
      },
      required: ['name', 'type'],
    },
  },
  steps: { type: 'array', items: { type: 'string' }, maxItems: 12 },
  links: {
    type: 'array',
    items: {
      type: 'object',
      properties: { url: { type: 'string' }, label: { type: 'string' } },
      required: ['url'],
    },
  },
  ttl_seconds: { type: 'number', exclusiveMinimum: 0 },
}

const askSchema = { type: 'object', properties: askProperties, required: ['title', 'why', 'fields'] }

const TOOLS = [
  {
    name: 'unblock_file',
    description: 'File a non-gating request for a human and continue working.',
    inputSchema: askSchema,
  },
  {
    name: 'unblock_park',
    description: 'Park on a human request, open its answer page, and wait for a complete answer.',
    inputSchema: askSchema,
  },
  {
    name: 'unblock_check',
    description: 'Collect answered requests previously filed by this agent.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'unblock_cancel',
    description: 'Withdraw an open request.',
    inputSchema: {
      type: 'object',
      properties: { ticket: { type: 'string' }, note: { type: 'string' } },
      required: ['ticket'],
    },
  },
]

function textResult(text, data) {
  return { content: [{ type: 'text', text }], ...(data === undefined ? {} : { structuredContent: data }) }
}

function answerText(ask) {
  if (ask.status === 'bounced') {
    return `${ask.ticket} was SENT BACK: ${ask.reply ?? '(no note)'}`
  }
  const lines = [`${ask.ticket}: ${ask.title}`]
  for (const field of ask.fields) {
    if (!(field.name in ask.answers)) continue
    const value = ask.answers[field.name]
    if (ask.answer_is_ref?.[field.name]) {
      lines.push(`${field.name}: ${value.store} reference ${value.ref}`)
      if (value.hint) lines.push(`  ${value.hint}`)
      if (value.resolve) lines.push(`  Resolve without printing: ${value.resolve}`)
    } else {
      lines.push(`${field.name}: ${JSON.stringify(value)}`)
    }
  }
  if (ask.reply) lines.push(`they also said: ${ask.reply}`)
  return lines.join('\n')
}

async function createAsk(kind, args) {
  return daemonFetch('/asks', {
    method: 'POST',
    body: JSON.stringify({ ask: { ...args, kind }, origin: origin() }),
  })
}

export class McpConnection {
  constructor(send) {
    this.send = send
    this.clientCapabilities = {}
    this.nextId = 1
    this.pending = new Map()
  }

  request(method, params) {
    const id = `unblock-${this.nextId++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async callTool(name, args, request) {
    if (name === 'unblock_file') {
      const ask = await createAsk('file', args)
      return textResult(`Filed ${ask.ticket}. Keep working; call unblock_check later.`, { ticket: ask.ticket })
    }

    if (name === 'unblock_cancel') {
      const body = await daemonFetch(`/asks/${encodeURIComponent(args.ticket)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ note: args.note }),
      })
      return textResult(`Cancelled ${body.ask.ticket}.`, { ask: body.ask })
    }

    if (name === 'unblock_check') {
      const query = new URLSearchParams(Object.entries(origin()).filter(([, value]) => value != null))
      const pending = await daemonFetch(`/pending?${query}`)
      const collected = []
      for (const ask of pending.asks) {
        const body = await daemonFetch(`/asks/${encodeURIComponent(ask.ticket)}/collect`, {
          method: 'POST',
          body: '{}',
        })
        collected.push(body.ask)
      }
      if (collected.length === 0) return textResult('No answered requests are waiting.', { asks: [] })
      return textResult(collected.map(answerText).join('\n\n'), { asks: collected })
    }

    if (name === 'unblock_park') {
      const ask = await createAsk('park', args)
      const link = await answerLink(ask.ticket)
      if (this.clientCapabilities.elicitation) {
        try {
          await this.request('elicitation/create', {
            mode: 'url',
            message: `${ask.title}: ${ask.why}`,
            url: link.url,
            elicitationId: ask.ticket,
          })
        } catch {
          // A declined or unsupported elicitation still leaves polling as the reliable path.
        }
      }
      let lastProgress = Date.now()
      const deadline = ask.expires_at || Date.now() + 24 * 60 * 60 * 1000
      for (;;) {
        const current = await daemonFetch(`/asks/${encodeURIComponent(ask.ticket)}`)
        if (current.status === 'answered') {
          const collected = await daemonFetch(`/asks/${encodeURIComponent(ask.ticket)}/collect`, {
            method: 'POST',
            body: '{}',
          })
          return textResult(answerText(collected.ask), { ask: collected.ask })
        }
        if (current.status === 'bounced') {
          // Not an error and not an answer. The human read the ask, decided it
          // was the wrong question, and sent it back with a note. Resume, take
          // the note seriously, and ask again properly — do not re-park with
          // the same question.
          await daemonFetch(`/asks/${encodeURIComponent(ask.ticket)}/collect`, {
            method: 'POST',
            body: '{}',
          }).catch(() => {})
          return textResult(
            [
              `${current.ticket} was SENT BACK, not answered.`,
              `They said: ${current.reply ?? '(no note)'}`,
              '',
              'Rewrite the ask to address that and park again. Do not repeat the same question.',
            ].join('\n'),
            { ask: current, bounced: true },
          )
        }
        if (['cancelled', 'expired', 'orphaned'].includes(current.status)) {
          throw new Error(`ask ${current.ticket} is ${current.status}`)
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for ${current.ticket}`)
        }
        if (Date.now() - lastProgress >= 20_000) {
          this.notify('notifications/progress', {
            progressToken: request?.params?._meta?.progressToken || ask.ticket,
            progress: Math.floor((Date.now() - ask.created_at) / 1000),
            message: `Waiting for ${ask.ticket}`,
          })
          lastProgress = Date.now()
        }
        await sleep(3000)
      }
    }

    throw new Error(`unknown tool: ${name}`)
  }

  async handle(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.pending.get(String(message.id))
      if (!pending) return
      this.pending.delete(String(message.id))
      if (message.error) pending.reject(new Error(message.error.message || 'client request failed'))
      else pending.resolve(message.result)
      return
    }
    if (!message.method) return
    if (message.id === undefined) return

    let result
    try {
      if (message.method === 'initialize') {
        this.clientCapabilities = message.params?.capabilities || {}
        result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }
      } else if (message.method === 'ping') {
        result = {}
      } else if (message.method === 'tools/list') {
        result = { tools: TOOLS }
      } else if (message.method === 'tools/call') {
        result = await this.callTool(message.params?.name, message.params?.arguments || {}, message)
      } else {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        })
        return
      }
      this.send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: error.message, data: error.data },
      })
    }
  }
}

export function startStdio() {
  const connection = new McpConnection((message) => process.stdout.write(`${JSON.stringify(message)}\n`))
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } })}\n`)
      return
    }
    connection.handle(message)
  })
  return connection
}

function isLoopbackHost(host) {
  if (!host) return false
  const hostname = String(host).replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHost(new URL(origin).host)
  } catch {
    return false
  }
}

export async function startHttp({ port = configuredPort() + 1 } = {}) {
  const sessions = new Map()
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    // Without these three checks any page the user has open can reach this
    // server: text/plain makes the request CORS-simple, so no preflight fires
    // and fetch(..., {mode:'no-cors'}) gets through. Write access alone is
    // enough to inject an ask whose title asks the human for a production key.
    // The MCP spec requires Origin validation on HTTP transports for exactly
    // this reason.
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end()
      return
    }
    if (req.headers.origin && !isLoopbackOrigin(req.headers.origin)) {
      res.writeHead(403).end()
      return
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      res.writeHead(415).end()
      return
    }
    const chunks = []
    let received = 0
    for await (const chunk of req) {
      received += chunk.length
      if (received > 1_000_000) {
        res.writeHead(413).end()
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    let message
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }))
      return
    }
    let sessionId = req.headers['mcp-session-id']
    if (!sessionId && message.method === 'initialize') sessionId = randomUUID()
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Mcp-Session-Id is required' }))
      return
    }
    let response
    let connection = sessions.get(sessionId)
    if (!connection) {
      connection = new McpConnection((payload) => {
        if (payload.id === message.id || payload.id === String(message.id)) response = payload
      })
      sessions.set(sessionId, connection)
    }
    await connection.handle(message)
    res.writeHead(response ? 200 : 202, {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': sessionId,
    })
    res.end(response ? JSON.stringify(response) : '')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, resolve)
  })
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--http')) await startHttp({})
  else startStdio()
}
