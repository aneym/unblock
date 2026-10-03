/**
 * rails-demo/1, the messages between a sandboxed demo player and the scope page.
 * Pure: no DOM. The page and the tests share this so a note filed from the player
 * and a pin sent back to it cannot disagree about the shape. A player may report
 * its own content height with rails-demo/size; that height is rounded and clamped
 * to 160..2400 px, and the fence height stays the placeholder until it arrives.
 */
import { cleanRegion, normalizeAnchor, locateAnchor, locateEmbed } from './scope-anchor.js'

const NOTE_ID = /^[A-Za-z0-9_-]{1,64}$/
const UNIT = /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/
const SHA = /^[a-f0-9]{40}$/i
const SHOT = 'data:image/png;base64,'
const MAX_SHOT = 3 * 1024 * 1024

const plain = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const cut = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

const round1 = (n) => Math.round(n * 10) / 10

function cleanStep(step) {
  return Number.isInteger(step) && step >= 0 && step <= 999 ? step : null
}

function cleanShot(shot) {
  if (typeof shot !== 'string' || !shot.startsWith(SHOT) || shot.length >= MAX_SHOT) return null
  return shot
}

function cleanDemo(demo) {
  if (demo == null) return null
  if (!plain(demo)) return null
  const unit = typeof demo.unit === 'string' && UNIT.test(demo.unit) ? demo.unit : null
  const sha = typeof demo.sha === 'string' && SHA.test(demo.sha) ? demo.sha : null
  const run = typeof demo.run === 'string' && demo.run.length >= 1 && demo.run.length <= 80 ? demo.run : null
  return { unit, sha, run }
}

function cleanSteps(steps) {
  if (!Array.isArray(steps)) return null
  const out = []
  for (const step of steps) {
    if (out.length >= 100) break
    if (!plain(step) || !Number.isFinite(step.start)) continue
    out.push({ start: step.start, caption: cut(step.caption, 200) })
  }
  return out
}

function readNote(data) {
  if (typeof data.id !== 'string' || !NOTE_ID.test(data.id)) return null
  if (!Number.isFinite(data.t) || data.t < 0 || data.t > 86400) return null
  if (typeof data.text !== 'string') return null
  const text = data.text.trim()
  if (text.length < 1 || text.length > 4000) return null
  return {
    type: 'rails-demo/note',
    v: 1,
    id: data.id,
    t: round1(data.t),
    step: cleanStep(data.step),
    caption: cut(data.caption, 200),
    region: cleanRegion(data.region),
    text,
    shot: cleanShot(data.shot),
  }
}

function readReady(data) {
  if (!Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 600) return null
  const steps = cleanSteps(data.steps) ?? []
  return {
    type: 'rails-demo/ready',
    v: 1,
    title: cut(data.title, 200),
    duration: data.duration,
    steps,
    demo: cleanDemo(data.demo),
  }
}

function readTime(data) {
  if (!Number.isFinite(data.t) || typeof data.playing !== 'boolean') return null
  return { type: 'rails-demo/time', v: 1, t: data.t, playing: data.playing }
}

function readSize(data) {
  if (!Number.isFinite(data.h) || data.h <= 0) return null
  return { type: 'rails-demo/size', v: 1, h: Math.min(2400, Math.max(160, Math.round(data.h))) }
}

/** A player message, or null when it is not a plain rails-demo/1 object with the fields that message requires. */
export function readDemoMessage(data) {
  if (!plain(data) || data.v !== 1) return null
  if (data.type === 'rails-demo/note') return readNote(data)
  if (data.type === 'rails-demo/ready') return readReady(data)
  if (data.type === 'rails-demo/time') return readTime(data)
  if (data.type === 'rails-demo/size') return readSize(data)
  return null
}

/** A player note as a scope comment on the demo's caption. */
export function demoNote(msg, captionAnchor) {
  return {
    anchor: normalizeAnchor({ ...captionAnchor, t: msg.t, step: msg.step ?? undefined, region: msg.region ?? undefined }),
    text: msg.text,
  }
}

/** Pins for one figure: threads on the same caption that carry a moment, earliest first. */
export function demoPins(threads, captionAnchor) {
  const notes = []
  for (const thread of threads || []) {
    const anchor = thread?.anchor
    if (!anchor || anchor.section !== captionAnchor?.section || anchor.quote !== captionAnchor?.quote || typeof anchor.t !== 'number') continue
    notes.push(thread)
  }
  notes.sort((a, b) => a.anchor.t - b.anchor.t)
  return {
    type: 'rails-demo/notes',
    v: 1,
    notes: notes.map((thread) => ({
      id: thread.id,
      t: thread.anchor.t,
      region: thread.anchor.region ?? null,
      text: thread.messages?.[0]?.text ?? '',
      author: thread.author === 'alex' ? 'Alex' : 'Agent',
      resolved: thread.status !== 'open',
    })),
  }
}

// HTML assets retain their opaque sandbox. A per-load capability binds replies to
// the exact iframe; the child accepts commands only from its URL's parent origin.
export function embedBridgeScript() {
  return `<script>(() => { const fold = text => text.split('').map(ch => ch.toLowerCase().length === 1 ? ch.toLowerCase() : ch).join(''); const locateAnchor = ${locateAnchor.toString()};(${embedBridge.toString()})(${locateEmbed.toString()}); })()</script>`
}
function embedBridge(matcher) {
  const locate = matcher
  let token = '', parentOrigin = ''
  const textMap = () => {
    let text = ''; const map = []
    const walk = node => {
      if (node.nodeType === 1) {
        if (node.matches('script,style,button,input,textarea,select,[hidden],[data-cm-skip]')) return
        if (text && /^(H[1-6]|P|LI|DIV|TR|PRE|SECTION)$/.test(node.tagName)) { text += '\n'; map.push(null) }
        node.childNodes.forEach(walk)
      } else if (node.nodeType === 3) {
        for (let i = 0; i < node.length; i++) { text += node.data[i]; map.push({ node, offset: i }) }
      }
    }
    walk(document.body); return { text, map }
  }
  const send = data => { if (token) parent.postMessage({ type: 'rails-embed', token, ...data }, parentOrigin) }
  const findRange = anchor => {
    const { text, map } = textMap(), found = locate(text, anchor)
    if (!found) return null
    const positions = map.slice(found.start, found.end).filter(Boolean)
    if (!positions.length) return null
    const range = document.createRange(), first = positions[0], last = positions.at(-1)
    range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset + 1)
    return range
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'rails-embed') return
    const data = event.data
    if (data.action === 'init' && typeof data.token === 'string') { token = data.token; parentOrigin = event.origin; send({ action: 'ready' }); return }
    if (!token || data.token !== token) return
    if (data.action === 'match') send({ action: 'matches', matches: data.anchors.map(item => ({ id: item.id, found: !!findRange(item.anchor) })) })
    if (data.action === 'highlight') {
      const range = findRange(data.anchor)
      if (range) { range.startContainer.parentElement?.scrollIntoView({ block: 'center' }); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range) }
    }
  })
  let timer
  const selected = () => {
    const sel = getSelection()
    if (!token || !sel?.rangeCount || sel.isCollapsed) return
    const range = sel.getRangeAt(0), { text, map } = textMap()
    const inside = map.map((pos, i) => pos && range.comparePoint(pos.node, pos.offset) === 0 && !(pos.node === range.endContainer && pos.offset === range.endOffset) ? i : -1).filter(i => i >= 0)
    if (!inside.length) return
    const start = inside[0], end = inside.at(-1) + 1, clean = text => text.replace(/\s+/g, ' ').trim()
    const quote = clean(text.slice(start, end)).slice(0, 300).trim()
    if (!quote) return
    const rect = range.getBoundingClientRect()
    send({ action: 'selection', anchor: { quote, prefix: clean(text.slice(0, start)).slice(-40), suffix: clean(text.slice(end)).slice(0, 40) }, rect: { top: rect.top, bottom: rect.bottom, right: rect.right } })
  }
  for (const event of ['selectionchange', 'pointerup', 'mouseup']) document.addEventListener(event, () => { clearTimeout(timer); timer = setTimeout(selected, 80) })
}
