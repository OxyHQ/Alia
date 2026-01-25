import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname, 'renderer'),
  build: {
    outDir: resolve(__dirname, '.vite/renderer/main_window'),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'renderer/src'),
    },
  },
})
