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
 * A path the asset server canonicalises: it answers `/@pepe` with a 307 to `/%40pepe`, because `@` is
 * a reserved character and it writes every path in its encoded form. An agent's thread is `/@pepe`
 * (a person's profile too), so every visit to one began with that redirect and left `%40` in the
 * address bar, in every link copied from it. Those paths are the app's own routes, not files.
 */
const APP_ROUTE_WITH_RESERVED_CHARACTER = /^\/@/;

/**
 * The app shell for a route the asset server would redirect: its `/` document, answered under the
 * request's own URL. Same bytes `not_found_handling` serves for every other client-side route, so
 * the router reads the path exactly as it was typed. The asset server is never asked for the
 * `@` path, which is how Mention avoids this too: its shell is served by its backend and the CDN
 * is only asked for the document, never for the route.
 */
async function appShell(request, env) {
  const url = new URL(request.url);
  const shell = await env.ASSETS.fetch(new Request(new URL('/', url), request));
  return new Response(shell.body, shell);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const isDocumentRequest = request.method === 'GET' || request.method === 'HEAD';
    const response =
      isDocumentRequest && APP_ROUTE_WITH_RESERVED_CHARACTER.test(pathname)
        ? await appShell(request, env)
        : await env.ASSETS.fetch(request);
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
