/** Install-time gate. Fail loudly here rather than the first time an agent parks. */
const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  console.error(`unblock needs Node 22 or newer for node:sqlite; this is ${process.version}`)
  process.exit(1)
}
try {
  await import('node:sqlite')
} catch {
  console.error(`unblock needs node:sqlite, which ${process.version} does not provide`)
  process.exit(1)
}
console.log(`unblock: Node ${process.version} ok`)
