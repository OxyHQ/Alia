/**
 * Where the 3D character runtime (Alia's avatar) is served from when the host does not say.
 *
 * The runtime is ~214 MB of engine and data, so the chat loads it from Alia's own web origin
 * instead of asking every app to host a copy. That origin serves it with CORS open
 * (`packages/app/worker/index.js`), which a cross-origin module import needs; an app with a
 * strict CSP allows it in `script-src` and `connect-src`. A host that serves its own copy
 * passes `characterRuntimeUrl`.
 */
export const ALIA_CHARACTER_RUNTIME_URL = 'https://alia.onl/bloom-character/runtime.mjs';
