/**
 * Playing a stored clip, for a media element that can present no credential.
 *
 * ## Why this route is outside the authenticated block
 *
 * `routes/v1.ts` applies `authenticateTokenOrApiKey` to everything after it,
 * and this is mounted BEFORE that on purpose. A browser's `<audio src>` sends
 * no `Authorization` header and Alia is cookie-less, so a media element cannot
 * satisfy that middleware — an authenticated route here would be a route
 * nothing can play.
 *
 * Unauthenticated does not mean unauthorised: the query IS the authorisation.
 * It is a signed capability for ONE object, minted for one user, expiring in
 * minutes — see `lib/audio-playback-link.ts` for what that trade actually
 * costs.
 *
 * ## What it deliberately does not do
 *
 * It does not take a key from the caller. The key travels inside the signed
 * payload, so a caller cannot ask for a different object by editing the URL —
 * which is the whole reason the object key is not simply a path parameter.
 */

import { Router, type Request, type Response } from 'express';

import { verifyPlaybackQuery } from '../../lib/audio-playback-link.js';
import { readS3Object } from '../../lib/s3.js';
import { log } from '../../lib/logger.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const verdict = verifyPlaybackQuery(req.query as Record<string, unknown>);
  if (verdict.kind === 'expired') {
    // Distinct from a forgery: the client should ask for a fresh link rather
    // than report a permissions failure to the user.
    return res.status(410).json({ error: { message: 'This playback link has expired', type: 'expired' } });
  }
  if (verdict.kind === 'invalid') {
    return res.status(403).json({ error: { message: 'This playback link is not valid', type: 'forbidden' } });
  }

  const object = await readS3Object(verdict.fields.key);
  if (object === null) {
    return res.status(404).json({ error: { message: 'The clip is no longer stored', type: 'not_found' } });
  }

  res.setHeader('Content-Type', object.contentType);
  if (object.contentLength !== undefined) res.setHeader('Content-Length', String(object.contentLength));
  // Cacheable by the browser for as long as the link itself lives, and PRIVATE:
  // a shared cache holding a capability-addressed clip would serve it to
  // whoever asked next.
  res.setHeader('Cache-Control', 'private, max-age=900');

  object.body.on('error', (err: unknown) => {
    log.general.warn({ err, key: verdict.fields.key }, 'Playback stream failed mid-flight');
    // Headers are already sent by then, so destroying the socket is the only
    // honest end: a truncated body that ends cleanly reads as a complete clip.
    res.destroy();
  });
  return object.body.pipe(res);
});

export default router;
