import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Em desenvolvimento, a API roda no backend (cargo run) e o Vite repassa /api.
const backend = process.env.RM_BACKEND_URL ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // O teste de consistência do console lê ../docs/console.md.
    fs: { allow: ['.', '../docs'] },
    proxy: {
      '/api': backend,
      '/healthz': backend,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
