import {
  AVATAR_RELEASE_PREFIX,
  serveAvatarRelease,
  serveFlatAvatarGzip,
} from './avatar-releases.js';

/**
 * Files `@alia.onl/sdk` loads from this origin in every app that embeds it: Bloom's character
 * runtime and the voice call's worklets (`/sdk/voice-worklets/<revision>.js`). A cross-origin
 * module import and a cross-origin `audioWorklet.addModule` both need CORS to run at all.
 */
const SHARED_PREFIXES = ['/bloom-character/', '/sdk/'];

/**
 * Paths whose file name carries a hash of its content, so a name is never reused for other bytes:
 * Bloom's character runtime (`assets/` and `chunks/` beside `runtime.mjs`, `name-<8 chars>.ext`,
 * as Vite names them), the SDK's voice worklets (`<16 hex>.js`, committed and append-only, see
 * `scripts/stamp-voice-worklets.mjs`) and Expo's web export (`/_expo/static/…-<32 hex>.js|css`,
 * `/assets/….<32 hex>.png`). Entry files — `index.html`, `runtime.mjs`, `manifest.json`,
 * `public/` — are not here and keep the asset server's revalidate-every-time default.
 */
const HASHED = [
  /^\/bloom-character\/(?:assets|chunks)\/[^/]+-[\w-]{8}\.[a-z0-9]+$/,
  /^\/sdk\/voice-worklets\/[0-9a-f]{16}\.js$/,
  /^\/_expo\/static\/.+-[0-9a-f]{32}\.[a-z0-9]+$/,
  /^\/assets\/.+\.[0-9a-f]{32}\.[a-z0-9]+$/,
];
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * A shared conversation (`app/(biglayout)/shared/[token].tsx`) is somebody's conversation handed
 * to the people they chose: never indexed. Said in the response, because the page itself is the
 * app shell and only says so once its script runs.
 */
const UNINDEXED_PREFIXES = ['/shared/'];

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(AVATAR_RELEASE_PREFIX)) return serveAvatarRelease(request, env, ctx);
    const compressed = await serveFlatAvatarGzip(request, env, ctx).catch(() => null);
    if (compressed) return compressed;
    const response = await env.ASSETS.fetch(request);
    const shared = SHARED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
    const hashed = HASHED.some((pattern) => pattern.test(pathname));
    const unindexed = UNINDEXED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
    if (unindexed) {
      const page = new Response(response.body, response);
      page.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return page;
    }
    if (!shared && !hashed) return response;
    // `not_found_handling` answers every miss with the app shell. Under a hashed name that is a
    // file this deploy does not have (an old tab asking for last release's chunk): say so, and let
    // nothing keep it, rather than hand back HTML that a year-long cache would pin to the name.
    if (hashed && (response.headers.get('content-type') ?? '').startsWith('text/html')) {
      return new Response('Not found', {
        status: 404,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
      });
    }
    const served = new Response(response.body, response);
    if (shared) served.headers.set('Access-Control-Allow-Origin', '*');
    if (/^\/bloom-character\/assets\/.*\.bin$/.test(pathname))
      served.headers.append('Vary', 'Accept-Encoding');
    // A hashed name's bytes never change, so a browser keeps them and never asks again. The asset
    // server's default (`max-age=0, must-revalidate`) made a returning visitor revalidate every
    // one: 31 requests for the character runtime alone.
    if (hashed && (response.status === 200 || response.status === 304)) {
      // Binary gzip/identity is negotiated by this Worker, not the CDN's MIME policy.
      const binary = /^\/bloom-character\/assets\/.*\.bin$/.test(pathname);
      served.headers.set('Cache-Control', binary ? `${IMMUTABLE}, no-transform` : IMMUTABLE);
    }
    return served;
  },
};
