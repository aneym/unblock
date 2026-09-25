import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAsk, normalizeOrigin } from '../src/schema.js'

const gate = { only_you: 'message', tried: ['Checked the CLI and API; neither can send a message as the human.'] }

const hasControl = (s) =>
  [...s].some((c) => {
    const n = c.codePointAt(0)
    return n < 0x20 || (n >= 0x7f && n <= 0x9f)
  })

// An LLM can be steered by whatever it just read — a README, an issue, a web
// page — so its output is hostile input. ESC would rewrite the terminal the
// queue renders into; a newline would escape the markdown heading it sits in.
const EVIL = 'Rotate[2J]0;PWNED the\nkey'

test('strips control characters from every agent-supplied string', () => {
  const ask = validateAsk({
    kind: 'park',
    ...gate,
    title: EVIL,
    why: EVIL,
    steps: [EVIL],
    links: [{ url: 'https://example.com', label: EVIL }],
    fields: [
      { name: 'k', type: 'secret', label: EVIL, help: EVIL },
      { name: 'c', type: 'choice', label: EVIL, choices: [EVIL, 'b'] },
      { name: 'p', type: 'paste', label: 'out', command: EVIL },
    ],
  })

  for (const [where, value] of [
    ['title', ask.title],
    ['why', ask.why],
    ['steps[0]', ask.steps[0]],
    ['links[0].label', ask.links[0].label],
    ['fields[0].label', ask.fields[0].label],
    ['fields[0].help', ask.fields[0].help],
    ['fields[1].choices[0].label', ask.fields[1].choices[0].label],
    ['fields[2].command', ask.fields[2].command],
  ]) {
    assert.equal(hasControl(value), false, `${where} still holds a control character`)
  }
})

test('accepts supported action links in asks and fields', () => {
  for (const url of ['https://example.com', 'codex://thread/123', 'x-apple.systempreferences:com.apple.preference.security']) {
    const ask = validateAsk({ ...gate, title: 't', why: 'w', links: [{ url }], fields: [{ name: 'a', type: 'text', url }] })
    assert.equal(ask.links[0].url, url)
    assert.equal(ask.fields[0].url, url)
  }
})

test('rejects unsafe action URLs so a javascript: href can never be stored', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
    assert.throws(
      () =>
        validateAsk({
          ...gate,
          title: 't',
          why: 'w',
          links: [{ url }],
          fields: [{ name: 'a', type: 'text' }],
        }),
      /http\(s\), codex, or system preferences URL/,
      url,
    )
  }
})

test('scrubs control characters from origin strings too', () => {
  const origin = normalizeOrigin({
    agent: 'cl[31maude',
    workspace_name: 'her\ndr',
    profiles: ['work'],
  })
  assert.equal(hasControl(origin.agent), false)
  assert.equal(hasControl(origin.workspace_name), false)
  assert.equal(hasControl(origin.profiles[0]), false)
})

test('an ask with no fields is rejected — the discipline is enforced, not trusted', () => {
  assert.throws(() => validateAsk({ ...gate, title: 't', why: 'w', fields: [] }), /at least one field/)
})

test('a field name cannot smuggle anything — snake_case only', () => {
  for (const name of ['Bad Name', '../etc', 'a-b', '9lives', 'xy']) {
    assert.throws(
      () => validateAsk({ ...gate, title: 't', why: 'w', fields: [{ name, type: 'text' }] }),
      /snake_case|must not be empty/,
      name,
    )
  }
})

// One boundary owns the filing gate: schema rejects invalid filings before storage.
test('only-human filing gate accepts real blockers and decisions and rejects incomplete requests', () => {
  const base = { ...gate, title: 'Choose the next step', why: 'The answer unlocks work.', fields: [{ name: 'done', type: 'confirm' }] }
  const decision = { ...base, purpose: 'decision', only_you: 'judgment', fields: [{ name: 'plan', type: 'text', recommend: { value: 'Run a trial', why: 'Low cost' } }] }
  for (const valid of [base, decision]) assert.doesNotThrow(() => validateAsk(valid))
  for (const [changes, path] of [
    [{ tried: undefined }, 'tried'],
    [{ tried: ['short'] }, 'tried[0]'],
    [{ only_you: undefined }, 'only_you'],
    [{ ...decision, only_you: 'credential' }, 'only_you'],
    [{ only_you: 'judgment' }, 'only_you'],
    [{ only_you: 'their_account', links: [{ url: 'https://railway.com/dashboard' }] }, 'links'],
    [{ title: 'Choose a v1 plan' }, 'title'],
  ]) {
    assert.throws(() => validateAsk({ ...base, ...changes }), (error) => error.path === path, path)
  }
  // A caller on an MCP server started before the gate sends neither key; the
  // one error must name both and the way through, or it cannot recover.
  assert.throws(() => validateAsk({ ...base, tried: undefined, only_you: undefined }), /missing tried and only_you.*extra arguments.*unblock file -/)
})
