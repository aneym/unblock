import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const USD_PER_MINUTE = {
  'gpt-realtime-2.1': 0.10,
  'gpt-realtime-2.1-mini': 0.04,
  'gemini-3.8-live': 0.02,
  'gemini-3.8-live-extended-thinking': 0.06,
  'grok-voice-think-fast-2.0': 0.08,
  'grok-voice-latest': 0.08,
}

export function rateFor(model) {
  return USD_PER_MINUTE[model] ?? 0.10
}

export function createSpendLedger({ file, capUsd = 20, maxMinutes = 15, now = Date.now }) {
  const period = (date) => new Date(date).toISOString().slice(0, 7)
  const load = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(data.sessions) ? data.sessions : []
    } catch { return [] }
  }
  const save = (sessions) => {
    const current = period(now())
    const previous = new Date(`${current}-01T00:00:00Z`)
    previous.setUTCMonth(previous.getUTCMonth() - 1)
    const kept = sessions.filter((session) => [current, period(previous)].includes(session.period))
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ sessions: kept }), { mode: 0o600 })
    renameSync(temporary, file)
  }
  const cost = (session) => session.settled ? session.charged_usd : session.rate * session.max_minutes
  const status = () => {
    const current = period(now())
    const spent = load().filter((session) => session.period === current).reduce((sum, session) => sum + cost(session), 0)
    return { spent_usd: Math.round(spent * 100) / 100, cap_usd: capUsd, period: current }
  }
  return {
    status,
    get(session_id) { return load().find((session) => session.session_id === session_id) },
    reserve({ provider, model }) {
      const sessions = load()
      const current = period(now())
      const spent = sessions.filter((session) => session.period === current).reduce((sum, session) => sum + cost(session), 0)
      const rate = rateFor(model)
      const minutes = Math.min(maxMinutes, Math.floor((capUsd - spent + 1e-9) / rate))
      if (minutes < 1) {
        const error = new Error('Voice hit this month’s cap')
        error.code = 'VOICE_SPEND_CAP'
        throw error
      }
      const session_id = randomUUID()
      sessions.push({ session_id, provider, model, period: current, started_at: new Date(now()).toISOString(), rate, max_minutes: minutes, settled: false })
      save(sessions)
      return { session_id, max_minutes: minutes }
    },
    settle(session_id, seconds) {
      const sessions = load()
      const session = sessions.find((entry) => entry.session_id === session_id && !entry.settled)
      if (!session) return false
      const duration = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
      session.charged_usd = session.rate * Math.ceil(Math.min(duration, session.max_minutes * 60) / 60)
      session.settled = true
      save(sessions)
      return true
    },
  }
}
