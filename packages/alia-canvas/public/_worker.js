/**
 * Canvas is served on `canvas.alia.onl`. This stops the Cloudflare Pages
 * DEFAULT hostname from serving it too.
 *
 * Cloudflare always serves `<project>.pages.dev` and offers no way to switch it
 * off, so the URL cannot be deleted — but it does not have to answer with the
 * app. Anything arriving on it is redirected, permanently, to the same path on
 * the real domain. What was a second live copy of Canvas under a URL nobody
 * chose becomes a signpost to the one that was.
 *
 * `_worker.js` is Pages' ADVANCED mode: it takes over routing for the whole
 * project, and `_redirects` and `_headers` stop being applied. The SPA fallback
 * that `public/_redirects` provided (`/*  /index.html  200`) is therefore
 * re-implemented below rather than deleted — dropping it would 404 every deep
 * link, which is the trap this file has to avoid.
 *
 * The host test is EXACT, not a `.pages.dev` suffix match. Preview deployments
 * land on `<hash>.alia-canvas.pages.dev`, and bouncing those to production
 * would defeat the point of a preview.
 */

const PAGES_DEFAULT_HOST = 'alia-canvas.pages.dev';
const CANONICAL_HOST = 'canvas.alia.onl';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === PAGES_DEFAULT_HOST) {
      url.hostname = CANONICAL_HOST;
      // 301: this is not a temporary move, and a browser that caches it stops
      // asking. Path, query and hash are carried over untouched.
      return Response.redirect(url.toString(), 301);
    }

    const asset = await env.ASSETS.fetch(request);

    // The SPA fallback `_redirects` used to do, reproduced rather than
    // improved: `/*  /index.html  200` answered EVERY miss with the app shell,
    // including a missing asset, and so does this. Measured against
    // `wrangler pages dev` — `/assets/does-not-exist.js` returns the shell, not
    // a 404. That is a wart, but it is the wart that shipped, and a change in
    // routing behaviour does not belong in a change about retiring a hostname.
    if (asset.status === 404) {
      return env.ASSETS.fetch(new URL('/index.html', url.origin));
    }
    return asset;
  },
};
