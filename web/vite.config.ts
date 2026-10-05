import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'
import { renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  const bundle = mode === 'scope-bundle'
  return {
    base: './',
    resolve: { alias: { 'elkjs/lib/elk.bundled.js': resolve(dir, 'src/scope/elk-stub.ts') } },
    build: { assetsInlineLimit: 0, outDir: bundle ? 'dist-scope' : 'dist', rollupOptions: { input: bundle ? resolve(dir, 'scope.html') : { main: resolve(dir, 'index.html'), scope: resolve(dir, 'scope.html') } } },
    plugins: [react(), tailwindcss(), ...(bundle ? [{
      name: 'scope-bundle',
      transformIndexHtml() { return [{ tag: 'script', attrs: { src: './boot.js' }, injectTo: 'head-prepend' as const }] },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'boot.js', source: '// Development area may replace this file with scope boot configuration.\n' })
      },
      writeBundle(output) { const out = output.dir || resolve(dir, 'dist-scope'); renameSync(resolve(out, 'scope.html'), resolve(out, 'index.html')) },
    } satisfies Plugin] : [])],
  }
})
