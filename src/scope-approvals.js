import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const compact = (text) => text.replace(/\s+/g, ' ').trim()
const run = (bin, args, timeout) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout }, (error, stdout) => error ? reject(error) : resolve(stdout))
})

export function appendApprovalIndex(root, { slug, revision, mode, comment, at_et }) {
  const index = join(root, 'INDEX.md')
  const previous = existsSync(index) ? readFileSync(index, 'utf8') : ''
  const text = compact(comment)
  const log = `- ${at_et} · ${slug} r${revision} · ${mode === 'approve' ? 'approved' : mode === 'approve_with_changes' ? 'approved with changes' : 'not yet'} · ${text ? `"${text.slice(0, 160)}"` : '(no note)'}\n`
  const heading = /^## Approvals[ \t]*$/m.exec(previous)
  let updated
  if (heading) {
    const start = previous.indexOf('\n', heading.index)
    const next = start < 0 ? -1 : previous.slice(start + 1).search(/^## /m)
    const end = next < 0 ? previous.length : start + 1 + next
    updated = previous.slice(0, end) + (end && previous[end - 1] !== '\n' ? '\n' : '') + log + previous.slice(end)
  } else updated = previous + (previous && !previous.endsWith('\n') ? '\n' : '') + '\n## Approvals\n' + log
  writeFileSync(index, updated)
}

export async function moveTabToInflight({ pane, revision, herdr = process.env.HERDR_BIN_PATH || 'herdr', herdrLane = process.env.UNBLOCK_HERDR_LANE || join(homedir(), '.local/bin/herdr-lane') }) {
  try {
    if (typeof pane !== 'string' || !pane.trim()) return
    const tab = JSON.parse(await run(herdr, ['pane', 'get', pane], 10000)).result?.pane?.tab_id
    if (!tab) return
    const label = JSON.parse(await run(herdr, ['tab', 'get', tab], 10000)).result?.tab?.label
    if (typeof label === 'string' && label.startsWith('[scoping]')) await run(herdr, ['tab', 'rename', tab, label.slice(9).trim()], 10000)
    await run(herdrLane, ['section', tab, 'inflight', '--by', 'alex', '--note', `scope approved r${revision}`], 10000)
  } catch { /* Moving the tab is best effort; the approval is already durable. */ }
}

export function createLivedocApprovals({
  root = process.env.UNBLOCK_SCOPING_DIR || join(homedir(), '.agent-rails', 'scoping'),
  stateFile = join(process.env.UNBLOCK_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock'), 'livedoc-approvals.json'),
  livedoc = process.env.UNBLOCK_LIVEDOC_BIN || join(homedir(), '.local/bin/livedoc'),
  herdr = process.env.HERDR_BIN_PATH || 'herdr',
  herdrLane = process.env.UNBLOCK_HERDR_LANE || join(homedir(), '.local/bin/herdr-lane'),
} = {}) {
  let seen = []
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (Array.isArray(state.seen)) seen = state.seen.filter((key) => typeof key === 'string').slice(-500)
  } catch {}
  let running = null, timer = null

  async function poll() {
    try {
      const list = JSON.parse(await run(livedoc, ['--json', 'list'], 20000))
      if (!Array.isArray(list.docs)) return
      for (const item of list.docs) {
        let data
        try {
          data = JSON.parse(await run(livedoc, ['--json', 'show', item.slug], 20000))
          if (!data?.doc || typeof data.doc.slug !== 'string') continue
        } catch { continue }
        const { doc, approval } = data
        if (!approval) continue
        const slug = doc.slug, key = slug + '\n' + approval.at
        if (seen.includes(key)) continue
        appendApprovalIndex(root, { slug, revision: approval.revision, mode: approval.mode, comment: approval.comment, at_et: approval.at_et })
        if (['approve', 'approve_with_changes'].includes(approval.mode) && typeof doc.pane === 'string' && doc.pane.trim()) {
          await moveTabToInflight({ pane: doc.pane, revision: approval.revision, herdr, herdrLane })
        }
        const next = [...seen, key].slice(-500)
        mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 })
        writeFileSync(stateFile + '.tmp', JSON.stringify({ seen: next }), { mode: 0o600 })
        renameSync(stateFile + '.tmp', stateFile)
        seen = next
      }
    } catch { /* Retry on the next tick when livedoc or local storage is unavailable. */ }
  }

  function tick() {
    if (!running) running = poll().finally(() => { running = null })
    return running
  }

  function start(ms) {
    stop()
    void tick()
    timer = setInterval(() => { void tick() }, ms)
    timer.unref()
  }

  function stop() {
    clearInterval(timer)
    timer = null
  }

  return { tick, start, stop }
}
