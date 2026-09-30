// Owner: Opus (r38, ⌘Enter on a lane-ask card decides from Alex's note). Implementers copy it to test/ and make it pass; they never edit it.
// Alex (2026-09-30 09:55 ET): "if i do cmd enter with no comment, we can take that as 'take it' and with a comment, we
// should use the context of the comment to decide, but typically it's obvious based on what the comment says."
// POST /api/scope/<slug>/threads/<T>/pick {text} asks a bounded picker (Jev behind the UNBLOCK_ASK_PICKER_BIN seam) which
// button his note means: take, one of the other options, no, or something else. It only answers; the page applies the
// choice (with Undo) through the usual verbs. Below the confidence cut (UNBLOCK_ASK_PICK_MIN, default 0.6) it says
// sure:false and the page asks him to click. No picker, or a failed one, is never an error: choice null, sure false.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { anchorInSection } from '../src/scope-doc.js'
import { human, startScopeHarness } from './scope-harness.js'

const at = '2026-09-30T14:00:00Z'
const sections = [
  { id: 'title', heading: 'Demo scope', body_md: 'A small page.' },
  { id: 'plan', heading: 'The plan', body_md: 'We roll the router out to one lane first. Then the review.' },
]
const scope = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 2, updated_at: at, doc: { sections },
  threads: [
    { id: 'T1', anchor: anchorInSection(sections[1], 'We roll the router out to one lane first'), author: 'agent', kind: 'question', status: 'open', recommendation: 'One lane first, all lanes after E16', options: ['One lane first, all lanes after E16', 'All lanes after the first clean day', 'Keep it on one lane for a month'], why: 'E16 is the check.', messages: [{ from: 'agent', text: 'How do we roll out the router?', at }], created_at: at },
    { id: 'T2', anchor: anchorInSection(sections[1], 'Then the review'), author: 'alex', kind: 'comment', status: 'open', messages: [{ from: 'alex', text: 'Who reviews?', at }], created_at: at },
  ],
}

test('pick: a bounded picker maps his note to a button; unsure or missing means he clicks', async () => {
  const h = await startScopeHarness(scope)
  const { request, bearer } = h
  const dir = dirname(process.env.HERDR_BIN_PATH)
  const log = join(dir, 'picker.log'), bin = join(dir, 'picker-stub')
  // A stand-in for `jev decide <elements.json> "<goal>"`: logs its args and the elements file, answers on his exact note.
  // The goal reads: The lane asked: "<question>". Alex replied: "<note>". Pick the button that matches what Alex meant.
  writeFileSync(bin, `#!/bin/sh
printf '%s\\x1f%s\\x1f' "$1" "$3" >> '${log}'; cat "$2" >> '${log}'; printf '\\n' >> '${log}'
case "$3" in
  *'Alex replied: "yes but only after E16"'*) echo '{"target":"take","confidence":0.82}';;
  *'Alex replied: "all lanes after the first clean day is fine"'*) echo '{"target":"option-1","confidence":0.77}';;
  *'Alex replied: "no, wait a week"'*) echo '{"target":"no","confidence":0.7}';;
  *'Alex replied: "use devin for this instead"'*) echo '{"target":"else","confidence":0.82}';;
  *'Alex replied: "hmm"'*) echo '{"target":"else","confidence":0.4}';;
  *'Alex replied: "crash"'*) echo 'not json'; exit 3;;
  *'Alex replied: "bogus"'*) echo '{"target":"delete-everything","confidence":0.99}';;
esac
`)
  chmodSync(bin, 0o700)
  const pick = (id, body, headers = human) => request(`/api/scope/demo/threads/${id}/pick`, { method: 'POST', headers, body })
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  try {
    // With no picker configured (tests never set UNBLOCK_SUPERVISED): never an error, just unsure.
    delete process.env.UNBLOCK_ASK_PICKER_BIN
    let r = await pick('T1', { text: 'yes but only after E16' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.json.choice, r.json.sure], [null, false])

    process.env.UNBLOCK_ASK_PICKER_BIN = bin
    // Each branch Alex listed.
    r = await pick('T1', { text: 'yes but only after E16' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.sure, true); assert.equal(r.json.choice.action, 'take'); assert.equal(r.json.confidence, 0.82)
    assert.equal(r.json.choice.label, 'One lane first, all lanes after E16')
    r = await pick('T1', { text: 'all lanes after the first clean day is fine' })
    assert.deepEqual(r.json.choice, { action: 'option', option: 1, label: 'All lanes after the first clean day' }); assert.equal(r.json.sure, true)
    r = await pick('T1', { text: 'no, wait a week' })
    assert.equal(r.json.choice.action, 'no'); assert.equal(r.json.sure, true)
    r = await pick('T1', { text: 'use devin for this instead' })
    assert.equal(r.json.choice.action, 'else'); assert.equal(r.json.sure, true)
    // Unsure: below the cut, the choice comes back for the page to hint at, but sure is false.
    r = await pick('T1', { text: 'hmm' })
    assert.equal(r.json.sure, false); assert.equal(r.json.choice?.action, 'else')
    // The cut is a config value.
    process.env.UNBLOCK_ASK_PICK_MIN = '0.9'
    r = await pick('T1', { text: 'yes but only after E16' })
    assert.equal(r.json.sure, false)
    delete process.env.UNBLOCK_ASK_PICK_MIN
    // A failing picker, or one naming a button that isn't there: unsure, never a 500.
    r = await pick('T1', { text: 'crash' })
    assert.equal(r.status, 200); assert.deepEqual([r.json.choice, r.json.sure], [null, false])
    r = await pick('T1', { text: 'bogus' })
    assert.equal(r.status, 200); assert.deepEqual([r.json.choice, r.json.sure], [null, false])

    // What the picker saw: `decide <file> <goal>`; the goal has the question and his whole note; the file lists
    // every button, including options the card keeps collapsed.
    const [first] = calls().filter((c) => c.includes('only after E16'))
    const [verb, goal, file] = first.split('\x1f')
    assert.equal(verb, 'decide')
    assert.match(goal, /How do we roll out the router\?/)
    assert.equal(goal, 'The lane asked: "How do we roll out the router?". Alex replied: "yes but only after E16". Pick the button that matches what Alex meant.')
    const elements = JSON.parse(file).elements
    assert.deepEqual(elements.map((e) => e.ref), ['take', 'option-1', 'option-2', 'no', 'else'])
    assert.match(elements[0].name, /One lane first, all lanes after E16/)
    assert.match(elements[2].name, /Keep it on one lane for a month/)

    // Only Alex picks, only on an open lane question, only with words.
    assert.equal((await pick('T1', { text: 'yes' }, bearer)).status, 403)
    assert.equal((await pick('T2', { text: 'yes' })).status, 400)
    assert.equal((await pick('T1', { text: '   ' })).status, 400)
    assert.equal((await pick('T99', { text: 'yes' })).status, 404)
    assert.equal((await pick('T1', { text: 'x'.repeat(4001) })).status, 400)

    // Picking writes nothing: same revision, no notes, T1 still open.
    const state = (await request('/api/scope/demo', { headers: human })).json
    assert.equal(state.scope.revision, 2)
    assert.equal(state.scope.threads.find((t) => t.id === 'T1').status, 'open')
    assert.equal(state.notes.length, 0)
  } finally { delete process.env.UNBLOCK_ASK_PICKER_BIN; delete process.env.UNBLOCK_ASK_PICK_MIN; await h.close() }
})
