/** alt+p u — open unblock mode. */
import { openQueuePane } from './herdr.js'
import { daemon } from './paths.js'
try {
  await daemon().catch(() => {}) // warm it, but never block opening the pane
  await openQueuePane()
} catch (err) {
  console.error(`unblock: could not open the queue pane — ${err.message}`)
  process.exit(1)
}
