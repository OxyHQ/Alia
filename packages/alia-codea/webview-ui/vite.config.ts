import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import reactNativeWeb from "vite-plugin-react-native-web"

const emptyModule = path.resolve(__dirname, "./src/empty-module.js")

// The webview bundles `@oxyhq/bloom`'s React Native module graph (the
// `BloomThemeProvider`) through the maintained `vite-plugin-react-native-web`
// plugin — the same setup as `alia-gateway-admin`. It aliases
// react-native→react-native-web, applies `.web.*` platform-extension priority
// in dev AND build, treats RN packages' JSX-in-.js via rolldown moduleTypes,
// strips Flow types, and defines the RN globals. Runs on rolldown-vite
// (`"vite": "npm:rolldown-vite@^7"`) to match the hoisted root toolchain.
// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [reactNativeWeb(), react(), tailwindcss()],
  resolve: {
    conditions: ['style'],
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // Deep native-only internals that monorepo hoisting can pull in
      // transitively and that have no web implementation.
      { find: /^react-native\/Libraries\/.*/, replacement: emptyModule },
    ],
  },
  define: {
    // vite-plugin-react-native-web pins __DEV__=false and NODE_ENV=production
    // unconditionally; re-assert the mode-aware values (user config wins over
    // plugin config in Vite's merge).
    __DEV__: JSON.stringify(mode !== 'production'),
    'process.env.NODE_ENV': JSON.stringify(mode),
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
}))
