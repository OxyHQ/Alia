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
    exclude: ['@oxyhq/services', 'react-native'],
  },
  build: {
    commonjsOptions: {
      ignore: ['react-native'],
    },
    rollupOptions: {
      external: (id) => {
        // Exclude all react-native and expo related imports
        return id.includes('react-native') ||
               id.includes('expo') ||
               id.includes('@react-native') ||
               id.includes('react-native-');
      },
    },
  },
})
