// Real daemon, answerer process and failing edit-tool boundary: diagnostic text stays lane-only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { startScopeHarness, human } from './scope-harness.js'

for (const size of [80, 5000]) {
  test(`edit failure keeps ${size}-character stderr out of replies and bounds the lane diagnostic`, async () => {
    const scope = { version: 2, slug: 'paper-kite', title: 'Paper kite', pane: 'demo:owner', revision: 1,
      updated_at: '2026-01-01T00:00:00Z', threads: [],
      doc: { sections: [{ id: 'title', heading: 'Paper kite', body_md: 'Fold the paper.' }] } }
    const h = await startScopeHarness(scope)
    const saved = Object.fromEntries(['UNBLOCK_ANSWERER_BIN', 'UNBLOCK_CLI_BIN', 'UNBLOCK_LANE_POST_BIN', 'UNBLOCK_SUPERVISED'].map(key => [key, process.env[key]]))
    const dir = dirname(process.env.HERDR_BIN_PATH)
    const answerer = join(dir, 'answerer'), edit = join(dir, 'edit'), lane = join(dir, 'lane'), log = join(dir, 'posts.jsonl')
    const stderr = `Private diagnostic: internal-stack.js:42\n${'x'.repeat(size)}`
    const executable = (path, source) => { writeFileSync(path, `#!/usr/bin/env node\n${source}`); chmodSync(path, 0o700) }
    executable(answerer, `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.\\nEDIT title\\n## Paper kite {#title}\\nFold twice.\\nEND_EDIT' })))`)
    executable(edit, `process.stderr.write(${JSON.stringify(stderr)}); process.exit(2)`)
    executable(lane, `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('b-20260101000000-abcd')`)
    Object.assign(process.env, { UNBLOCK_ANSWERER_BIN: answerer, UNBLOCK_CLI_BIN: edit, UNBLOCK_LANE_POST_BIN: lane, UNBLOCK_SUPERVISED: '1' })
    const until = async (check, label) => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
      assert.fail(`${label} not reached within 20s`)
    }
    try {
      const result = await h.request('/api/scope/paper-kite/threads', { method: 'POST', headers: human,
        body: { text: 'Please fold twice.', anchor: anchorInSection(scope.doc.sections[0], 'Fold the paper') } })
      assert.ok([200, 201].includes(result.status), result.text)
      const stored = () => JSON.parse(readFileSync(join(process.env.UNBLOCK_SCOPING_DIR, scope.slug, 'scope.json'), 'utf8'))
      await until(() => stored().threads[0]?.messages.some(m => m.from === 'agent' && !m.pending), 'reply')
      const reply = stored().threads[0].messages.find(m => m.from === 'agent' && !m.pending).text
      assert.equal(reply, 'The edit tool failed; the lane has the details.')
      assert.ok(!reply.includes('Private diagnostic'))
      await until(() => { try { return readFileSync(log, 'utf8').includes('Edit stderr:') } catch { return false } }, 'lane diagnostic')
      const args = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(args => args.includes('--text') && args[args.indexOf('--text') + 1].includes('Edit stderr:'))
      const message = args[args.indexOf('--text') + 1]
      const diagnostic = message.split('\nEdit stderr:\n')[1]
      assert.equal(diagnostic, stderr.slice(0, 2000) + (stderr.length > 2000 ? '\n[stderr truncated]' : ''))
      assert.ok(message.length <= 700 + '\nEdit stderr:\n'.length + 2000 + '\n[stderr truncated]'.length)
    } finally {
      await h.close()
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  })
}
