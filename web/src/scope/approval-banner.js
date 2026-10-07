const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const labels = {
  approve: 'Approved by Alex',
  approve_to_try: 'Approved to try by Alex',
  approve_with_changes: 'Approved with changes by Alex',
  not_yet: 'Not yet',
}

export function approvalBannerHtml(approval) {
  if (!approval) return ''
  const agent = approval.by === 'agent'
  const label = agent ? `Approved by an agent (${approval.approver ?? ''})` : labels[approval.mode] || ''
  const open = approval.open ? ` · approved with ${esc(approval.open)} open` : ''
  const meta = agent
    ? `<div class="approval-meta">Agent decision, not Alex · steer ${esc(approval.steer ?? '')}${open}</div>`
    : approval.via === 'pm-relay' ? `<div class="approval-meta">Relayed by the PM from chat${open}</div>` : ''
  const words = approval.quote ?? approval.comment
  const quoteBlock = words ? `<blockquote class="approval-note">${esc(words)}</blockquote>` : ''
  return `<div class="approval" data-cm-skip><strong>${esc(label)}</strong> · ${esc(approval.at_et ?? '')}${meta}${quoteBlock}</div>`
}
