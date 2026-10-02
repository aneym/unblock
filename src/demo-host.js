/**
 * rails-demo/1, the messages between a sandboxed demo player and the scope page.
 * Pure: no DOM. The page and the tests share this so a note filed from the player
 * and a pin sent back to it cannot disagree about the shape.
 */
import { cleanRegion, normalizeAnchor } from './scope-anchor.js'

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

/** A player message, or null when it is not a plain rails-demo/1 object with the fields that message requires. */
export function readDemoMessage(data) {
  if (!plain(data) || data.v !== 1) return null
  if (data.type === 'rails-demo/note') return readNote(data)
  if (data.type === 'rails-demo/ready') return readReady(data)
  if (data.type === 'rails-demo/time') return readTime(data)
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
