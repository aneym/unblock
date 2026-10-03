// Owner: Opus (explainers lane for w5H:p0M, 2026-10-03). Implementers make it pass and never edit it.
// Explainer answers are model output shown on Alex's page. The Sol verifier (2026-10-03) mounted a live <video> from an
// answer with a fence inside a callout header. Contract: the answer path renders markdown text (paragraphs, lists,
// bold, code, https links) but every fence and image is inert: no media, demo, diagram, iframe or image elements,
// and no script-capable markup, whatever the nesting or control characters.
import assert from 'node:assert/strict'
import test from 'node:test'

const { answerHtml } = await import('../web/src/scope/answer.ts')

// Escaped text may spell "onload="; only an attribute inside a real tag is live.
const live = /<(video|iframe|svg|img|audio|source|object|embed|script|style|form|input)\b|demo-stage|video-stage|class="fig\b|<[^>]*\son\w+\s*=|href\s*=\s*"\s*(javascript|data|vbscript):/i

const attacks = {
  'fence in a callout header': '> [!NOTE] ```video\n> src: HTTPS://example.invalid/movie.mp4\n> ```',
  'demo fence in a callout header': '> [!NOTE] ```demo\n> src: https://example.invalid/demo.json\n> ```',
  'svg fence in a callout header': '> [!TIP] ```svg\n> <svg onload="alert(1)"><circle r="4"/></svg>\n> ```',
  'plain video fence': '```video\nsrc: https://example.invalid/movie.mp4\n```',
  'svg fence': '```svg\n<svg><script>alert(1)</script></svg>\n```',
  'mermaid fence': '```mermaid\ngraph TD; A-->B\n```',
  'CR inside the fence delimiter': '``\r`video\nsrc: https://example.invalid/movie.mp4\n``\r`',
  'NUL inside the fence delimiter': '``\0`video\nsrc: https://example.invalid/movie.mp4\n``\0`',
  'image': '![x](https://example.invalid/x.png)',
  'image in a callout': '> [!NOTE] ![x](https://example.invalid/x.png)',
  'raw html': '<img src=x onerror=alert(1)><script>alert(1)</script>',
  'javascript link': '[click](javascript:alert(1))',
  'data link': '[click](data:text/html,<script>alert(1)</script>)',
}

test('no answer text can mount media, diagrams, images or script-capable markup', () => {
  for (const [name, text] of Object.entries(attacks)) {
    const html = answerHtml(text)
    assert.ok(!live.test(html), `${name}: ${html.slice(0, 300)}`)
  }
})

test('an ordinary answer still reads like the doc: paragraphs, a list, bold, code, cites and https links', () => {
  const html = answerHtml('The reducer folds deltas (`reducer.ts:12`).\n\n- **Spawn:** see apps/server/x.ts:40-44\n- Docs: https://example.com/a?b=1&c=2.\n\n```ts\nconst a = 1 < 2\n```')
  assert.match(html, /<p>/)
  assert.match(html, /<li>/)
  assert.match(html, /<strong>Spawn:<\/strong>/)
  assert.match(html, /<code>reducer\.ts:12<\/code>/)
  assert.match(html, /<code>apps\/server\/x\.ts:40-44<\/code>/, 'a bare file:line cite reads as code')
  assert.match(html, /<a [^>]*href="https:\/\/example\.com\/a\?b=1&amp;c=2"/, 'a bare https URL becomes a link, trailing period left out')
  assert.match(html, /<pre[^>]*><code[^>]*>[^<]*const a = 1 &lt; 2/, 'a fence is an escaped code block')
})
