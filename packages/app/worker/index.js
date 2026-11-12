/**
 * Files `@alia.onl/sdk` loads from this origin in every app that embeds it: the voice call's
 * worklets (`/sdk/voice-worklets/<revision>.js`). A cross-origin `audioWorklet.addModule` needs
 * CORS to run at all.
 */
const SHARED_PREFIXES = ['/sdk/'];

/**
 * Paths whose file name carries a hash of its content, so a name is never reused for other bytes:
 * the SDK's voice worklets (`<16 hex>.js`, committed and append-only, see
 * `scripts/stamp-voice-worklets.mjs`) and Expo's web export (`/_expo/static/…-<32 hex>.js|css`,
 * `/assets/….<32 hex>.png`). Entry files — `index.html`, `public/` — are not here and keep the
 * asset server's revalidate-every-time default.
 */
const HASHED = [
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

/**
 * Where the gemies live (Gemies ADR 0034). alia.onl was once the agents' home too: a gemie's thread
 * (`/@pepe`), its page and editor (`/@pepe/details`, `/@pepe/edit`) and the catalogue
 * (`/agents`, `/agents/…`). This app is Alia's alone now, so those addresses — in every link copied
 * from them — move permanently to the same path on Gemies, rather than ending on a page that is
 * not here.
 */
const GEMIES_ORIGIN = 'https://gemies.ai';
const GEMIES_PATH = /^\/(?:@|agents(?:\/|$))/;

/** The same address on Gemies, path and query as they were typed. */
function toGemies(request) {
  const { pathname, search } = new URL(request.url);
  return Response.redirect(`${GEMIES_ORIGIN}${pathname}${search}`, 301);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const isDocumentRequest = request.method === 'GET' || request.method === 'HEAD';
    if (isDocumentRequest && GEMIES_PATH.test(pathname)) return toGemies(request);
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
    // A hashed name's bytes never change, so a browser keeps them and never asks again. The asset
    // server's default (`max-age=0, must-revalidate`) made a returning visitor revalidate every
    // one.
    if (hashed && (response.status === 200 || response.status === 304)) {
      served.headers.set('Cache-Control', IMMUTABLE);
    }
    return served;
  },
};
