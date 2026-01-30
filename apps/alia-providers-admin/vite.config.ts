import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    exclude: ['@oxyhq/services'],
  },
  ssr: {
    noExternal: ['@oxyhq/services'],
  },
  build: {
    rollupOptions: {
      external: (id) => {
        // Exclude react-native and expo packages from the bundle
        // These exist in the monorepo but are not needed for web
        return id.includes('react-native') ||
               id.includes('expo') ||
               id.startsWith('@expo/') ||
               id.startsWith('@react-native');
      },
    },
  },
})
