export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export function createAlexViewCache({ store, compute, partial, budgetMs = Number(process.env.UNBLOCK_ALEX_VIEW_BUDGET_MS) || 3000 }) {
  let last = null
  let running = null

  const refresh = () => {
    if (running) return running
    const started = compute()
      .catch((error) => ({ ...partial(), error: `alex view unavailable: ${error.message}` }))
      .then((view) => {
        if (!view.error) last = { view, at: Date.now() }
        return view
      })
    running = started.finally(() => { running = null })
    return running
  }

  const stale = () => {
    const open = (ask) => {
      const current = store.get(ask.ticket)
      return current?.status === 'open' && current.set_aside_at == null
    }
    return { ...last.view, asks: last.view.asks.filter(open), stale: true, computed_at: last.at }
  }

  return async function get() {
    const fresh = refresh()
    let timer
    const waited = new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs) })
    const view = await Promise.race([fresh, waited]).finally(() => clearTimeout(timer))
    if (view && !view.error) return { ...view, computed_at: last.at }
    if (last) return stale()
    return view ?? { ...partial(), partial: true, error: 'focus and held checks still running' }
  }
}
