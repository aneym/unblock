#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs'
import { cut, eligible, log, redact } from './lib.js'
import { ALLOW, bypassAllows, uncheckedNestedRm } from './bypass-allow.js'

const RM_IN_SHELL = /\b(?:shell|sh|bash)\s+-c\s+script\s+runs\s+rm\s+and\s+could\s+not\s+be\s+checked\b/i
const RULE_12 = 'Rule 12: delete by absolute path in its own command (rm -rf "${T:?}" with T absolute, or python shutil.rmtree); write probes to a script file and run bash <file>; never put rm inside a multi-line sh -c.'
const PANE_RULE = 'Denied: an agent pane never waits on a permission prompt, and prompts are never sent to Alex. Rework the step (absolute paths, git -C instead of cd, one command per call, deletes by absolute path in their own command); do not retry the same command. Only a kept-floor step (a secret, a message to a real person, spend past a cap, destructive data with no approval record, Alex\'s own credentials) goes to Alex, as an unblock ask you file yourself with its own purpose.'

const deny = (message) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } })
const pane = eligible(undefined, { subagent: true })

function attempted(input) {
  const data = input.tool_input || {}
  return cut(redact(String(data.command ?? data.file_path ?? data.notebook_path ?? data.url ?? '')), 80)
}

function decide(input) {
  const reasons = [input.reason, input.permissionDecisionReason, input.classifier?.reason]
  if (input.tool_name === 'Bash' && (reasons.some((reason) => typeof reason === 'string' && RM_IN_SHELL.test(reason)) || uncheckedNestedRm(input))) {
    return deny(RULE_12)
  }
  if (bypassAllows(input)) {
    log(`bypass allow ${process.env.HERDR_PANE_ID || '-'} ${input.agent_id ? 'subagent ' : ''}${attempted(input)}`)
    return ALLOW
  }
  if (pane) {
    log(`pane deny ${process.env.HERDR_PANE_ID} ${input.agent_id ? 'subagent ' : ''}${input.tool_name || '-'} ${attempted(input)}`)
    return deny(PANE_RULE)
  }
  return null
}

let decision = null
try {
  decision = decide(JSON.parse(readFileSync(0, 'utf8')))
} catch {
  decision = pane ? deny(PANE_RULE) : null
  log(pane ? 'permission hook failed; denied in the pane' : 'permission hook failed; the prompt stays with the person at the terminal')
}
if (decision) writeSync(1, decision + '\n')
