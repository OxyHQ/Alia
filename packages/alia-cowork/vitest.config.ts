import { defineConfig } from 'vitest/config'

/**
 * Cowork's suite.
 *
 * `include` is explicit rather than left to vitest's default glob, because this
 * package's directory holds three things the default would happily walk into:
 * `out/` (the retired Electron Forge build output), `renderer/` (its own
 * package, with its own dependency tree and its own build) and `resources/`.
 * A runner that picks up a test from a stale build directory runs a bundled
 * copy of the code under test, which is the kind of green nobody can read.
 *
 * `environment: 'node'` is the truthful setting for what is here: the preload
 * bridge is Electron main-world glue tested against a real `EventEmitter`, not
 * a DOM. A renderer component test would want jsdom and its own config next to
 * the renderer package.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
