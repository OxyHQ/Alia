const RUNTIME_PREFIX = '/bloom-character/';

/**
 * Paths whose file name carries a hash of its content, so a name is never reused for other bytes:
 * Bloom's character runtime (`assets/` and `chunks/` beside `runtime.mjs`, `name-<8 chars>.ext`,
 * as Vite names them) and Expo's web export (`/_expo/static/…-<32 hex>.js|css`,
 * `/assets/….<32 hex>.png`). Entry files — `index.html`, `runtime.mjs`, `manifest.json`,
 * `public/` — are not here and keep the asset server's revalidate-every-time default.
 */
const HASHED = [
  /^\/bloom-character\/(?:assets|chunks)\/[^/]+-[\w-]{8}\.[a-z0-9]+$/,
  /^\/_expo\/static\/.+-[0-9a-f]{32}\.[a-z0-9]+$/,
  /^\/assets\/.+\.[0-9a-f]{32}\.[a-z0-9]+$/,
];
const IMMUTABLE = 'public, max-age=31536000, immutable';

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const { pathname } = new URL(request.url);
    const runtime = pathname.startsWith(RUNTIME_PREFIX);
    const hashed = HASHED.some((pattern) => pattern.test(pathname));
    if (!runtime && !hashed) return response;
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
    // The 3D character runtime is shared: `@alia.onl/sdk` loads it from this origin in every
    // app that mounts the chat, and a cross-origin module import needs CORS to run at all.
    if (runtime) served.headers.set('Access-Control-Allow-Origin', '*');
    // A hashed name's bytes never change, so a browser keeps them and never asks again. The asset
    // server's default (`max-age=0, must-revalidate`) made a returning visitor revalidate every
    // one: 31 requests for the character runtime alone.
    if (hashed && (response.status === 200 || response.status === 304)) {
      served.headers.set('Cache-Control', IMMUTABLE);
    }
    return served;
  },
};
