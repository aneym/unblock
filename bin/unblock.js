#!/usr/bin/env node
/**
 * unblock CLI.
 *
 * One rule shapes this file: `reveal` exists here and nowhere else. Resolving a
 * secret to its value is a thing a human at a terminal does, never something
 * reachable over HTTP or an MCP tool, because anything reachable that way ends
 * up in a model's context sooner or later.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'

import { daemon, api, stateDir } from '../plugin/paths.js'
import { SecretStore } from '../src/secrets.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const [cmd = 'list', ...rest] = process.argv.slice(2)

const die = (msg) => {
  console.error(msg)
  process.exit(1)
}

const age = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

switch (cmd) {
  case 'list':
  case 'ls':
    await list()
    break
  case 'daemon':
    await daemonCmd(rest[0] ?? 'status')
    break
  case 'mcp':
    // Hand the process over; this is what an agent's config points at.
    spawn(process.execPath, [join(ROOT, 'src', 'mcp.js'), ...rest], { stdio: 'inherit' }).on(
      'exit',
      (code) => process.exit(code ?? 0),
    )
    break
  case 'ui':
  case 'queue':
    spawn(process.execPath, [join(ROOT, 'plugin', 'tui.js')], { stdio: 'inherit' }).on(
      'exit',
      (code) => process.exit(code ?? 0),
    )
    break
  case 'link':
    await link(rest[0])
    break
  case 'answer':
    await answer(rest)
    break
  case 'reveal':
    await reveal(rest[0], rest[1])
    break
  case 'mirror':
    await mirror(rest[0])
    break
  case 'help':
  case '--help':
  case '-h':
    help()
    break
  default:
    die(`unknown command: ${cmd}\nTry: unblock help`)
}

function help() {
  console.log(`unblock — one queue for everything your agents need from you

  unblock                      list the queue
  unblock ui                   open the interactive queue
  unblock link [ticket]        mint an ephemeral answer link
  unblock answer <ticket> k=v  answer from the shell
  unblock reveal <ticket> <f>  print a stored secret (this machine only)
  unblock mirror [path]        write BLOCKERS.md from the queue
  unblock daemon start|stop|status
  unblock mcp                  run the MCP server (for an agent's config)

Answering a parked ask wakes the agent. Answering a filed one never interrupts.`)
}

async function list() {
  const profile = argOf('--profile') ?? '*'
  const { asks, hidden } = await api(`/api/asks?profile=${encodeURIComponent(profile)}`)
  const open = asks.filter((a) => a.status === 'open')
  if (open.length === 0) {
    console.log('Nothing is waiting on you.')
    if (hidden) console.log(`${hidden} in other profiles.`)
    return
  }
  for (const ask of open) {
    const mark = ask.gating ? '!' : ' '
    const where = [ask.origin.agent, ask.origin.workspace_name, ask.origin.pane_id && `pane ${ask.origin.pane_id}`]
      .filter(Boolean)
      .join(' · ')
    console.log(`${mark} ${ask.ticket}  ${ask.title}`)
    console.log(`    ${where} · ${age(ask.created_at)}`)
    if (ask.missing.length) console.log(`    needs: ${ask.missing.join(', ')}`)
  }
  if (hidden) console.log(`\n${hidden} more in other profiles.`)
}

async function daemonCmd(sub) {
  const pidFile = join(stateDir(), 'daemon.json')
  if (sub === 'start') {
    const base = await daemon()
    console.log(`unblock daemon at ${base}`)
    return
  }
  if (sub === 'stop') {
    if (!existsSync(pidFile)) return console.log('not running')
    const { pid } = JSON.parse(readFileSync(pidFile, 'utf8'))
    try {
      process.kill(pid, 'SIGTERM')
      console.log(`stopped (pid ${pid})`)
    } catch {
      console.log('not running')
    }
    try {
      unlinkSync(pidFile)
    } catch {
      /* already gone */
    }
    return
  }
  try {
    const base = await daemon({ start: false })
    const health = await api('/api/health')
    console.log(`running at ${base} · secrets: ${health.backend}`)
  } catch {
    console.log('not running')
  }
}

async function link(ticket) {
  const { url, expires_at } = await api('/api/links', {
    ticket: ticket || undefined,
    ttl_seconds: 900,
  })
  console.log(url)
  console.log(`expires in ${Math.max(1, Math.round((expires_at - Date.now()) / 60000))}m`)
}

async function answer(args) {
  const ticket = args.shift()
  if (!ticket) die('usage: unblock answer <ticket> field=value ...')
  const values = {}
  for (const pair of args) {
    const i = pair.indexOf('=')
    if (i < 0) die(`expected field=value, got: ${pair}`)
    const key = pair.slice(0, i)
    const raw = pair.slice(i + 1)
    values[key] = raw === 'true' ? true : raw === 'false' ? false : raw
  }
  const { ask, complete } = await api(`/api/asks/${ticket}/answer`, { values })
  if (complete) {
    // `gating` is already false by the time we see the response — answering is
    // what cleared it. Ask what KIND it was instead.
    console.log(ask.kind === 'park' ? `answered — waking ${ask.origin.agent}` : 'answered')
  } else {
    console.log(`saved — still needs: ${ask.missing.join(', ')}`)
  }
}

/** Local only, by design. Never exposed over HTTP or MCP. */
async function reveal(ticket, field) {
  if (!ticket || !field) die('usage: unblock reveal <ticket> <field>')
  const ask = await api(`/api/asks/${ticket}`)
  const record = ask.answers?.[field]
  if (!record) die(`no answer recorded for ${field}`)
  if (typeof record !== 'object' || !record.store) die(`${field} is not a secret`)
  if (process.stdout.isTTY) {
    console.error(`# ${field} from ${ticket} — piping this is safer than printing it`)
  }
  process.stdout.write(await new SecretStore().reveal(record))
  if (process.stdout.isTTY) process.stdout.write('\n')
}

/**
 * Render the queue as the markdown board people already open. Read-only: the
 * daemon is the source of truth, so nothing here is ever hand-edited.
 */
async function mirror(target) {
  const path = resolve(target ?? 'docs/unblock/BLOCKERS.md')
  const { asks } = await api('/api/asks?profile=*')
  const open = asks.filter((a) => a.status === 'open')

  const byWorkspace = new Map()
  for (const ask of open) {
    const key = ask.origin.workspace_name ?? ask.origin.repo ?? 'elsewhere'
    if (!byWorkspace.has(key)) byWorkspace.set(key, [])
    byWorkspace.get(key).push(ask)
  }

  const out = [
    '# Blockers',
    '',
    '<!-- Generated by `unblock mirror`. Do not edit; answer in the queue instead. -->',
    `<!-- ${new Date().toISOString()} -->`,
    '',
  ]

  if (open.length === 0) {
    out.push('Nothing is waiting on you.', '')
  }

  for (const [workspace, list] of byWorkspace) {
    out.push(`## ${workspace}`, '')
    let n = 0
    for (const ask of list) {
      n += 1
      const tags = [ask.gating ? 'gating' : 'filed', ask.origin.agent, age(ask.created_at)]
        .filter(Boolean)
        .join(' · ')
      out.push(`### ${n}. ${ask.title} — ${ask.why} [${tags}]`, '')
      for (const step of ask.steps ?? []) out.push(`- ${step}`)
      for (const l of ask.links ?? []) out.push(`- ${l.url}`)
      if (ask.missing.length) out.push(`- Needs: ${ask.missing.join(', ')}`)
      out.push(`- Answer: \`unblock answer ${ask.ticket} ...\` or open the queue`, '')
    }
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, out.join('\n'))
  console.log(path)
}

function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i > -1 ? process.argv[i + 1] : undefined
}
