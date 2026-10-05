import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { embedBridgeScript } from '../src/demo-host.js'
import { locateEmbed } from '../src/scope-anchor.js'
import { human, startScopeHarness } from './scope-harness.js'

// The HTTP boundary owns fence membership and persistence. The shared quote
// matcher owns client-only detachment; absent text must not acquire a new target.
test('embedded selections persist only under their containing demo fence', async () => {
  const src = 'https://example.com/prototype.html'
  const initial = {
    version: 2, slug: 'embed', title: 'Embed scope', pane: 'w5H:pT1', revision: 1,
    updated_at: '2026-10-03T18:00:00Z', threads: [],
    doc: { sections: [
      { id: 'title', heading: 'Embed scope', body_md: 'Review this page.' },
      { id: 'plan', heading: 'Plan', body_md: `\`\`\`demo\nsrc: ${src}\n\`\`\`\nFigure: Prototype` },
    ] },
  }
  const h = await startScopeHarness(initial)
  try {
    const embed = { src, quote: 'Invite teammates', prefix: 'Workspace', suffix: 'Continue' }
    const anchor = { section: 'plan', quote: embed.quote, prefix: '', suffix: '', embed }
    const create = anchor => h.request('/api/scope/embed/threads', { method: 'POST', headers: human, body: { anchor, text: 'Make this clearer.' } })
    const accepted = await create(anchor)
    assert.equal(accepted.status, 201)
    assert.deepEqual(accepted.json.thread.anchor.embed, embed)
    // A fence the section no longer holds (the lane republished while Alex typed) keeps his words on the section, without the embed.
    for (const elsewhere of [{ ...anchor, section: 'title' }, { ...anchor, embed: { ...embed, src: 'https://example.com/not-a-fence.html' } }]) {
      const landed = await create(elsewhere)
      assert.equal(landed.status, 201)
      assert.deepEqual(landed.json.thread.anchor, { section: elsewhere.section, quote: embed.quote, prefix: '', suffix: '' })
    }
    assert.equal((await create({ ...anchor, embed: { ...embed, quote: '' } })).status, 400)
    const listed = await h.request('/api/scope/embed', { headers: human })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.json.scope.threads.find(t => t.id === accepted.json.thread.id).anchor.embed, embed)
  } finally { await h.close() }
})

test('an embed quote missing after republish detaches rather than targeting nearby text', () => {
  const anchor = { quote: 'Invite teammates', prefix: 'Workspace', suffix: 'Continue' }
  assert.ok(locateEmbed('Workspace\nInvite teammates\nContinue', anchor))
  assert.equal(locateEmbed('Workspace\nManage teammates\nContinue', anchor), null)
})

// Sandboxed assets use an opaque child origin: commands still require the
// actual parent window and its URL origin, plus the capability after init.
test('the served bridge accepts only its parent origin and echoes its capability', () => {
  const replies = [], listeners = {}
  const parent = { postMessage: (data, origin) => replies.push({ data, origin }) }
  const text = { nodeType: 3, data: '', get length() { return this.data.length } }
  const document = { body: { nodeType: 1, tagName: 'BODY', matches: () => false, childNodes: [text] }, addEventListener() {}, createRange: () => ({ setStart() {}, setEnd() {} }) }
  const context = { parent, location: { origin: 'https://scope.example' }, document, window: { addEventListener: (name, fn) => { listeners[name] = fn } }, setTimeout, clearTimeout }
  vm.runInNewContext(embedBridgeScript().replace(/^<script>|<\/script>$/g, ''), context)
  const send = (data, origin = 'https://scope.example', source = parent) => listeners.message({ source, origin, data: { type: 'rails-embed', ...data } })
  send({ action: 'init', token: 'capability' }, 'https://other.example')
  send({ action: 'init', token: 'capability' }, 'https://scope.example', {})
  assert.equal(replies.length, 0)
  send({ action: 'init', token: 'capability' })
  assert.equal(replies[0].origin, 'https://scope.example')
  assert.equal(replies[0].data.token, 'capability')
  send({ action: 'match', token: 'wrong', anchors: [] })
  assert.equal(replies.length, 1)
  send({ action: 'match', token: 'capability', anchors: [{ id: 'T1', anchor: { quote: 'removed text' } }] })
  assert.equal(replies[1].data.matches[0].found, false)
  const anchor = { quote: 'Invite teammates', prefix: 'Workspace', suffix: 'Continue' }
  for (const [content, found] of [
    ['Workspace\nInvite teammates\nContinue', true],
    ['Workspace\nManage teammates\nContinue\nnever invite teammates blindly', false],
    ['Workspace\nManage teammates\nContinue\nnever Invite teammates blindly', false],
  ]) {
    text.data = content
    send({ action: 'match', token: 'capability', anchors: [{ id: 'T1', anchor }] })
    assert.equal(replies.at(-1).data.matches[0].found, found, content)
  }
})
