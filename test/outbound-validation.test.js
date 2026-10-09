import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const state = mkdtempSync(join(tmpdir(), 'unblock-outbound-'))
process.env.UNBLOCK_STATE_DIR = state
process.env.UNBLOCK_CONFIG_DIR = join(state, 'config')
process.env.UNBLOCK_SECRET_BACKEND = 'env'
const { startDaemon } = await import('../src/daemon.js')
function file(ask) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '../bin/unblock.js'), 'file', '-', '--json'],
      { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', rc => resolve({ rc, stdout, stderr }))
    child.stdin.end(JSON.stringify(ask))
  })
}
test('outbound files once and invalid asks return every repair in one response', async () => {
  const daemon = await startDaemon({ port: 0 })
  process.env.UNBLOCK_PORT = String(daemon.port)
  const ask = { purpose: 'message', level: 'P2', title: 'Approve fixture message',
    why: 'A local fixture exercises the outbound approval path.', only_you: 'message',
    tried: ['Checked the local fixture; only approval remains.'],
    message: { to: 'fixture@example.invalid', via: 'email', text: 'Local fixture only.' } }
  try {
    const good = await file(ask)
    assert.equal(good.rc, 0, good.stderr)
    assert.equal(JSON.parse(good.stdout).purpose, 'message')
    const bad = await file({ ...ask, purpose: 'approval', level: 'P9', only_you: 'outbound',
      fields: [], message: { to: 42, via: 'carrier pigeon', text: 42 } })
    assert.notEqual(bad.rc, 0)
    for (const path of ['purpose:', 'level:', 'only_you:', 'fields:', 'message.to:', 'message.via:', 'message.text:']) {
      assert.ok(bad.stderr.includes(path), `${path} missing from ${bad.stderr}`)
    }
    assert.match(bad.stderr, /email, slack, linkedin, sms, other/)
  } finally {
    await daemon.close()
    rmSync(state, { recursive: true, force: true })
  }
})
