const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

const labels = {
  approve: 'Approved by Alex',
  approve_to_try: 'Approved to try by Alex',
  approve_with_changes: 'Approved with changes by Alex',
  not_yet: 'Not yet',
}

export function approvalBannerHtml(approval) {
  if (!approval) return ''
  const label = labels[approval.mode] || ''
  const meta = approval.via === 'pm-relay'
    ? `<div class="approval-meta">Relayed by the PM from chat${approval.open ? ` · approved with ${esc(approval.open)} open` : ''}</div>`
    : ''
  const words = approval.quote ?? approval.comment
  const quoteBlock = words ? `<blockquote class="approval-note">${esc(words)}</blockquote>` : ''
  return `<div class="approval" data-cm-skip><strong>${esc(label)}</strong> · ${esc(approval.at_et ?? '')}${meta}${quoteBlock}</div>`
}
