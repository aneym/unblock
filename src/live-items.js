export const MAX_TEXT = 12000

const ranks = { seen: 0, thinking: 1, streaming: 2, done: 3, failed: 3 }
const terminal = (item) => ranks[item.status] === 3

export function createLiveItems({ emit }) {
  const scopes = new Map()
  const timers = new Map()
  let seq = 0

  function prune(slug) {
    const items = scopes.get(slug)
    if (!items) return
    const now = Date.now()
    for (const [id, item] of items) {
      if (now - Date.parse(item.updated_at) >= (terminal(item) ? 10 : 15) * 60_000) items.delete(id)
    }
    while (items.size > 100) items.delete(items.keys().next().value)
    if (!items.size) scopes.delete(slug)
  }

  function list(slug) {
    prune(slug)
    return [...(scopes.get(slug)?.values() ?? [])]
  }

  function upsert(slug, patch, { staleMs } = {}) {
    prune(slug)
    const id = patch.id ?? `${patch.thread}@${patch.to}`
    const items = scopes.get(slug) ?? new Map()
    const previous = items.get(id)
    if (!(patch.status in ranks)) throw new Error('invalid live item status')
    if (previous && (terminal(previous) || ranks[patch.status] < ranks[previous.status])) return previous
    const item = { type: 'reply', doing: null, text: '', ...previous, ...patch, id, seq: ++seq, updated_at: new Date().toISOString() }
    item.text = item.text.slice(0, MAX_TEXT)
    const timerKey = `${slug}\0${id}`
    const previousTimer = timers.get(timerKey)
    clearTimeout(previousTimer?.timer)
    timers.delete(timerKey)
    const timeout = staleMs ?? previousTimer?.staleMs
    if (!terminal(item) && timeout !== undefined) {
      const timer = setTimeout(() => {
        upsert(slug, { id, status: 'failed', error: 'The reply stopped streaming', doing: null })
      }, timeout)
      timer.unref()
      timers.set(timerKey, { timer, staleMs: timeout })
    }
    items.delete(id)
    items.set(id, item)
    scopes.set(slug, items)
    prune(slug)
    emit(slug, 'item', item)
    return item
  }

  return { upsert, list }
}
