import { delivered, recheckNotice } from './pane-notice.js'
import { liveLane } from './lane-state.js'

export async function recheckAsk(store, ask, afterMs, diesWithOrigin) {
  const sentAt = Date.now()
  if (!diesWithOrigin(ask)) return store.markRechecked(ask.ticket, sentAt)
  if (ask.origin?.pane_id) {
    store.markRecheckAttempt(ask.ticket, sentAt)
    if (delivered(await recheckNotice(ask, afterMs))) return store.markRechecked(ask.ticket, sentAt)
  }
  const live = liveLane(ask)
  if (!live) return ask.origin?.pane_id ? store.markRecheckFailed(ask.ticket) : store.markRecheckUnreachable(ask.ticket)
  store.markRecheckAttempt(ask.ticket, sentAt)
  if (live.t3 && delivered(await recheckNotice(ask, afterMs, live.lane))) store.markRechecked(ask.ticket, sentAt)
  else console.error(`unblock: recheck for ${ask.ticket} undelivered; lane ${live.lane} is live, so it stays with Alex`)
}
