#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { entries, eligible, fileFirst, log, origin, plainify, project, readEntry, redact, register, remove, request, watcher, cut } from './lib.js'

const timer = setTimeout(() => process.exit(0), 3800)
try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (eligible(input)) {
    const source = await origin()
    const pane = source.pane_id
    const tool = input.tool_name || ''
    const data = input.tool_input || {}
    const label = tool === 'Bash' ? 'a command' : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) ? 'a file edit'
      : tool === 'Read' ? 'reading a file' : tool === 'WebFetch' ? 'a web fetch' : tool.replace(/^mcp__/, '').replace(/__/g, ' ')
    const raw = tool === 'Bash' ? data.command : ['Edit', 'Write', 'MultiEdit', 'Read', 'NotebookEdit'].includes(tool)
      ? data.file_path || data.notebook_path : tool === 'WebFetch' ? data.url : `${tool} ${JSON.stringify(data).slice(0, 300)}`
    const summary = cut(redact(String(raw ?? '')), 600)
    const fingerprint = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
    const workspace = source.workspace_name || project(input.cwd)
    const common = {
      kind: 'file', project: project(input.cwd), ttl_seconds: 3600,
      title: cut(plainify(`Allow ${label} in ${workspace} (pane ${pane.split(':').at(-1)})?`), 90),
    }
    const fileTool = ['Edit', 'Write', 'MultiEdit', 'Read', 'NotebookEdit'].includes(tool)
    const command = tool === 'Bash' ? data.command : tool === 'WebFetch' ? data.url : fileTool ? undefined : JSON.stringify(data)
    const toolSummary = tool === 'Bash' ? 'Run a shell command' : tool === 'Read' ? 'Read a file'
      : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) ? 'Edit a file'
        : tool === 'WebFetch' ? 'Fetch a web page' : `Use ${label}`
    const modern = {
      ...common, purpose: 'permission',
      why: 'Claude stopped at a permission prompt and is waiting. Allow once presses Yes in its terminal; Deny presses Escape and tells it to find another way. Nothing here changes its permission settings.',
      permission: {
        tool,
        ...(command == null ? {} : { command: cut(redact(String(command)), 2000) }),
        ...(fileTool && (data.file_path || data.notebook_path) ? { path: data.file_path || data.notebook_path } : {}),
        summary: cut(plainify(`${toolSummary} in ${workspace}`), 200),
      },
    }
    const legacy = {
      ...common, purpose: 'decision', only_you: 'judgment',
      why: `Claude stopped at a permission prompt and is waiting. It wants to run: ${summary}. Allow once presses Yes in its terminal; Deny presses Escape and tells it to find another way. Nothing here changes its permission settings.`,
      tried: ['Claude stopped at its own permission prompt; only you can approve this step for it.'],
      fields: [{ name: 'decision', type: 'choice', label: 'Let it run this once?', choices: [{ value: 'allow_once', label: 'Allow once' }, { value: 'deny', label: 'Deny' }], recommend: { value: 'allow_once', why: 'Claude chose this step itself; deny it if the command looks wrong.' }, must_decide: true }],
    }
    // A new permission dialog supersedes any old dialog recorded for the pane.
    for (const entry of entries(pane).filter((e) => ['detected', 'permission'].includes(e.type))) {
      try {
        const current = await request(`/api/asks/${entry.ticket}`)
        if (current.status === 'open') await request(`/api/asks/${entry.ticket}/cancel`, { note: 'replaced by the permission prompt' })
      } catch { /* stale registry */ }
      remove(entry.ticket)
    }
    source.session_id = `permission:${pane}`
    source.agent = 'claude'
    const { ticket } = await fileFirst([modern, legacy], source)
    if (!readEntry(ticket)) {
      register(ticket, pane, 'permission', { fingerprint })
      watcher(ticket)
    }
  }
} catch { log('permission hook failed open') }
clearTimeout(timer)
