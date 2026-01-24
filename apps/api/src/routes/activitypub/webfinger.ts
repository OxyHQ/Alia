/**
 * WebFinger endpoint
 * Enables discovery of ActivityPub actors via email-like handles
 * https://webfinger.net/
 */

import { Router } from 'express';
import { ACTIVITYPUB_DOMAIN, ACTOR_URI, ACTOR_URL } from '../../lib/activitypub/config.js';

const router = Router();

/**
 * GET /.well-known/webfinger?resource=acct:alia@alia.onl
 */
router.get('/', (req, res) => {
  const resource = req.query.resource as string;

  // Check if requesting Alia's account
  if (
    resource === `acct:alia@${ACTIVITYPUB_DOMAIN}` ||
    resource === ACTOR_URI ||
    resource === `alia@${ACTIVITYPUB_DOMAIN}`
  ) {
    res.setHeader('Content-Type', 'application/jrd+json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    return res.json({
      subject: `acct:alia@${ACTIVITYPUB_DOMAIN}`,
      aliases: [
        ACTOR_URI,
        ACTOR_URL
      ],
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: ACTOR_URI
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: ACTOR_URL
        }
      ]
    });
  }

  // Resource not found
  res.status(404).json({ error: 'Resource not found' });
});

export default router;
