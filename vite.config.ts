import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['jwalsh-ubuntu-1.tail4794a2.ts.net'],
  },
  preview: {
    allowedHosts: ['jwalsh-ubuntu-1.tail4794a2.ts.net'],
  },
})
