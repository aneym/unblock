const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Shared by standalone demos and each flat entry of a tabs fence.
export function parseMediaFence(source, assets = {}, assetBase = '', type = 'html') {
  const values = {}
  for (const line of source.split('\n')) { const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/); if (match) values[match[1].trim()] = match[2] }
  const mediaUrl = (value, kind) => {
    if (!value) return ''
    try { if (new URL(value).protocol === 'https:') return esc(value) } catch {}
    const id = value.startsWith('asset:') ? value.slice(6) : ''
    return id && Object.hasOwn(assets, id) && assets[id].type === kind ? esc(`${assetBase}/${encodeURIComponent(id)}`) : ''
  }
  return {
    values, src: mediaUrl(values.src, type), mediaUrl,
    height: /^-?\d+$/.test(values.height || '') ? Math.max(240, Math.min(1200, Number(values.height))) : 560,
    allow: (values.allow || '').split(',').map(v => v.trim()).filter(v => ['microphone', 'camera', 'autoplay', 'clipboard-write'].includes(v)).join('; '),
    sandbox: (values.src || '').startsWith('asset:') ? 'allow-scripts allow-forms' : 'allow-scripts allow-forms allow-same-origin allow-popups',
  }
}
