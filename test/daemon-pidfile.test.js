// Scenario (owner: Opus): a restart frees the port before the old daemon finishes closing, and a CLI or MCP call
// can start a daemon in that gap. The old daemon must not delete the new one's daemon.json: launchd's supervised
// start evicts a squatter only by that pid, so on 5 Oct it crash-looped on EADDRINUSE while an unsupervised copy
// of the previous install kept serving.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const temp = mkdtempSync(join(tmpdir(), 'unblock-pidfile-'))
Object.assign(process.env, {
  UNBLOCK_STATE_DIR: temp, UNBLOCK_CONFIG_DIR: join(temp, 'config'), UNBLOCK_SECRET_BACKEND: 'env',
  UNBLOCK_SCOPING_DIR: join(temp, 'scopes'), UNBLOCK_ALEX_FEED: '0',
})
const { startDaemon } = await import('../src/daemon.js')
const file = join(temp, 'daemon.json')

test('a stopping daemon removes daemon.json only while it names that daemon', async () => {
  try {
    const old = await startDaemon({ port: 0 })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid)
    const newer = { port: 4488, pid: process.pid + 1, started_at: new Date().toISOString() }
    writeFileSync(file, `${JSON.stringify(newer)}\n`)
    await old.close()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), newer)

    // Its own record goes as close() begins, while it still holds the port, so nothing written later is touched.
    const own = await startDaemon({ port: 0 })
    const closing = own.close()
    assert.equal(existsSync(file), false)
    await closing

    // A record that is not a daemon's never stops shutdown.
    const odd = await startDaemon({ port: 0 })
    writeFileSync(file, 'null\n')
    await odd.close()
    assert.equal(odd.server.listening, false)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
