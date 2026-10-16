import { ALIA_WEB_ORIGIN } from './origins';

/**
 * Where the 3D character runtime (Alia's avatar) is served from when the host does not say.
 *
 * The runtime is ~214 MB of engine and data, so the chat loads it from Alia's own web origin
 * instead of asking every app to host a copy. That origin serves it with CORS open
 * (`packages/app/worker/index.js`), which a cross-origin module import needs; a host with a
 * CSP allows it with `@alia.onl/sdk/csp`. A host that serves its own copy passes
 * `characterRuntimeUrl`.
 */
export const ALIA_CHARACTER_RUNTIME_URL = `${ALIA_WEB_ORIGIN}/bloom-character/runtime.mjs`;
