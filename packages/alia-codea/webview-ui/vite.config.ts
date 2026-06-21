import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['style'],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "../dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "index.js",
        assetFileNames: "index.[ext]",
        // Inline all chunks into a single file
        manualChunks: undefined,
      },
    },
    // Inline assets below 100KB
    assetsInlineLimit: 100000,
    cssCodeSplit: false,
  },
})
