import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ASSET_ID = /^[0-9a-f]{16}\.(png|jpg|webp|gif|svg|html|mock|mp4|webm)$/
export const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)\s*$/
const LIMIT = 8 * 1024 * 1024
const SCOPE_LIMIT = 200 * 1024 * 1024
export const assetLimit = (contentType) => ['video/mp4', 'video/webm'].includes(contentType) ? 64 * 1024 * 1024 : LIMIT
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'text/html': 'html', 'application/json': 'mock', 'video/mp4': 'mp4', 'video/webm': 'webm' }
const HTML_CSP = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; img-src data:; media-src data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com"
const CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com"
function bad(message, status = 400) { const error = new Error(message); error.status = status; throw error }
function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { bad('asset must be UTF-8') }
}
function dimensions(bytes, ext) {
  if (ext === 'png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  if (ext === 'gif' && bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)]
  if (ext === 'jpg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2
    while (pos < bytes.length) {
      if (bytes[pos++] !== 0xff) break
      while (bytes[pos] === 0xff) pos++
      const marker = bytes[pos++]
      if (marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (pos + 2 > bytes.length) break
      const length = bytes.readUInt16BE(pos)
      if (length < 2 || pos + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) return [bytes.readUInt16BE(pos + 5), bytes.readUInt16BE(pos + 3)]
      pos += length
    }
  }
  if (ext === 'webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    let pos = 12
    while (pos + 8 <= bytes.length) {
      const chunk = bytes.toString('ascii', pos, pos + 4), length = bytes.readUInt32LE(pos + 4), start = pos + 8
      if (start + length > bytes.length) break
      if (chunk === 'VP8X' && length >= 10) return [1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3)]
      if (chunk === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1)
        return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
      }
      if (chunk === 'VP8 ' && length >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff]
      pos = start + length + (length % 2)
    }
  }
  if (ext === 'svg') {
    const text = utf8(bytes).replace(/^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*/, '')
    const root = text.match(/^<svg\b([^>]*)>/)
    if (!root) bad('asset does not match image/svg+xml')
    const attr = (name) => root[1].match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']+)["']`))?.[1]
    const size = (value) => /^\d+(?:\.\d+)?(?:px)?$/.test(value ?? '') && parseFloat(value) > 0 ? parseFloat(value) : null
    const view = (attr('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
    return [size(attr('width')) ?? (view.length === 4 && view.every(Number.isFinite) && view[2] > 0 ? view[2] : null), size(attr('height')) ?? (view.length === 4 && view.every(Number.isFinite) && view[3] > 0 ? view[3] : null)]
  }
  bad('asset bytes do not match content type')
}

export function readAsset(dir, id) {
  if (!ASSET_ID.test(id)) return null
  try {
    const bytes = readFileSync(join(dir, id))
    const metadata = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
    return { bytes, metadata }
  } catch { return null }
}

export function readAssetBody(req, limit = LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error) }
    const error = (err) => { cleanup(); reject(err) }
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)) }
    const data = (chunk) => {
      size += chunk.length
      if (size > limit) {
        const err = new Error(`asset exceeds ${limit / (1024 * 1024)} MiB`)
        err.status = 413
        error(err)
        req.resume()
      } else chunks.push(chunk)
    }
    req.on('data', data); req.on('end', end); req.on('error', error)
  })
}

export function storeAsset(dir, bytes, contentType) {
  const ext = TYPES[contentType]
  if (!ext) bad('unsupported asset content type', 415)
  let type = 'image', width = null, height = null
  if (ext === 'mock') {
    let record
    try { record = JSON.parse(utf8(bytes)) } catch { bad('invalid mock record') }
    if (!record || record.kind !== 'mock' || !['desktop', 'phone'].includes(record.frame) || !(record.dark === null || typeof record.dark === 'string')) bad('invalid mock record')
    const html = readAsset(dir, record.html), light = readAsset(dir, record.light), dark = record.dark === null ? null : readAsset(dir, record.dark)
    if (html?.metadata.type !== 'html' || light?.metadata.type !== 'image' || (record.dark !== null && dark?.metadata.type !== 'image')) bad('mock references must exist in this scope with the right type')
    bytes = Buffer.from(JSON.stringify({ kind: 'mock', html: record.html, light: record.light, dark: record.dark, frame: record.frame }))
    type = 'mock'; width = light.metadata.width; height = light.metadata.height
  } else if (ext === 'html') { utf8(bytes); type = 'html' }
  else if (ext === 'mp4' || ext === 'webm') {
    const matches = ext === 'mp4' ? bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp' : bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))
    if (!matches) bad('asset bytes do not match content type')
    type = 'video'
  } else {
    ;[width, height] = dimensions(bytes, ext)
    if (ext !== 'svg' && (!width || !height)) bad('invalid image dimensions')
  }
  const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${ext}`
  const duplicate = readAsset(dir, id)
  if (!duplicate) {
    mkdirSync(dir, { recursive: true })
    const total = readdirSync(dir).filter((name) => ASSET_ID.test(name)).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
    if (total + bytes.length > SCOPE_LIMIT) bad('scope assets exceed 200 MiB', 413)
    const metadata = { type, width, height, content_type: contentType, bytes: bytes.length }
    const temp = join(dir, `.asset-${randomUUID()}`)
    writeFileSync(temp, bytes)
    renameSync(temp, join(dir, id))
    writeFileSync(`${temp}.json`, JSON.stringify(metadata))
    renameSync(`${temp}.json`, join(dir, `${id}.json`))
  }
  return { status: duplicate ? 200 : 201, asset: { id, ref: `asset:${id}`, type, width, height } }
}

export function serveAsset(req, res, asset) {
  const type = asset.metadata.content_type, total = asset.bytes.length
  const headers = {
    'Content-Type': `${type}${['text/html', 'image/svg+xml'].includes(type) ? '; charset=utf-8' : ''}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Security-Policy': type === 'text/html' ? HTML_CSP : CSP,
    'Accept-Ranges': 'bytes',
    'Content-Length': total,
  }
  const range = typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null
  let status = 200, bytes = asset.bytes
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]))
    const end = range[1] ? range[2] ? Math.min(Number(range[2]), total - 1) : total - 1 : total - 1
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && (end >= start || start >= total)) {
      if (start >= total) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}`, 'Content-Length': 0 })
        return res.end()
      }
      status = 206
      bytes = asset.bytes.subarray(start, end + 1)
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`
      headers['Content-Length'] = bytes.length
    }
  }
  res.writeHead(status, headers)
  res.end(bytes)
}

export function docAssets(dir, sections) {
  const assets = {}
  const reference = (fence, key, value, expected) => {
    if (typeof value === 'string') {
      try { if (new URL(value).protocol === 'https:') return } catch {}
      if (value.startsWith('asset:')) {
        const id = value.slice(6), asset = readAsset(dir, id)
        if (!asset) bad(`${fence} ${key}: unknown asset ${id}`)
        const { type, width, height } = asset.metadata
        if (type !== expected) bad(`${fence} ${key} must reference an ${expected} asset`)
        assets[id] = { type, width, height }
        return
      }
    }
    bad(`${fence} ${key} must be an https URL or asset:<id>${expected === 'html' ? '.html' : expected === 'video' ? '.mp4 or .webm' : ' image'}`)
  }
  for (const section of Array.isArray(sections) ? sections : []) {
    if (typeof section?.body_md !== 'string') continue
    let fence = null, values = {}
    const finish = () => {
      if (!['demo', 'video'].includes(fence)) return
      reference(fence, 'src', values.src, fence === 'demo' ? 'html' : 'video')
      if (fence === 'video' && values.poster !== undefined) reference(fence, 'poster', values.poster, 'image')
    }
    // The end of the section closes an open fence, as it does on the page.
    for (const line of [...section.body_md.split('\n'), '```']) {
      if (fence !== null) {
        if (/^```/.test(line)) { finish(); fence = null; values = {} }
        else if (['demo', 'video'].includes(fence)) {
          const pair = line.match(/^\s*(src|poster|height|frame|allow):\s*(.*?)\s*$/)
          if (pair) values[pair[1]] = pair[2]
        }
        continue
      }
      if (/^```/.test(line)) { fence = line.match(/^```(demo|video)\s*$/)?.[1] ?? ''; continue }
      if (!/!\[(?:[^[\]\n]|\[(?:[^[\]\n]|\[[^[\]\n]*\])*\])*\]\(/.test(line)) continue
      const image = line.match(IMAGE_LINE)
      if (!image || !image[2].startsWith('asset:') || !ASSET_ID.test(image[2].slice(6))) bad(`invalid image ${image?.[1] ?? line}: unblock scope doc --from uploads local files`)
      if (image[3] !== undefined && image[3] !== 'phone') bad(`invalid image title for ${image[1]}: only "phone" is allowed`)
      const id = image[2].slice(6), asset = readAsset(dir, id)
      if (!asset) bad(`unknown asset ${id}`)
      const { type, width, height } = asset.metadata
      if (!['image', 'mock'].includes(type)) bad(`image ${image[1]} must reference an image or mock`)
      assets[id] = { type, width, height }
      if (type === 'mock') {
        const { light, dark, html, frame } = JSON.parse(asset.bytes.toString('utf8'))
        Object.assign(assets[id], { light, dark, html, frame })
      }
    }
  }
  return assets
}
