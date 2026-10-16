import { ALIA_WEB_ORIGIN } from './origins';

/**
 * The voice call's AudioWorklet processors (`worklets/voice-processors.js`), as the web engine
 * loads them.
 *
 * Not a `blob:` URL: a worklet module is a script, so a blob would need `script-src blob:` in
 * every host's CSP, which would let any blob the page makes run as script. Alia's web app serves
 * the file instead, under `script-src https://alia.onl` that the avatar already needs
 * (`@alia.onl/sdk/csp`), with CORS open for the cross-origin `addModule`.
 *
 * The name is the file's content hash, so an SDK embedded in another app (on its own release
 * cycle) always loads the bytes it was written against: `packages/app/public/sdk/voice-worklets/`
 * keeps every revision ever published, and a test fails if this revision is not the hash of the
 * file or is not served.
 */
export const VOICE_WORKLETS_REVISION = '543d4a8e42937e99';

export const VOICE_WORKLETS_URL = `${ALIA_WEB_ORIGIN}/sdk/voice-worklets/${VOICE_WORKLETS_REVISION}.js`;
