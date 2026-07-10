import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Standalone admin site. Built assets land in admin/dist and are served by the
// Express server at /admin. Dev: `npm run dev:admin` (proxies /api to :8787).
export default defineConfig({
  root: __dirname,
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
