// Owner: Opus (pHY, scope-approve, 2026-10-01). Implementers make it pass and never edit it.
// Alex, 2026-10-01 ~13:15 ET: "i've told a couple agents that i approve its scope, including the apps and agents one,
// give it the tools to mark the actual scoping docs as such as well please. see it through please."
// A PM relays an approval Alex gave in chat: `unblock scope approve <slug> --by alex --quote "<his words>" [--at <iso>]`
// (and the MCP tool unblock_scope_approve). It writes the same scope.approval every reader already counts as approved,
// with via 'pm-relay', his words verbatim and the time he said them in ET. Open comments stay open; the approval records
// how many. --quote is required: the PM never paraphrases him. `unblock scope unapprove <slug> --reason` takes it back.
// The page's banner says who approved, when, his words, that the PM relayed it, and how many comments were still open.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-10-01T15:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We build the page first. Then the voice.' },
]
const on = (quote) => anchorInSection(sections[1], quote)
const scopeWith = (slug) => ({
  version: 2, slug, title: 'Demo scope', pane: 'w5H:pT1', revision: 4, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: on('We build the page first'), author: 'agent', kind: 'question', status: 'open',
      recommendation: 'Page first', messages: [{ from: 'agent', text: 'Page or voice first?', at }], created_at: at },
    { id: 'T2', anchor: on('Then the voice'), author: 'alex', kind: 'comment', status: 'open',
      messages: [{ from: 'alex', text: 'Voice can wait.', at }], created_at: at },
  ],
})
const QUOTE = 'yes, i approve the apps and agents scope. see it through <b>please</b>'

function stubs() {
  const dir = mkdtempSync(join(tmpdir(), 'pm-approve-stubs-'))
  const herdrLog = join(dir, 'herdr.log'), laneLog = join(dir, 'lane.log')
  const herdr = join(dir, 'herdr'), lane = join(dir, 'herdr-lane')
  writeFileSync(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> '${herdrLog}'
case "$1 $2" in
  "pane get") echo '{"result":{"pane":{"pane_id":"w5H:pT1","tab_id":"w5H:tAB","agent_status":"idle"}}}' ;;
  "tab get") echo '{"result":{"tab":{"tab_id":"w5H:tAB","label":"[scoping] demo scope"}}}' ;;
  "agent get") echo '{"result":{"agent":{"agent_status":"idle"}}}' ;;
esac
`)
  writeFileSync(lane, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${laneLog}'\n`)
  chmodSync(herdr, 0o700); chmodSync(lane, 0o700)
  process.env.HERDR_BIN_PATH = herdr
  process.env.UNBLOCK_HERDR_LANE = lane
  const read = (file) => { try { return readFileSync(file, 'utf8') } catch { return '' } }
  return { herdrLines: () => read(herdrLog), laneLines: () => read(laneLog) }
}

function cliFor(h) {
  return (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args],
      { env: { ...process.env, UNBLOCK_PORT: String(h.port) } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('a PM relays Alex\'s approval with his words: approved for every reader, comments stay open, tab leaves SCOPING', async () => {
  const h = await startScopeHarness(scopeWith('demo'))
  const s = stubs()
  const cli = cliFor(h)
  const get = async () => (await h.request('/api/scope/demo', { headers: human })).json.scope
  const dir = join(process.env.UNBLOCK_SCOPING_DIR, 'demo')
  const index = join(process.env.UNBLOCK_SCOPING_DIR, 'INDEX.md')
  writeFileSync(index, '# Scoping\n')
  try {
    // 1. No quote, an empty quote, someone other than Alex, or a bad time: refused, nothing written.
    assert.notEqual((await cli('scope', 'approve', 'demo', '--by', 'alex')).status, 0, '--quote is required')
    assert.notEqual((await cli('scope', 'approve', 'demo', '--by', 'alex', '--quote', '   ')).status, 0, 'an empty quote is refused')
    assert.notEqual((await cli('scope', 'approve', 'demo', '--by', 'nate', '--quote', 'ok')).status, 0, 'only Alex approves')
    assert.notEqual((await cli('scope', 'approve', 'demo', '--by', 'alex', '--quote', 'ok', '--at', 'yesterday')).status, 0, '--at must be a time')
    assert.notEqual((await cli('scope', 'approve', 'demo', '--by', 'alex', '--quote', 'ok', '--at', '2099-01-01T00:00:00Z')).status, 0, '--at cannot be in the future')
    assert.equal((await get()).approval, undefined)

    // 2. The page approve route still refuses a lane; the relay path is its own.
    const lanePage = await h.request('/api/scope/demo/approve', { method: 'POST', headers: h.bearer, body: { mode: 'approve', comment: 'ok' } })
    assert.equal(lanePage.status, 403)

    // 3. Relay his approval with the time he said it.
    const ok = await cli('scope', 'approve', 'demo', '--by', 'alex', '--quote', QUOTE, '--at', '2026-10-01T17:15:00Z')
    assert.equal(ok.status, 0, ok.stderr)
    const scope = await get()
    const a = scope.approval
    assert.equal(a.mode, 'approve', 'readers count approve as approved')
    assert.equal(a.by, 'alex')
    assert.equal(a.via, 'pm-relay')
    assert.equal(a.quote, QUOTE, 'his words verbatim')
    assert.equal(a.comment, QUOTE, 'readers that show comment show his words')
    assert.equal(Date.parse(a.at), Date.parse('2026-10-01T17:15:00Z'), 'when he said it, not when the PM ran the tool')
    assert.equal(a.at_et, 'Oct 1, 1:15 PM ET')
    assert.equal(a.revision, 4)
    assert.equal(a.open, 2, 'approved with 2 open')
    assert.match(a.who, /pm-relay/)
    assert.deepEqual(scope.threads.map((t) => t.status), ['open', 'open'], 'open comments stay open')

    // 4. Files every other reader uses: APPROVAL.md and the INDEX log.
    const approvalMd = readFileSync(join(dir, 'APPROVAL.md'), 'utf8')
    assert.ok(approvalMd.includes(QUOTE), 'APPROVAL.md carries his words')
    assert.match(approvalMd, /pm-relay/)
    assert.match(approvalMd, /Oct 1, 1:15 PM ET/)
    assert.match(approvalMd, /2 open/)
    const logged = readFileSync(index, 'utf8')
    assert.match(logged, /## Approvals\n- Oct 1, 1:15 PM ET · demo r4 · approved · "yes, i approve the apps and agents scope/)

    // 5. The tab leaves SCOPING, same as a page approval.
    await h.until(() => s.laneLines().includes('section w5H:tAB inflight --by alex --note scope approved r4'), 'the tab moves to IN FLIGHT')
    await h.until(() => s.herdrLines().includes('tab rename w5H:tAB demo scope'), 'the [scoping] prefix is dropped')

    // 6. A second approval is refused; the first stands.
    const again = await cli('scope', 'approve', 'demo', '--by', 'alex', '--quote', 'again')
    assert.notEqual(again.status, 0)
    assert.equal((await get()).approval.quote, QUOTE)

    // 7. Unapprove needs a reason, then clears the approval and logs why.
    assert.notEqual((await cli('scope', 'unapprove', 'demo')).status, 0, '--reason is required')
    assert.equal((await get()).approval.quote, QUOTE)
    const undo = await cli('scope', 'unapprove', 'demo', '--reason', 'wrong scope, he meant apps-and-agents')
    assert.equal(undo.status, 0, undo.stderr)
    assert.equal((await get()).approval, undefined)
    assert.deepEqual((await get()).threads.map((t) => t.status), ['open', 'open'])
    assert.match(readFileSync(join(dir, 'APPROVAL.md'), 'utf8'), /wrong scope, he meant apps-and-agents/)
    assert.match(readFileSync(index, 'utf8'), /demo r4 · unapproved · "wrong scope, he meant apps-and-agents"/)
    assert.notEqual((await cli('scope', 'unapprove', 'demo', '--reason', 'twice')).status, 0, 'nothing to unapprove')

    // 8. Without --at the time is now.
    const now = await cli('scope', 'approve', 'demo', '--by', 'alex', '--quote', 'approved, go')
    assert.equal(now.status, 0, now.stderr)
    assert.ok(Math.abs(Date.parse((await get()).approval.at) - Date.now()) < 60_000)
  } finally { await h.close() }
})

test('MCP tools: unblock_scope_approve and unblock_scope_unapprove, quote and reason required', async () => {
  const h = await startScopeHarness(scopeWith('mcpdemo'))
  stubs()
  process.env.UNBLOCK_PORT = String(h.port)
  if (!existsSync(join(process.env.UNBLOCK_STATE_DIR, 'daemon.json'))) process.env.UNBLOCK_AUTH = h.bearer.Authorization.slice(7)
  const { McpConnection } = await import('../src/mcp.js')
  const replies = []
  const conn = new McpConnection((message) => replies.push(message))
  const call = async (method, params) => {
    const id = replies.length + 1000
    await conn.handle({ jsonrpc: '2.0', id, method, params })
    await h.until(() => replies.some((r) => r.id === id), `${method} reply`)
    return replies.find((r) => r.id === id)
  }
  const get = async () => (await h.request('/api/scope/mcpdemo', { headers: human })).json.scope
  try {
    const { tools } = (await call('tools/list', {})).result
    const approve = tools.find((t) => t.name === 'unblock_scope_approve')
    const unapprove = tools.find((t) => t.name === 'unblock_scope_unapprove')
    assert.ok(approve && unapprove, 'both tools are listed')
    assert.ok(approve.inputSchema.required.includes('slug') && approve.inputSchema.required.includes('quote'))
    assert.ok(unapprove.inputSchema.required.includes('slug') && unapprove.inputSchema.required.includes('reason'))

    const missing = await call('tools/call', { name: 'unblock_scope_approve', arguments: { slug: 'mcpdemo', quote: '' } })
    assert.ok(missing.error || missing.result?.isError, 'an empty quote is refused')
    assert.equal((await get()).approval, undefined)

    const ok = await call('tools/call', { name: 'unblock_scope_approve', arguments: { slug: 'mcpdemo', quote: 'this is good, approved', at: '2026-10-01T17:06:00Z' } })
    assert.ok(!ok.error && !ok.result?.isError, JSON.stringify(ok))
    const a = (await get()).approval
    assert.equal(a.via, 'pm-relay'); assert.equal(a.quote, 'this is good, approved'); assert.equal(a.at_et, 'Oct 1, 1:06 PM ET'); assert.equal(a.open, 2)

    const undo = await call('tools/call', { name: 'unblock_scope_unapprove', arguments: { slug: 'mcpdemo', reason: 'test' } })
    assert.ok(!undo.error && !undo.result?.isError, JSON.stringify(undo))
    assert.equal((await get()).approval, undefined)
  } finally { delete process.env.UNBLOCK_AUTH; await h.close() }
})

test('the page banner says who, when, his words, relayed by the PM, and how many comments were open', async () => {
  const { approvalBannerHtml } = await import('../web/src/scope/approval-banner.js')
  const relayed = approvalBannerHtml({ mode: 'approve', by: 'alex', who: 'pm-relay:w5H:pT1', at: '2026-10-01T17:15:00.000Z', at_et: 'Oct 1, 1:15 PM ET',
    revision: 4, comment: QUOTE, quote: QUOTE, via: 'pm-relay', open: 2 })
  const text = relayed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.match(text, /Approved by Alex/)
  assert.match(text, /Oct 1, 1:15 PM ET/)
  assert.ok(relayed.includes('yes, i approve the apps and agents scope. see it through &lt;b&gt;please&lt;/b&gt;'), 'his words, escaped')
  assert.ok(!relayed.includes('<b>please</b>'))
  assert.match(text, /relayed by the PM/i)
  assert.match(text, /2 open/)
  assert.ok(!/style=/.test(relayed), 'no inline styles')

  const page = approvalBannerHtml({ mode: 'approve', by: 'alex', who: 'alex@example.com', at: at, at_et: 'Oct 1, 11:00 AM ET', revision: 3, comment: 'ship it' })
  const pageText = page.replace(/<[^>]+>/g, ' ')
  assert.match(pageText, /Approved by Alex/)
  assert.match(pageText, /ship it/)
  assert.doesNotMatch(pageText, /relayed/i)
  assert.equal(approvalBannerHtml(undefined), '')
})
