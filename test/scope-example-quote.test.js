import assert from 'node:assert/strict'
import test from 'node:test'
import { markdown } from '../web/src/scope/markdown.ts'

test('selecting a rendered example quotes only the words from the document', () => {
  const words = 'Run the check before shipping.'
  const html = markdown(`\`\`\`example\n${words}\n\`\`\``)
  const selectedText = html.replace(/<[^>]*>/g, '')
  assert.equal(selectedText, words)
})
