/** Mint an ephemeral queue link and surface it — for answering from a phone. */
import { execFileSync } from 'node:child_process'
import { api } from './paths.js'
import { notify } from './herdr.js'

const { url, expires_at } = await api('/api/links', { ttl_seconds: 900 })
const mins = Math.max(1, Math.round((expires_at - Date.now()) / 60000))

const lines = [url]
const host = process.env.TAILSCALE_HOST || tailnetHost()
if (host) lines.push(url.replace('http://127.0.0.1', `https://${host}`))

console.log(lines.join('\n'))
console.log(`expires in ${mins}m`)
await notify('unblock', lines[lines.length - 1])

function tailnetHost() {
  try {
    const out = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(out)?.Self?.DNSName?.replace(/\.$/, '') || null
  } catch {
    return null // no tailscale, or not up. The localhost URL still works.
  }
}
