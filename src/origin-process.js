import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { promptPane } from './pane-notice.js'

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'timeout', 'nohup', 'xargs', 'time'])
const AGENTS = new Set(['herdr', 'codex', 'claude', 'hermes', 'opencode', 'aider'])

function ancestry(pid) {
  const parents = []
  const seen = new Set()
  while (pid > 1 && !seen.has(pid) && parents.length < 128) {
    seen.add(pid)
    try {
      // comm, not args: process arguments may contain credentials.
      const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim()
      const match = line.match(/^(\d+)\s+(.+)$/)
      if (!match) return undefined
      const name = basename(match[2].split(/[\s:]/)[0]).toLowerCase()
      if (name === 'ssh' || name === 'sshd' || name.startsWith('sshd-')) return undefined
      parents.push({ pid, name })
      pid = Number(match[1])
    } catch { return undefined }
  }
  return pid <= 1 ? parents : undefined
}

export function filerPid() {
  const parents = ancestry(process.ppid)
  if (!parents) return undefined
  const override = Number(process.env.UNBLOCK_ORIGIN_PID)
  // 1 remains a way to disable PID tracking, never a lifecycle owner.
  if (override === 1) return undefined
  if (Number.isSafeInteger(override) && override > 1) return override
  return parents.find(({ name }) => !SHELLS.has(name))?.pid
}

/** The daemon, not the filing client, decides whether PID exit owns an ask. */
export async function verifiedOrigin(origin) {
  const { pid, pid_start, pid_verified, ...identity } = origin
  if (!identity.pane_id || !Number.isSafeInteger(pid) || pid <= 1) return identity
  const start = processStarts([pid])?.get(pid)
  const parents = ancestry(pid)
  if (!start || !parents || SHELLS.has(parents[0]?.name)) return identity
  // A process name or a caller-supplied pane label alone does not prove ownership.
  // Confirm the PID belongs to this pane's foreground agent before arming cleanup.
  try {
    const details = JSON.parse(await promptPane(['pane', 'process-info', '--pane', identity.pane_id]))
    const pane = details.result?.process_info
    if (pane?.pane_id !== identity.pane_id || pane.shell_pid === pid ||
        !pane.foreground_processes?.some((process) => process.pid === pid)) return identity
    const name = parents[0]?.name
    if (!AGENTS.has(name) && !(['node', 'nodejs', 'python', 'python3'].includes(name) && AGENTS.has(identity.agent))) return identity
  } catch { return identity }
  if (processStarts([pid])?.get(pid) !== start) return identity
  return { ...identity, pid, pid_start: start, pid_verified: true }
}

export function hasVerifiedPid(origin) {
  return origin?.pid_verified === true && Boolean(origin.pane_id) && Number.isSafeInteger(origin.pid) && origin.pid > 1 && typeof origin.pid_start === 'string'
}

export function laneIdentity(identity = process.env) {
  return {
    pane_id: identity.HERDR_PANE_ID,
    lane_name: identity.UNBLOCK_LANE_NAME || identity.HERDR_LANE_NAME || identity.LANE_NAME,
  }
}

export function processStarts(pids) {
  const starts = new Map()
  const valid = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  if (!valid.length) return starts
  try {
    const output = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', valid.join(',')], { encoding: 'utf8', timeout: 5000 })
    for (const line of output.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      if (match) starts.set(Number(match[1]), match[2].trim())
    }
  } catch (error) {
    // ps exits 1 when none of the requested processes exist.
    if (error.status !== 1 || error.signal || String(error.stdout ?? '').trim() || String(error.stderr ?? '').trim()) return null
  }
  return starts
}

export function sameProcess(pid, start, starts) {
  try { process.kill(pid, 0) } catch (error) { if (error.code !== 'EPERM') return false }
  return typeof start === 'string' && starts.get(pid) === start
}
