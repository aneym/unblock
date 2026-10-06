const ORDER = ['rails_queued', 'relay_seen', 'daemon_received', 'delivered', 'answer_started', 'answer_first_text', 'answered', 'pushed']

export function latencySince(value, now = Date.now()) {
  if (value === undefined) return -Infinity
  const relative = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value)
  if (relative) return now - Number(relative[1]) * { m: 60000, h: 3600000, d: 86400000 }[relative[2]]
  const at = /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN
  if (!Number.isFinite(at)) throw new Error('invalid --since: use an ISO time or duration like 30m, 2h, 1d')
  return at
}

export function scopeLatency(notes, since = -Infinity) {
  const threads = notes.filter(note => note.event === 'new' && note.stamps && Date.parse(note.at) >= since)
  const samples = Object.fromEntries([...ORDER.slice(1), 'total'].map(step => [step, []]))
  for (const note of threads) {
    let previous = null
    const times = []
    for (const step of ORDER) {
      const at = Date.parse(note.stamps[`${step}_at`])
      if (!Number.isFinite(at)) continue
      if (previous !== null && step !== 'rails_queued') samples[step].push((at - previous) / 1000)
      previous = at
      times.push(at)
    }
    if (times.length) samples.total.push((Math.max(...times) - Math.min(...times)) / 1000)
  }
  const percentile = (values, p) => {
    // Nearest rank: p95 of a few samples is the slowest one, never a blend that hides it.
    if (!values.length) return null
    return Math.round(values[Math.max(0, Math.ceil(values.length * p) - 1)] * 10) / 10
  }
  return { threads: threads.length, steps: Object.entries(samples).map(([step, values]) => {
    values.sort((a, b) => a - b)
    return { step, n: values.length, p50_s: percentile(values, 0.5), p95_s: percentile(values, 0.95) }
  }) }
}
