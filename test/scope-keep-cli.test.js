// Exercise the real CLI and store with synthetic input only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startScopeHarness } from './scope-harness.js'
import { docToMarkdown } from '../src/scope-doc.js'

const initial = {
  version: 2, slug: 'paper-kite', title: 'Paper kite', pane: '', revision: 1,
  updated_at: '2026-01-01T00:00:00Z', threads: [],
  doc: { sections: [{ id: 'title', heading: 'Paper kite', body_md: 'Make a small kite.' },
    { id: 'north', heading: 'The plan', body_md: 'Fold the paper.' }] },
}
function cli(h, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), 'scope', ...args], {
      env: { ...process.env, UNBLOCK_PORT: String(h.port) },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('saved word terms survive edits; exemptions are section-counted and doc-only; keep is bounded and removable', async () => {
  const h = await startScopeHarness(initial)
  const dir = join(process.env.UNBLOCK_SCOPING_DIR, initial.slug)
  const file = join(dir, 'section.md'), doc = join(dir, 'doc.md')
  const stored = () => JSON.parse(readFileSync(join(dir, 'scope.json'), 'utf8'))
  const patch = async (body, ...flags) => {
    writeFileSync(file, `## The plan {#north}\n\n${body}\n`)
    return cli(h, 'patch', initial.slug, 'north', '--from', file, ...flags)
  }
  try {
    const publishedDoc = structuredClone(initial.doc)
    publishedDoc.sections[1].body_md = 'The north star is a small kite.'
    writeFileSync(doc, docToMarkdown(publishedDoc))
    const published = await cli(h, 'doc', initial.slug, '--from', doc, '--keep', 'north star', '--keep', 'NORTH STAR')
    assert.equal(published.status, 0, published.stderr)
    assert.deepEqual(stored().keep, ['north star'])
    const edited = 'The north star is a small kite. Fold the corners next.'
    assert.equal((await patch(edited)).status, 0)
    assert.equal(stored().doc.sections[1].body_md.trim(), edited)
    assert.equal((await cli(h, 'keep', initial.slug, '--remove', 'NORTH STAR')).status, 0)
    assert.deepEqual(stored().keep, [])
    // Approved vocabulary is retained without a saved keep, but cannot multiply or move sections.
    assert.equal((await patch(`${edited} Add a string.`)).status, 0)
    assert.notEqual((await patch(`${edited} Another north star.`)).status, 0)
    const moved = structuredClone(stored().doc)
    moved.sections[0].body_md = 'The north star is a kite.'
    writeFileSync(doc, docToMarkdown(moved))
    assert.notEqual((await cli(h, 'doc', initial.slug, '--from', doc)).status, 0)
    assert.notEqual((await cli(h, 'lint', initial.slug, '--from', doc)).status, 0)
    const asked = await cli(h, 'ask', initial.slug, '--section', 'north', '--quote', 'small kite', 'Which paper?')
    assert.equal(asked.status, 0, asked.stderr)
    const id = stored().threads.at(-1).id
    const reply = await cli(h, 'reply', initial.slug, id, 'The north star is a kite.')
    assert.notEqual(reply.status, 0)
    assert.match(reply.stderr, /jargon/)
    assert.notEqual((await cli(h, 'resolve', initial.slug, id, '--decision', 'The north star is a kite.')).status, 0)
    assert.notEqual((await patch('Fold the paper.', '--keep', '—')).status, 0)
    const disk = stored()
    disk.doc.sections[1].body_md = 'Fold — then tie.'
    writeFileSync(join(dir, 'scope.json'), JSON.stringify(disk))
    assert.equal((await patch('Fold — then tie. Add string.')).status, 0)
    const dashes = await patch('Fold — then tie — then fly — then rest.')
    assert.notEqual(dashes.status, 0)
    assert.match(dashes.stderr, /em-dash/)
    writeFileSync(doc, docToMarkdown({ sections: [initial.doc.sections[0], { id: 'north', heading: 'The plan', body_md: 'Fold the paper.' }] }))
    const flags = Array.from({ length: 50 }, (_, i) => ['--keep', `word${i}`]).flat()
    assert.equal((await cli(h, 'doc', initial.slug, '--from', doc, ...flags)).status, 0)
    assert.equal(stored().keep.length, 50)
    assert.notEqual((await patch('Fold the paper.', '--keep', 'another')).status, 0)
    assert.equal(stored().keep.length, 50)
    assert.equal((await cli(h, 'keep', initial.slug, '--remove', 'word0')).status, 0)
    assert.equal((await patch('Fold the paper.', '--keep', 'another')).status, 0)
    assert.equal(stored().keep.length, 50)
  } finally { await h.close() }
})
