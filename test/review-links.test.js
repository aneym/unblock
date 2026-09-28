import test from 'node:test'
import assert from 'node:assert/strict'

import { isImageUrl, reviewLinks } from '../src/queue-model.js'

const decision = (links, fields = []) => ({ ticket: 'ub_t', purpose: 'decision', fields, links })

test('a sign-off decision shows every link, the first one included', () => {
  const ask = decision([
    { label: 'Workspace screens', url: 'https://studio.example.ts.net:8799/blocks-f-shots.html' },
    { label: 'Exhibit', url: 'https://exhibits.sh/w/rails/rails-blocks' },
  ])
  const { images, pages } = reviewLinks(ask)
  assert.deepEqual(images, [])
  assert.deepEqual(pages.map((link) => link.url), [
    'https://studio.example.ts.net:8799/blocks-f-shots.html',
    'https://exhibits.sh/w/rails/rails-blocks',
  ])
  assert.equal(pages[0].label, 'Workspace screens')
})

test('a single link is not lost', () => {
  const { pages } = reviewLinks(decision([{ label: 'Plan', url: 'https://github.com/o/r/issues/1581' }]))
  assert.equal(pages.length, 1)
})

test('image links are split out so the page can show the picture itself', () => {
  const { images, pages } = reviewLinks(decision([
    { label: 'Before', url: 'https://host.example/shots/before.png' },
    { label: 'After', url: 'https://host.example/shots/after.WEBP?v=2' },
    { label: 'Doc', url: 'https://host.example/doc.html' },
  ]))
  assert.deepEqual(images.map((link) => link.label), ['Before', 'After'])
  assert.deepEqual(pages.map((link) => link.label), ['Doc'])
})

test('duplicate links and a field\'s own link are shown once, beside the field', () => {
  const { pages } = reviewLinks(decision(
    [
      { label: 'A', url: 'https://a.example/x' },
      { label: 'A again', url: 'https://a.example/x' },
      { label: 'Field link', url: 'https://b.example/y' },
    ],
    [{ name: 'pick', type: 'choice', url: 'https://b.example/y' }],
  ))
  assert.deepEqual(pages.map((link) => link.url), ['https://a.example/x'])
})

test('no links means nothing to show', () => {
  assert.deepEqual(reviewLinks({ ticket: 'ub_n', fields: [] }), { images: [], pages: [] })
})

test('isImageUrl reads the path, not the query or host', () => {
  assert.ok(isImageUrl('https://h.example/a/b.jpg'))
  assert.ok(isImageUrl('https://h.example/a/b.JPEG#frag'))
  assert.ok(isImageUrl('https://h.example/a.gif?x=1'))
  assert.ok(!isImageUrl('https://png.example/page'))
  assert.ok(!isImageUrl('https://h.example/page?file=a.png'))
  assert.ok(!isImageUrl('not a url'))
})
