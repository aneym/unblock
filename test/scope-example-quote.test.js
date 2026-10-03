import assert from 'node:assert/strict'
import test from 'node:test'
import { markdown } from '../web/src/scope/markdown.ts'

test('selecting a rendered example quotes only the words from the document', () => {
  const words = 'Run the check before shipping.'
  const html = markdown(`\`\`\`example\n${words}\n\`\`\``)
  const selectedText = html.replace(/<[^>]*>/g, '')
  assert.equal(selectedText, words)
})

test('terms render as structured entries and their example quotes exclude generated labels', () => {
  const html = markdown('```terms\nagent :: A worker that acts on a task.\ne.g. Run the check.\nNot: A model alone.\nSee: lane\nCode: rails\n```')
  assert.match(html, /<dl class="terms">/)
  assert.match(html, /<dt><span class="term">agent<\/span>/)
  assert.doesNotMatch(html, /<(?:pre|code)(?:\s|>)/)
  const example = html.match(/<p class="eg">([\s\S]*?)<\/p>/)
  assert.ok(example)
  assert.equal(example[1].replace(/<[^>]*>/g, ''), 'Run the check.')
})
