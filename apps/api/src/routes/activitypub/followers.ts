/**
 * Followers endpoint
 * Returns a collection of followers
 */

import { Router } from 'express';
import { ActivityPubFollower } from '../../models/activitypub-follower.js';
import { ACTOR_URI } from '../../lib/activitypub/config.js';

const router = Router();

/**
 * GET /actors/alia/followers
 * Returns an OrderedCollection of followers
 */
router.get('/', async (req, res) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string) : null;

    // If no page requested, return collection summary
    if (page === null) {
      const totalItems = await ActivityPubFollower.countDocuments({ status: 'accepted' });

      res.setHeader('Content-Type', 'application/activity+json; charset=utf-8');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'OrderedCollection',
        id: `${ACTOR_URI}/followers`,
        totalItems,
        first: `${ACTOR_URI}/followers?page=1`,
      });
      return;
    }

    // Return paginated followers
    const limit = 50;
    const skip = (page - 1) * limit;

    const followers = await ActivityPubFollower.find({ status: 'accepted' })
      .sort({ followedAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalItems = await ActivityPubFollower.countDocuments({ status: 'accepted' });
    const hasMore = skip + followers.length < totalItems;

    const orderedItems = followers.map(f => f.actorUri);

    res.setHeader('Content-Type', 'application/activity+json; charset=utf-8');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'OrderedCollectionPage',
      id: `${ACTOR_URI}/followers?page=${page}`,
      partOf: `${ACTOR_URI}/followers`,
      orderedItems,
      ...(hasMore ? { next: `${ACTOR_URI}/followers?page=${page + 1}` } : {}),
    });
  } catch (error: any) {
    console.error('[Followers] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
