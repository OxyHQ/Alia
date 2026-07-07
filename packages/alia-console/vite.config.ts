import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import reactNativeWeb from 'vite-plugin-react-native-web'

const __dirname = dirname(fileURLToPath(import.meta.url))
const emptyModule = resolve(__dirname, './src/empty-module.js')

// The console bundles the `@oxyhq/services` React Native graph on web via
// rolldown-vite (`"vite": "npm:rolldown-vite@^7"`) + the maintained
// `vite-plugin-react-native-web` plugin (aliases react-native→react-native-web,
// applies `.web.*` extension priority, strips Flow, keeps expo-modules-core's
// web polyfill). Mirrors the OxyHQServices console reference.
const config = defineConfig(({ mode }) => ({
  plugins: [
    devtools(),
    reactNativeWeb(),
    nitro(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    // Device-first auth (OxyProvider) and all data fetching are client-side, so
    // the authenticated route tree must not server-render the React Native web
    // graph per request. SPA mode prerenders only the root shell (OxyProvider +
    // providers, verified) and hydrates pages client-side; the nitro server
    // output / deploy contract is unchanged.
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
  resolve: {
    conditions: ['style'],
    alias: [
      // Deep native-only internals that monorepo hoisting can pull in
      // transitively and that have no web implementation.
      { find: /^react-native\/Libraries\/.*/, replacement: emptyModule },
      // Native-only navigation primitives; `sonner-native` named-imports
      // FullWindowOverlay, which on web renders straight through (see shim).
      {
        find: 'react-native-screens',
        replacement: resolve(__dirname, './src/shims/react-native-screens.js'),
      },
      // react-native-svg asset resolution reaches for RN's Flow-typed CJS asset
      // registry; on web the one true registry is react-native-web's (ESM, same
      // registerAsset/getAssetByID API).
      {
        find: '@react-native/assets-registry/registry',
        replacement: 'react-native-web/dist/modules/AssetRegistry',
      },
    ],
  },
  define: {
    // vite-plugin-react-native-web pins __DEV__=false and NODE_ENV=production
    // unconditionally; re-assert the mode-aware values (user config wins over
    // plugin config in Vite's merge).
    __DEV__: JSON.stringify(mode !== 'production'),
    'process.env.NODE_ENV': JSON.stringify(mode),
  },
  ssr: {
    // The React Native graph is source (Flow/JSX/`.native`/`.web` splits) and
    // must be transformed by Vite for the SPA-shell prerender instead of being
    // required raw from node_modules (Node cannot load react-native source).
    noExternal: [
      '@oxyhq/services',
      '@oxyhq/bloom',
      '@oxyhq/core',
      'react-native',
      'react-native-web',
      /^react-native-/,
      /^expo/,
      /^@expo/,
      '@react-native-async-storage/async-storage',
      '@react-native-community/netinfo',
      'nativewind',
      'react-native-css',
    ],
  },
}))

export default config
