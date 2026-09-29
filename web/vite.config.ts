import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  base: './',
  build: { rollupOptions: { input: { main: resolve(dir, 'index.html'), scope: resolve(dir, 'scope.html') } } },
  plugins: [react(), tailwindcss()],
})
