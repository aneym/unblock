// POST /api/scope/<slug>/telemetry: the scope page beacons a compact summary of its own load;
// one JSON line per report goes to scope-telemetry.jsonl under the state dir.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_BODY = 16384
const MAX_FILE = 2 * 1024 * 1024

const stateDir = () => process.env.UNBLOCK_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'unblock')

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { over = true; chunks.length = 0; return }
      if (!over) chunks.push(chunk)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function handleScopeTelemetry({ req, res, slug, proxyIdentity, sendJson }) {
  const origin = req.headers.origin
  const sameOrigin = Boolean(origin) && (origin === `http://${req.headers.host}` || origin === process.env.UNBLOCK_PUBLIC_ORIGIN)
  if (!proxyIdentity(req) && !sameOrigin) return sendJson(res, 403, { error: 'telemetry_forbidden' })
  const text = await readBody(req)
  if (text === null) return sendJson(res, 413, { error: 'telemetry_too_large' })
  let report
  try { report = JSON.parse(text) } catch { return sendJson(res, 400, { error: 'telemetry_invalid' }) }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return sendJson(res, 400, { error: 'telemetry_invalid' })
  const dir = stateDir()
  const file = join(dir, 'scope-telemetry.jsonl')
  try {
    mkdirSync(dir, { recursive: true })
    try { if (statSync(file).size > MAX_FILE) renameSync(file, `${file}.1`) } catch { /* No file yet. */ }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), slug, ua: String(req.headers['user-agent'] || '').slice(0, 200), report })}\n`)
  } catch {
    return sendJson(res, 500, { error: 'telemetry_unwritable' })
  }
  res.writeHead(204)
  res.end()
}
