import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['ubuntu-clone.tail4794a2.ts.net'],
  },
  preview: {
    allowedHosts: ['ubuntu-clone.tail4794a2.ts.net'],
  },
})
