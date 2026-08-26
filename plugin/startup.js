/** Warm the daemon so an agent that parks never pays a cold start mid-turn.
 *  Always exits 0 — a broken unblock must never stop a herdr session starting. */
import { daemon } from './paths.js'
try {
  const base = await daemon({ timeoutMs: 5000 })
  console.log(`unblock daemon at ${base}`)
} catch (err) {
  console.error(`unblock: daemon did not start (${err.message}); it will start on first use`)
}
process.exit(0)
