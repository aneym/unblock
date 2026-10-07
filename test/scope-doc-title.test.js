// Pure Markdown parser regression: explicit heading IDs are metadata, not title text.
// Table covers suffix whitespace, arbitrary IDs, plain headings and literal non-suffix braces.
import assert from 'node:assert/strict'
import test from 'node:test'
import { docFromMarkdown } from '../src/scope-doc.js'

test('Markdown H1 drops trailing explicit IDs without changing the title section identity', () => {
  for (const [source, heading] of [
    ['# Scoping review {#title}', 'Scoping review'],
    ['# Factory efficiency {#outcome}   ', 'Factory efficiency'],
    ['# Plain title', 'Plain title'],
    ['# A {#literal} example', 'A {#literal} example'],
  ]) {
    assert.deepEqual(docFromMarkdown(`${source}\n\nRecommendation.\n\n## Context {#context}\nProblem.`).sections, [
      { id: 'title', heading, body_md: 'Recommendation.' },
      { id: 'context', heading: 'Context', body_md: 'Problem.' },
    ], source)
  }
})
