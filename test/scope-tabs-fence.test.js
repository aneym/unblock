import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { markdown } from '../web/src/scope/markdown.ts'
import { human, startScopeHarness } from './scope-harness.js'

const fence = entries => '```tabs\n' + entries.join('\n---\n') + '\n```'
const initial = {
  version: 2, slug: 'tabs', title: 'Tabs scope', pane: 'w5H:pT1', revision: 1, updated_at: '2026-10-03T00:00:00Z',
  doc: { sections: [{ id: 'title', heading: 'Tabs scope', body_md: 'A small page.' }, { id: 'try', heading: 'Try it', body_md: 'Words for now.' }] }, threads: [],
}

test('tabs register uploaded demo assets, render flat entries, and reject every source a demo rejects', async () => {
  const h = await startScopeHarness(initial)
  const put = body_md => h.request('/api/scope/tabs/doc', { method: 'PUT', headers: h.bearer, body: { sections: [initial.doc.sections[0], { id: 'try', heading: 'Try it', body_md }] } })
  try {
    const uploaded = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/scope/tabs/assets', method: 'POST', headers: { ...h.bearer, 'Content-Type': 'text/html' } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }))
      })
      req.on('error', reject); req.end('<!doctype html><button>Try it</button>')
    })
    assert.equal(uploaded.status, 201)
    const src = `asset:${uploaded.json.id}`
    const body = fence([
      'src: https://example.com/a\nheight: 320\ncaption: First: details',
      `src: ${src}\nheight: 640\ncaption: Second — details`,
      'src: https://example.com/c\nheight: 900\ncaption: Third',
    ])
    assert.equal((await put(body)).status, 200)
    const scope = (await h.request('/api/scope/tabs', { headers: human })).json.scope
    assert.equal(scope.doc.assets[uploaded.json.id].type, 'html')
    const html = markdown(scope.doc.sections.find(s => s.id === 'try').body_md, scope.doc.assets, '/assets')
    assert.equal((html.match(/role="tab" /g) || []).length, 3)
    assert.equal((html.match(/role="tabpanel"/g) || []).length, 3)
    assert.ok(html.includes(`class="demo-stage" data-cm-skip data-tab-src="/assets/${uploaded.json.id}"`))
    for (const height of [320, 640, 900]) assert.ok(html.includes(`data-height="${height}"`))
    for (const caption of ['First: details', 'Second — details', 'Third']) assert.ok(html.includes(`<figcaption>${caption}</figcaption>`))
    assert.match(html, />First<\/button>/); assert.match(html, />Second<\/button>/)
    assert.equal((html.match(/ hidden/g) || []).length, 2)
    assert.ok(!html.includes('<iframe'), 'frames mount at runtime only for visible panels')

    for (const bad of ['javascript:alert(1)', 'http://example.com', '/relative', 'asset:missing']) {
      const demo = await put('```demo\nsrc: ' + bad + '\n```')
      const tabs = await put(fence([`src: ${bad}\ncaption: Unavailable`]))
      assert.equal(demo.status, 400, bad); assert.equal(tabs.status, 400, bad)
      assert.equal(tabs.json.error, demo.json.error, 'tabs and demos share server validation')
    }
    assert.equal((await put(fence([`src: ${src}\nheight: 480\ncaption: Only demo`, '']))).status, 200)
    const singleScope = (await h.request('/api/scope/tabs', { headers: human })).json.scope
    const single = markdown(singleScope.doc.sections.find(s => s.id === 'try').body_md, singleScope.doc.assets, '/assets')
    assert.equal((single.match(/role="tab" /g) || []).length, 1)
    assert.match(single, /aria-selected="true" tabindex="0"/)
    assert.match(single, /data-height="480"/)
    assert.ok(!single.includes(' hidden'))
  } finally { await h.close() }
})
