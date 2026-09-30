import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

export function filerPid() {
  const override = Number(process.env.UNBLOCK_ORIGIN_PID)
  if (Number.isSafeInteger(override) && override > 0) return override
  const passthrough = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'timeout', 'nohup', 'xargs', 'time'])
  let pid = process.ppid
  const seen = new Set()
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid)
    try {
      const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim()
      const match = line.match(/^(\d+)\s+(.+)$/)
      if (!match) return undefined
      if (!passthrough.has(basename(match[2]))) return pid
      pid = Number(match[1])
    } catch { return undefined }
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
