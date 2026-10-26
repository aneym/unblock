import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { human, startScopeHarness } from './scope-harness.js'
import { scopeToPlanMdx } from '../src/scope-plan.js'

const at = '2026-10-16T15:00:00Z'
const scope = {
  version: 2, slug: 'demo', title: 'Scope demo', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [
    { id: 'title', heading: 'Scope demo', body_md: 'One box per person keeps files shared.' },
    { id: 'plan', heading: 'The plan', body_md: 'We keep one box per person.\n\n| Step | When |\n|---|---|\n| R1 | Now |\n\n```svg\n<svg viewBox="0 0 10 10" aria-label="A box"><rect class="box" x="0" y="0" width="10" height="10"/></svg>\n```' },
  ] },
  threads: [{ id: 'T1', kind: 'question', author: 'agent', status: 'open', anchor: { section: 'plan', quote: 'We keep one box per person.' }, created_at: at, recommendation: 'One box per person', messages: [{ from: 'agent', text: 'What is the isolation unit?', at }] }],
}

test('a scope becomes Plan MDX: front matter, Table and Diagram blocks, prose kept verbatim', () => {
  const { mdx } = scopeToPlanMdx(scope)
  assert.match(mdx, /^---\ntitle: "Scope demo"\nbrief: "One box per person keeps files shared."\n---\n/)
  assert.match(mdx, /<Table id="t\d+" columns=\{\["Step","When"\]\} rows=\{\[\["R1","Now"\]\]\} \/>/)
  assert.match(mdx, /<Diagram id="d\d+" caption="A box" frame="hide" renderMode="design">/)
  assert.match(mdx, /We keep one box per person\./)
  assert.doesNotMatch(mdx, /\| R1 \|/)
  const framed = scopeToPlanMdx({ ...scope, doc: { sections: [{ id: 'title', heading: 'Framed', body_md: 'Intro.\n\n![Today opens on goals](asset:bdefdb062b3543df.mock)' }] } })
  assert.deepEqual(framed.assets, ['bdefdb062b3543df.mock'], 'an HTML mock frame is published as its still')
  assert.match(framed.mdx, /<MockStill id="m\d+" src="asset:bdefdb062b3543df\.mock" alt="Today opens on goals"/)
  const media = scopeToPlanMdx({ ...scope, doc: { sections: [
    { id: 'title', heading: 'Media', body_md: 'Intro.' },
    { id: 'flow', heading: 'The flow {#flow}', body_md: 'The <agent> sends `{json}` to {slug}.\n\n```demo\nsrc: asset:c27ab2a02aacfd52.html\nheight: 720\n```\nFigure: The whole flow.\n\n```video\nsrc: asset:6c54565ba4422e24.mp4\nposter: asset:f002ee65fe8e1ad5.png\n```\nFigure: The same flow as a film.\n\n```mermaid\ngraph LR; a-->{b}\n```' },
  ] } })
  assert.deepEqual(media.assets.sort(), ['6c54565ba4422e24.mp4', 'c27ab2a02aacfd52.html', 'f002ee65fe8e1ad5.png'], 'a recording publishes with its poster and a demo with its page')
  assert.match(media.mdx, /<PrototypeEmbed id="p\d+" src="asset:c27ab2a02aacfd52\.html" caption="The whole flow\." \/>/)
  assert.match(media.mdx, /<Film id="f\d+" src="asset:6c54565ba4422e24\.mp4" poster="asset:f002ee65fe8e1ad5\.png" caption="The same flow as a film\." \/>/)
  assert.doesNotMatch(media.mdx, /```(demo|video)|^Figure:/m)
  assert.match(media.mdx, /^## The flow$/m, 'a heading id does not reach MDX')
  assert.match(media.mdx, /The \\<agent> sends `\{json\}` to \\\{slug\\\}\./, 'prose angle brackets and braces are escaped, code spans are not')
  assert.match(media.mdx, /graph LR; a-->\{b\}/, 'fenced code is left alone')
  const framed2 = scopeToPlanMdx({ ...scope, doc: { sections: [{ id: 'title', heading: 'Html', body_md: 'Write asset:NAME for a file.\n\n```html\nsrc: asset:c27ab2a02aacfd52.html\nframe: asset:aaaaaaaaaaaaaaaa.png\n```\n\n```\nasset:bbbbbbbbbbbbbbbb.png\n```' }] } })
  assert.deepEqual(framed2.assets.sort(), ['aaaaaaaaaaaaaaaa.png', 'c27ab2a02aacfd52.html'], 'every asset key in an html fence is fetched')
  assert.match(framed2.mdx, /<PrototypeEmbed id="p\d+" src="asset:c27ab2a02aacfd52\.html" \/>/)
  assert.equal([...framed2.mdx.matchAll(/asset:(?=[^\s"'])/g)].length, 1, 'only fetched assets reach plan-publish as asset: names')
})

test('parallel scope plan runs never lose the plans file to a shared tmp name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unblock-plans-race-'))
  const runs = Array.from({ length: 8 }, (_, n) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { recordPlan } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'scope-plan.js'))}; for (let i = 0; i < 40; i++) recordPlan('s${n}', { url: 'https://h:8950/plans/p${n}', i }, ${JSON.stringify(join(dir, 'scope-plans.json'))})`])
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (status) => resolve({ status, stderr }))
  }))
  for (const run of await Promise.all(runs)) assert.equal(run.status, 0, run.stderr)
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, 'scope-plans.json'), 'utf8')))
})

test('scope plan publishes to :8950/plans/, scope url prints that link, and later writes rewrite the same plan', async () => {
  const h = await startScopeHarness(scope)
  const temp = mkdtempSync(join(tmpdir(), 'unblock-plan-test-'))
  const calls = join(temp, 'calls.log')
  const fake = join(temp, 'plan-publish')
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nfor a in "$@"; do case "$a" in *questions.json) cat "$a" >> '${calls}'; echo >> '${calls}';; esac; done\nprintf '{"ok": true, "plan": "plan-abc", "url": "%s"}\\n' "\${FAKE_URL:-https://studio.example.ts.net:8950/plans/plan-abc}"\n`)
  chmodSync(fake, 0o700)
  const cli = (args, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { env: { ...process.env, UNBLOCK_PORT: String(h.port), UNBLOCK_PLAN_PUBLISH: fake, ...env } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  const PLAN = 'https://studio.example.ts.net:8950/plans/plan-abc'
  try {
    let got = await cli(['scope', 'plan', 'demo'], { FAKE_URL: 'https://studio.example.ts.net:8797/s/demo' })
    assert.equal(got.status, 1, 'a publisher that prints a non-8950 link is refused')
    assert.match(got.stderr, /not a :8950\/plans\/ link/)

    got = await cli(['scope', 'plan', 'demo'])
    assert.equal(got.status, 0, got.stderr)
    assert.equal(got.stdout.trim(), PLAN)
    let log = readFileSync(calls, 'utf8')
    assert.match(log, /--owner w5H:pT1/)
    assert.match(log, /"quote":"We keep one box per person\."/)
    assert.match(log, /"rec":"One box per person"/)

    got = await cli(['scope', 'url', 'demo'])
    assert.equal(got.stdout.trim(), PLAN, 'scope url prints the Plan link once one exists')
    got = await cli(['scope', 'list', '--json'])
    assert.equal(JSON.parse(got.stdout).scopes.find((r) => r.slug === 'demo').url, PLAN)

    writeFileSync(join(temp, 'plan.md'), 'We keep one box per person, shared by its agents.')
    got = await cli(['scope', 'patch', 'demo', 'plan', '--from', join(temp, 'plan.md')], { UNBLOCK_PLAN_SYNC: 'on' })
    assert.equal(got.status, 0, got.stderr)
    assert.match(got.stderr, /plan https:\/\/studio\.example\.ts\.net:8950\/plans\/plan-abc/)
    log = readFileSync(calls, 'utf8').trim().split('\n')
    assert.match(log.at(-1), /--into plan-abc/, 'a later write rewrites the same plan in place')
    assert.doesNotMatch(log.at(-1), /--questions/, 'an already pinned question is not asked twice')

    const plans = join(process.env.UNBLOCK_STATE_DIR, 'scope-plans.json')
    assert.equal(JSON.parse(readFileSync(plans, 'utf8')).demo.generated, true, 'a plan unblock created is marked')
    const posts = join(temp, 'posts.log')
    const lanePost = join(temp, 'lane-post')
    writeFileSync(lanePost, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${posts}'\n`)
    chmodSync(lanePost, 0o700)
    writeFileSync(plans, JSON.stringify({ demo: { plan: 'plan-hand', url: 'https://studio.example.ts.net:8950/plans/plan-hand', revision: 1, asked: [] } }))
    const before = readFileSync(calls, 'utf8')
    writeFileSync(join(temp, 'plan.md'), 'We keep one box per person, shared by every agent.')
    got = await cli(['scope', 'patch', 'demo', 'plan', '--from', join(temp, 'plan.md')], { UNBLOCK_PLAN_SYNC: 'on', UNBLOCK_LANE_POST: lanePost })
    assert.equal(got.status, 0, got.stderr)
    assert.equal(readFileSync(calls, 'utf8'), before, 'a hand-built plan is never rewritten')
    assert.match(readFileSync(posts, 'utf8'), /post --to w5H:pT1 .*--kind info Scope demo changed .*plan-hand was built by hand/)
    assert.match(got.stderr, /is hand-built; told w5H:pT1/)

    const nav = await fetch(`http://127.0.0.1:${h.port}/s/demo`, { redirect: 'manual', headers: { ...human, 'Sec-Fetch-Dest': 'document' } })
    assert.equal(nav.status, 302)
    assert.equal(nav.headers.get('location'), 'https://studio.example.ts.net:8950/plans/plan-hand', 'an old /s/ link opens the Plan doc')
  } finally {
    await h.close()
  }
})

test('a Rails Plan URL is persisted so a later publish updates the same document', async () => {
  const h = await startScopeHarness(scope)
  const temp = mkdtempSync(join(tmpdir(), 'unblock-plan-rails-url-'))
  const calls = join(temp, 'calls.log')
  const fake = join(temp, 'plan-publish')
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf '{"ok": true, "plan": "plan-rails", "url": "https://app.rails.so/d/plan-rails"}\\n'\n`)
  chmodSync(fake, 0o700)
  const cli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { env: { ...process.env, UNBLOCK_PORT: String(h.port), UNBLOCK_PLAN_PUBLISH: fake, UNBLOCK_PLAN_LINK: 'off' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  try {
    let got = await cli(['scope', 'plan', 'demo'])
    assert.equal(got.status, 0, got.stderr)
    assert.equal(got.stdout.trim(), 'https://app.rails.so/d/plan-rails')
    got = await cli(['scope', 'plan', 'demo'])
    assert.equal(got.status, 0, got.stderr)
    assert.match(readFileSync(calls, 'utf8').trim().split('\\n').at(-1), /--into plan-rails/, 'the second publish updates the stored Plan doc')
  } finally {
    await h.close()
  }
})

test('publishing a Plan doc sets its plan_url in Rails, and a Rails failure never blocks the publish', async () => {
  const h = await startScopeHarness(scope)
  const temp = mkdtempSync(join(tmpdir(), 'unblock-plan-link-'))
  const fake = join(temp, 'plan-publish')
  writeFileSync(fake, `#!/bin/sh\nprintf '{"ok": true, "plan": "plan-abc", "url": "https://studio.example.ts.net:8950/plans/plan-abc"}\\n'\n`)
  chmodSync(fake, 0o700)
  const seen = []
  let imported = true, down = false
  const rails = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null })
      if (down) { res.writeHead(503); res.end(); return }
      if (req.method === 'GET') {
        res.writeHead(imported ? 200 : 404, { 'content-type': 'application/json' })
        res.end(JSON.stringify(imported ? { slug: 'demo', lane: 'probe-lane' } : { error: 'no_scope' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((resolve) => rails.listen(0, '127.0.0.1', resolve))
  const cli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'bin', 'unblock.js'), ...args], { env: { ...process.env, UNBLOCK_PORT: String(h.port), UNBLOCK_PLAN_PUBLISH: fake, UNBLOCK_PLAN_LINK: 'on', UNBLOCK_RAILS_ADMIN_ORIGIN: `http://127.0.0.1:${rails.address().port}`, RAILS_ADMIN_FEED_KEY: 'feed-key-for-test' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', (c) => { stdout += c }); child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject); child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  try {
    let got = await cli(['scope', 'plan', 'demo', '--json'])
    assert.equal(got.status, 0, got.stderr)
    const post = seen.find((r) => r.method === 'POST')
    assert.equal(post.url, '/api/rails-admin/v1/plan/scopes/demo/set-plan-url')
    assert.equal(post.auth, 'Bearer feed-key-for-test')
    assert.equal(post.body.lane, 'probe-lane', 'the lane is the one Rails has for the scope')
    assert.equal(post.body.plan_url, 'https://studio.example.ts.net:8950/plans/plan-abc')
    assert.match(post.body.client_id, /^unblock-plan-[0-9a-f]{32}$/)

    seen.length = 0
    imported = false
    got = await cli(['scope', 'plan', 'demo', '--json'])
    assert.equal(got.status, 0, got.stderr)
    assert.deepEqual(seen.filter((r) => r.method === 'POST').map((r) => [r.url, r.body]), [['/api/rails-admin/v1/plan/scopes/demo/plan-link', { plan_url: 'https://studio.example.ts.net:8950/plans/plan-abc' }]],
      'a scope Rails has not imported gets a plan-link record the import picks up')

    down = true
    got = await cli(['scope', 'plan', 'demo'])
    assert.equal(got.status, 0, 'a Rails failure never blocks the publish')
    assert.equal(got.stdout.trim(), 'https://studio.example.ts.net:8950/plans/plan-abc')
    assert.deepEqual(got.stderr.trim().split('\n').filter((l) => /Rails/.test(l)), ['Rails plan_url not set for demo: Rails read HTTP 503'])
  } finally {
    rails.close()
    await h.close()
  }
})
