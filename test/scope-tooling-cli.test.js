// Owner: Opus (pHY, scoping tooling 2026-10-01). Implementers make it pass and never edit it.
// pZZ (vertical-agents, 2026-10-01 ~16:58 ET): "No `scope new`. Had to hand-write scope.json ...
// `unblock scope` with no args says 'daemon did not come up within 5000ms'; `--help` is 'unknown option'."
// And: "`scope lint` before the first publish prints 'Could not read the current scope'. Harmless, noisy."
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startScopeHarness } from './scope-harness.js'
import { validateScope } from '../src/scope-doc.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'unblock.js')
const at = '2026-10-01T21:00:00Z'
const v2 = {
  version: 2, slug: 'demo', title: 'Demo scope', pane: 'w5H:pT1', revision: 1, updated_at: at,
  doc: { sections: [{ id: 'title', heading: 'Demo scope', body_md: 'A small page.' }, { id: 'plan', heading: 'The plan', body_md: 'We ship the page first.' }] },
  threads: [],
}

function run(args, env) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, [CLI, ...args], { env })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill(), 15000)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, ms: Date.now() - started }) })
  })
}

// No daemon anywhere: a dead port, a fresh state dir, and a daemon root that cannot start.
function offline() {
  const temp = mkdtempSync(join(tmpdir(), 'unblock-tooling-'))
  const scopes = join(temp, 'scopes')
  mkdirSync(scopes)
  return { temp, scopes, env: { ...process.env, UNBLOCK_STATE_DIR: join(temp, 'state'), UNBLOCK_CONFIG_DIR: join(temp, 'config'), UNBLOCK_PORT: '9', UNBLOCK_SCOPING_DIR: scopes, UNBLOCK_SECRET_BACKEND: 'env' } }
}

test('unblock scope with no args, --help, -h and help print usage without touching the daemon', async () => {
  const { env, temp } = offline()
  for (const args of [['scope'], ['scope', '--help'], ['scope', '-h'], ['scope', 'help'], ['scope', 'comments', '--help']]) {
    const r = await run(args, env)
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
    assert.match(r.stdout, /unblock scope new <slug> --pane <pane>/, `${args.join(' ')} names scope new`)
    assert.match(r.stdout, /unblock scope ask <slug> --from <questions\.json>/, `${args.join(' ')} names the batch ask`)
    assert.match(r.stdout, /unblock scope ask <slug> --section/)
    assert.doesNotMatch(r.stderr, /daemon|unknown option/i)
    assert.ok(r.ms < 4000, `usage is instant, took ${r.ms}ms`)
  }
  assert.equal(existsSync(join(temp, 'state', 'daemon.json')), false, 'no daemon was started')
  const oldCommand = await run(['scope', 'threads', '--help'], env)
  assert.equal(oldCommand.status, 2, 'the old subcommand has no alias')
  assert.doesNotMatch(oldCommand.stderr, /daemon|unknown option/i)
  const top = await run(['help'], env)
  assert.match(top.stdout, /unblock scope new <slug> --pane <pane>/)
  assert.match(top.stdout, /unblock scope ask <slug> --from <questions\.json>/)
})

test('scope new writes a valid v2 scope.json, offline, and refuses to overwrite or take bad input', async () => {
  const { env, scopes } = offline()
  const made = await run(['scope', 'new', 'tutor-home', '--pane', 'w5H:pZZ', '--app', 'closer', '--title', 'Tutor home'], env)
  assert.equal(made.status, 0, made.stderr)
  const file = join(scopes, 'tutor-home', 'scope.json')
  const scope = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(validateScope(scope), [])
  assert.equal(scope.version, 2)
  assert.equal(scope.slug, 'tutor-home')
  assert.equal(scope.pane, 'w5H:pZZ')
  assert.equal(scope.app, 'closer')
  assert.equal(scope.title, 'Tutor home')
  assert.equal(scope.revision, 1)
  assert.deepEqual(scope.threads, [])
  assert.equal(scope.doc.sections[0].id, 'title')
  assert.equal(scope.doc.sections[0].heading, 'Tutor home')
  assert.ok(Number.isFinite(Date.parse(scope.updated_at)))
  assert.match(made.stdout, /tutor-home/)

  const before = readFileSync(file, 'utf8')
  const again = await run(['scope', 'new', 'tutor-home', '--pane', 'w5H:pZ1'], env)
  assert.notEqual(again.status, 0, 'an existing scope is never overwritten')
  assert.match(again.stderr, /exists/i)
  assert.equal(readFileSync(file, 'utf8'), before)

  // An existing project folder (RESUME.md, plan.md) is fine; only scope.json is new.
  mkdirSync(join(scopes, 'raise'))
  writeFileSync(join(scopes, 'raise', 'RESUME.md'), 'stage: Scoping\n')
  const plain = await run(['scope', 'new', 'raise', '--pane', 'w5H:pR1'], env)
  assert.equal(plain.status, 0, plain.stderr)
  const raise = JSON.parse(readFileSync(join(scopes, 'raise', 'scope.json'), 'utf8'))
  assert.deepEqual(validateScope(raise), [])
  assert.equal(raise.title, 'raise', 'title defaults to the slug')
  assert.equal(raise.doc.sections[0].heading, 'raise')
  assert.equal(raise.app, undefined, 'no --app leaves the app to the slug rule')
  assert.equal(readFileSync(join(scopes, 'raise', 'RESUME.md'), 'utf8'), 'stage: Scoping\n')

  for (const args of [
    ['scope', 'new', 'Bad Slug', '--pane', 'w5H:pZZ'],
    ['scope', 'new', 'okslug', '--pane', 'not-a-pane'],
    ['scope', 'new', 'okslug'],
    ['scope', 'new', 'okslug', '--pane', 'w5H:pZZ', '--app', 'nope'],
    ['scope', 'new', '--pane', 'w5H:pZZ'],
  ]) {
    const r = await run(args, env)
    assert.equal(r.status, 2, `${args.join(' ')} is a usage error: ${r.stderr}`)
  }
  assert.equal(existsSync(join(scopes, 'okslug', 'scope.json')), false)
})

test('a scope from scope new takes scope doc --from, and lint before the first publish is quiet', async () => {
  const h = await startScopeHarness(v2)
  const work = mkdtempSync(join(tmpdir(), 'unblock-tooling-doc-'))
  const env = { ...process.env, UNBLOCK_PORT: String(h.port) }
  try {
    writeFileSync(join(work, 'doc.md'), '# Fresh scope\n\nA short page.\n\n## The plan {#plan}\n\nWe ship the page first.\n')
    const early = await run(['scope', 'lint', 'fresh', '--from', join(work, 'doc.md')], env)
    assert.equal(early.status, 0, early.stderr)
    assert.doesNotMatch(early.stderr, /Could not read/, 'no noise before the first publish')
    assert.match(early.stdout, /No unslop findings/)

    const made = await run(['scope', 'new', 'fresh', '--pane', 'w5H:pT2', '--title', 'Fresh scope'], env)
    assert.equal(made.status, 0, made.stderr)
    const published = await run(['scope', 'doc', 'fresh', '--from', join(work, 'doc.md')], env)
    assert.equal(published.status, 0, published.stderr)
    const got = await h.request('/api/scope/fresh', { headers: h.bearer })
    assert.equal(got.status, 200, got.text)
    assert.equal(got.json.scope.revision, 2)
    assert.deepEqual(got.json.scope.doc.sections.map((s) => s.id), ['title', 'plan'])
    assert.equal(got.json.scope.pane, 'w5H:pT2')
  } finally { await h.close() }
})
