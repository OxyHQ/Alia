/**
 * `GET /favicons/:domain` — the icon of a site an answer cited, served from
 * Alia's own origin.
 *
 * ## Why it takes no credential
 *
 * An `<img>` sends no `Authorization` header and Alia is cookie-less, so behind
 * the auth middleware this is a route that renders nothing — the same
 * constraint `routes/media.ts` documents for playback. Media answers it with a
 * signed capability because the object is one user's private clip. A favicon is
 * a public file that anyone can already fetch from the site itself, so there is
 * nothing here to authorise; what the route has to bound instead is what an
 * anonymous caller can make Alia DO, which is what the guards and the ceiling
 * in `lib/favicon.ts` are for.
 *
 * ## What the three answers mean to the caller
 *
 * The app draws its own mark whenever no icon arrives, so every failure has to
 * be a clean HTTP failure and never a body a client would try to decode:
 *
 *  - **404** — no icon, or the site's is unusable. Cacheable: without that, a
 *    domain with no favicon is a request on every render of every message.
 *  - **400** — the domain is not one Alia will fetch. Also cacheable, because
 *    the answer is a property of the string and will not change.
 *  - **503** — too many domains in flight. `no-store`, because it is a
 *    statement about this second and the next request should try again.
 */

import { Router, type Request, type Response } from 'express';

import { getFavicon } from '../lib/favicon.js';

const router = Router();

/** A week for an icon: sites change them rarely, and a stale one is harmless. */
const ICON_CACHE_SECONDS = 7 * 24 * 60 * 60;
/** Six hours for "no icon", matching the negative entry the resolver keeps. */
const MISS_CACHE_SECONDS = 6 * 60 * 60;
/** An hour for a refusal, which only re-asks after a deploy or a cache purge. */
const REFUSED_CACHE_SECONDS = 60 * 60;

router.get('/:domain', async (req: Request, res: Response) => {
  // `String` because express types a path parameter as `string | string[]`;
  // the array spelling cannot reach a single-segment route, and if it ever
  // did it would fail the hostname check rather than be fetched.
  const result = await getFavicon(String(req.params.domain));

  if (result.kind === 'refused') {
    res.setHeader('Cache-Control', `public, max-age=${REFUSED_CACHE_SECONDS}`);
    return res.status(400).json({ error: { message: result.reason, type: 'invalid_request' } });
  }

  if (result.kind === 'busy') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: { message: 'Too many icons are being fetched', type: 'busy' } });
  }

  if (result.kind === 'none') {
    res.setHeader('Cache-Control', `public, max-age=${MISS_CACHE_SECONDS}`);
    return res.status(404).json({ error: { message: 'That site has no icon Alia can serve', type: 'not_found' } });
  }

  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Cache-Control', `public, max-age=${ICON_CACHE_SECONDS}`);
  // The bytes come from a site Alia does not control, so they are served as an
  // inert image and nothing else: `nosniff` keeps a browser from re-deciding
  // the type it was given, and the policy stops an SVG — the one icon format
  // that is a document — from executing anything on Alia's origin.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.send(result.body);
});

export default router;
