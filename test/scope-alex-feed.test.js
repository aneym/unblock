// Integration: real scope HTTP writes and SQLite notes cross the alex-said
// subprocess boundary. Existing scope tests do not exercise feed delivery.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Store } from '../src/store.js'
import { human, startScopeHarness } from './scope-harness.js'

const initial = {
  slug: 'demo', title: 'Demo scope', updated_at: '2026-10-03T20:00:00Z',
  plan_md: 'Build the feed.', questions: [],
}

test('Alex comments, replies and resolution words reach the feed; agent notes and disabled writes do not', async () => {
  const previousBin = process.env.UNBLOCK_ALEX_FEED_BIN
  const previousFeed = process.env.UNBLOCK_ALEX_FEED
  // Configure before starting the harness so no note can reach the installed writer.
  process.env.UNBLOCK_ALEX_FEED = '0'
  const h = await startScopeHarness(initial)
  const bin = join(process.env.UNBLOCK_STATE_DIR, 'alex-feed-stub')
  const log = join(process.env.UNBLOCK_STATE_DIR, 'feed.jsonl')
  const failed = join(process.env.UNBLOCK_STATE_DIR, 'failed')
  const payloads = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const post = (path, body, headers = human) => h.request(`/api/scope/demo/${path}`, { method: 'POST', headers, body })
  try {
    writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs'); let input = '';\nprocess.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk });\nprocess.stdin.on('end', () => { if (process.argv[2] !== '--feed-append') process.exit(2); fs.appendFileSync(${JSON.stringify(log)}, input + '\\n') });\n`)
    chmodSync(bin, 0o700)
    process.env.UNBLOCK_ALEX_FEED_BIN = bin
    delete process.env.UNBLOCK_ALEX_FEED

    const comment = await post('threads', { anchor: { section: 'title', quote: 'Demo scope' }, text: 'Keep every comment.' })
    assert.equal(comment.status, 201)
    const thread = comment.json.thread.id
    assert.equal((await post(`threads/${thread}/reply`, { text: 'Include replies too.' })).status, 200)
    assert.equal((await post(`threads/${thread}/resolve`, { decision: 'Append to the feed', alex_words: 'Yes, keep my exact words.' })).status, 200)
    await h.until(() => payloads().length === 3, 'three feed payloads')
    const notes = (await h.request('/api/scope/demo/notes', { headers: h.bearer })).json.notes
    assert.equal(notes.length, 3)
    const received = payloads().sort((a, b) => a.ref.localeCompare(b.ref))
    assert.deepEqual(received, notes.map(note => ({
      source: 'scope', slug: 'demo', thread, event: note.event, text: note.text,
      words: note.words, anchor: 'Demo scope', at: note.at, ref: `scope_notes:${note.id}`,
    })).sort((a, b) => a.ref.localeCompare(b.ref)))
    assert.deepEqual(received.map(row => [row.event, row.text, row.words]), [
      ['new', 'Keep every comment.', null],
      ['reply', 'Include replies too.', null],
      ['resolve', 'Append to the feed', 'Yes, keep my exact words.'],
    ])

    // An actual agent-authored SQLite note must not spawn the writer.
    const store = new Store(join(process.env.UNBLOCK_STATE_DIR, 'queue.db'))
    try {
      const agent = store.addScopeNote({ slug: 'demo', author: 'agent', kind: 'thought', text: 'Agent note' })
      assert.equal(agent.from, 'agent')
    } finally { store.close() }
    process.env.UNBLOCK_ALEX_FEED = '0'
    assert.equal((await post(`threads/${thread}/reply`, { text: 'Disabled feed note.' })).status, 200)
    delete process.env.UNBLOCK_ALEX_FEED
    // A subsequent successful append fences the skipped writes at the real boundary.
    assert.equal((await post(`threads/${thread}/reply`, { text: 'Feed resumed.' })).status, 200)
    await h.until(() => payloads().length === 4, 'resumed feed append')
    assert.equal(payloads().at(-1).text, 'Feed resumed.')

    writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(failed)}, 'attempted'); process.exit(1) });\n`)
    const failure = await post(`threads/${thread}/reply`, { text: 'Stored even if the feed fails.' })
    assert.equal(failure.status, 200)
    await h.until(() => existsSync(failed), 'failing writer attempted')
    await h.restart()
    const persisted = (await h.request('/api/scope/demo/notes', { headers: h.bearer })).json.notes
    assert.ok(persisted.some(note => note.text === 'Stored even if the feed fails.' && note.from === 'alex'))
    assert.equal(payloads().length, 4)
  } finally {
    await h.close()
    if (previousBin === undefined) delete process.env.UNBLOCK_ALEX_FEED_BIN
    else process.env.UNBLOCK_ALEX_FEED_BIN = previousBin
    if (previousFeed === undefined) delete process.env.UNBLOCK_ALEX_FEED
    else process.env.UNBLOCK_ALEX_FEED = previousFeed
  }
})
