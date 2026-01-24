/**
 * Outbox endpoint
 * Returns a collection of published posts
 */

import { Router } from 'express';
import { ActivityPubPost } from '../../models/activitypub-post.js';
import { ACTOR_URI } from '../../lib/activitypub/config.js';

const router = Router();

/**
 * GET /actors/alia/outbox
 * Returns an OrderedCollection of posts
 */
router.get('/', async (req, res) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string) : null;

    // If no page requested, return collection summary
    if (page === null) {
      const totalItems = await ActivityPubPost.countDocuments();

      res.setHeader('Content-Type', 'application/activity+json; charset=utf-8');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'OrderedCollection',
        id: `${ACTOR_URI}/outbox`,
        totalItems,
        first: `${ACTOR_URI}/outbox?page=1`,
      });
      return;
    }

    // Return paginated posts
    const limit = 20;
    const skip = (page - 1) * limit;

    const posts = await ActivityPubPost.find()
      .sort({ published: -1 })
      .skip(skip)
      .limit(limit);

    const totalItems = await ActivityPubPost.countDocuments();
    const hasMore = skip + posts.length < totalItems;

    // Convert posts to Create activities
    const orderedItems = posts.map(post => ({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${post.postId}/activity`,
      type: 'Create',
      actor: ACTOR_URI,
      published: post.published.toISOString(),
      to: post.to,
      cc: post.cc,
      object: {
        id: post.postId,
        type: 'Note',
        attributedTo: ACTOR_URI,
        content: post.content,
        published: post.published.toISOString(),
        to: post.to,
        cc: post.cc,
        ...(post.inReplyTo ? { inReplyTo: post.inReplyTo } : {}),
      },
    }));

    res.setHeader('Content-Type', 'application/activity+json; charset=utf-8');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'OrderedCollectionPage',
      id: `${ACTOR_URI}/outbox?page=${page}`,
      partOf: `${ACTOR_URI}/outbox`,
      orderedItems,
      ...(hasMore ? { next: `${ACTOR_URI}/outbox?page=${page + 1}` } : {}),
    });
  } catch (error: any) {
    console.error('[Outbox] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
