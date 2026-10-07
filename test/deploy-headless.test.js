// Execute the deploy script against an isolated install; only the build and restart edges are stand-ins.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const broken of [null, 'daemon', 'scope']) {
  test(`staged deployment ${broken ? `rejects a broken ${broken} import without replacing the install` : 'ships hooks and imports its runtime before restart'}`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'unblock-deploy-')), source = join(temp, 'source'), dest = join(temp, 'installed'), tools = join(temp, 'tools')
    mkdirSync(source); mkdirSync(join(dest, 'src'), { recursive: true }); mkdirSync(tools)
    const marker = join(temp, 'restarted')
    writeFileSync(join(dest, 'src', 'daemon.js'), '// previous install\n')
    writeFileSync(join(dest, 'sentinel'), 'previous install')
    const executable = (path, source) => { writeFileSync(path, source); chmodSync(path, 0o700) }
    for (const dir of ['src', 'plugin', 'hooks', 'bin', 'headless']) cpSync(join(import.meta.dirname, '..', dir), join(source, dir), { recursive: true })
    cpSync(join(import.meta.dirname, '..', 'package.json'), join(source, 'package.json'))
    executable(join(source, 'bin', 'unblock.js'), `#!/usr/bin/env node\nif (process.argv[2] === 'daemon') requireMarker();\nfunction requireMarker() { import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(marker)}, 'restarted')) }\n`)
    executable(join(tools, 'npm'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--outDir" ]; then shift; mkdir -p "$1"; exit 0; fi; shift; done\nexit 1\n')
    if (broken) writeFileSync(join(source, 'src', `${broken}.js`), "import './missing-runtime-module.js'\n")
    try {
      const run = spawnSync('bash', [join(source, 'bin', 'deploy-headless.sh')], { encoding: 'utf8',
        env: { ...process.env, UNBLOCK_ROOT: dest, PATH: `${tools}:${process.env.PATH}` }, timeout: 30000 })
      if (broken) {
        assert.notEqual(run.status, 0, run.stdout)
        assert.match(run.stderr, /missing-runtime-module/)
        assert.equal(readFileSync(join(dest, 'sentinel'), 'utf8'), 'previous install')
        assert.ok(!existsSync(marker), 'failed staging must not restart')
      } else {
        assert.equal(run.status, 0, run.stderr)
        assert.ok(!existsSync(join(dest, 'sentinel')))
        assert.ok(existsSync(join(dest, 'hooks', 'lib.js')))
        assert.equal(readFileSync(marker, 'utf8'), 'restarted')
      }
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
}
