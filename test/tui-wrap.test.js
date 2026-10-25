// A card in the TUI is read, not clipped. Alex (2026-10-24): a long agent
// message ran off the right edge with no way to read it, so the end of the
// question was unreachable. There is no horizontal scroll in an alt-screen
// terminal, so the fix is wrapping, plus a window the arrows can move.
//
// Proves it through the running pane: boot a daemon, file one long ask, drive
// the real TUI in a pty at 40 columns, expand the card, and read the frame.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('..', import.meta.url).pathname

const LONG_ASK = {
  kind: 'park', purpose: 'question', only_you: 'judgment', project: 'wrap-test',
  title: 'Pick the staging banner wording',
  why: 'The banner runs across the top of every staging page, and the current copy was written for the '
    + 'internal team. Customers now see staging during onboarding, so the wording has to warn without '
    + 'alarming, name the environment plainly, and avoid the word production anywhere in the sentence.',
  steps: [
    'Read the three drafts in the doc and the review thread where the conflict came up, then say which one you want.',
    'If none fit, write the line you want in the field below and the agent will use it verbatim.',
  ],
  links: [{ label: 'Banner copy drafts', url: 'https://example.invalid/docs/staging-banner-copy-drafts-and-notes' }],
  fields: [{
    name: 'pick', type: 'choice', label: 'Which draft goes live', required: true,
    choices: [{ value: 'a', label: 'Draft A' }, { value: 'b', label: 'Draft B' }],
  }],
}

// Each fixture needs its own state dir: the module-level env above already
// points at one daemon, and a second boot on it would dedupe the same ask.
async function startFixture() {
  const state = mkdtempSync(join(tmpdir(), 'tui-wrap-'))
  const env = {
    ...process.env,
    UNBLOCK_STATE_DIR: state,
    UNBLOCK_CONFIG_DIR: join(state, 'config'),
    UNBLOCK_SECRET_BACKEND: 'env',
  }
  Object.assign(process.env, {
    UNBLOCK_STATE_DIR: state, UNBLOCK_CONFIG_DIR: join(state, 'config'), UNBLOCK_SECRET_BACKEND: 'env',
  })
  const { startDaemon, loadOrCreateSecret } = await import('../src/daemon.js')
  const auth = loadOrCreateSecret()
  const daemon = await startDaemon({ port: 0 })
  const response = await fetch(`http://127.0.0.1:${daemon.port}/api/asks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({
      ask: { tried: ['Checked the CLI and the API; neither can make this call.'], ...LONG_ASK },
      origin: { agent: 'codex', workspace_name: 'wrap-test', pane_id: '1' },
    }),
  })
  assert.ok(response.ok, await response.text())
  writeFileSync(join(state, 'wrap.json'), JSON.stringify(env))
  return {
    env: { ...env, UNBLOCK_PORT: String(daemon.port), UNBLOCK_AUTH: auth },
    close: () => daemon.close?.(),
  }
}

/**
 * script(1) differs between util-linux and BSD/macOS: util-linux takes
 * `-qec <command> <file>`, BSD takes `<file> <command...>`. Pick the form this
 * machine's script supports so the check runs on Linux and macOS alike. The
 * BSD branch cannot be exercised on a util-linux box, so it stays deliberately
 * small: only the argv shape differs, and the pty itself is script(1)'s job on
 * both platforms.
 */
const SCRIPT_IS_UTIL_LINUX = (() => {
  try {
    return /util-linux/.test(execFileSync('script', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch { return false }
})()

/** Drive the real pane in a real tty, then hand back the final frame. */
async function frame(fixture, { cols = 40, rows = 44, keys = ['\r'] } = {}) {
  const command = `stty cols ${cols} rows ${rows} 2>/dev/null; exec node plugin/tui.js`
  const argv = SCRIPT_IS_UTIL_LINUX
    ? ['-qec', command, '/dev/null']
    : ['-q', '/dev/null', 'sh', '-c', command]
  const child = spawn('script', argv, {
    cwd: ROOT,
    env: { ...fixture.env, NO_COLOR: '1', COLUMNS: String(cols) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  await wait(1800)
  for (const key of keys) { child.stdin.write(key); await wait(700) }
  child.kill('SIGTERM')
  await wait(150)
  return out.split('\x1b[H\x1b[2J').filter((part) => part.trim()).pop() || out
}

const plain = (frameText) => frameText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '')

test('a long ask wraps to the terminal width instead of clipping', async () => {
  const fixture = await startFixture()
  try {
    const frameText = plain(await frame(fixture))
    const rows = frameText.split('\n').filter((line) => line.trim())
    assert.ok(rows.length > 15, `frame should contain the open card:\n${frameText}`)

    // Everything the agent wrote is readable somewhere on screen, in full.
    const flat = rows.map((line) => line.trim()).join(' ')
    for (const needle of [
      'the internal team',
      'avoid the word production',
      'which one you want.',
      'verbatim.',
      'staging-banner-copy-drafts-and-',
    ]) {
      assert.ok(flat.includes(needle), `"${needle}" is missing from the frame:\n${frameText}`)
    }

    // No row runs past the terminal. The header row is meta, not prose.
    const body = rows.filter((line) => !line.startsWith('UNBLOCK'))
    const widest = Math.max(...body.map((line) => [...line.trimEnd()].length))
    assert.ok(widest <= 40, `a row is ${widest} columns in a 40-column terminal:\n${frameText}`)
  } finally {
    await fixture.close()
  }
})

test('a full message is readable even when the card is taller than the window', async () => {
  const fixture = await startFixture()
  try {
    // 16 rows cannot hold this card, so the tail only appears after scrolling.
    const top = plain(await frame(fixture, { rows: 16 }))
    assert.ok(!top.includes('Draft A'), `the fields should be below the window at first:\n${top}`)
    // End jumps to the bottom of the card in one keystroke: the assertion is
    // about the window reaching the fields, not about how many rows it takes.
    const scrolled = plain(await frame(fixture, { rows: 16, keys: ['\r', '\x1b[F'] }))
    assert.ok(scrolled.includes('Draft A'), `arrow keys should scroll the fields into view:\n${scrolled}`)
    // Every frame stays inside the terminal.
    for (const text of [top, scrolled]) {
      const widest = Math.max(...text.split('\n').filter((line) => line.trim() && !line.startsWith('UNBLOCK')).map((line) => [...line.trimEnd()].length))
      assert.ok(widest <= 40, `a row is ${widest} columns:\n${text}`)
    }
  } finally {
    await fixture.close()
  }
})
