/**
 * ActivityPub Router
 * Main router for all ActivityPub endpoints
 */

import { Router } from 'express';
import express from 'express';
import actorRouter from './actor.js';
import inboxRouter from './inbox.js';
import outboxRouter from './outbox.js';
import followersRouter from './followers.js';
import webfingerRouter from './webfinger.js';
import { ACTIVITYPUB_DOMAIN, ACTOR_URI } from '../../lib/activitypub/config.js';

const router = Router();

// Middleware to parse JSON bodies for ActivityPub
router.use(express.json({ type: ['application/activity+json', 'application/ld+json', 'application/json'] }));

// WebFinger endpoint (for actor discovery)
router.use('/.well-known/webfinger', webfingerRouter);

// Actor endpoints
router.use('/actors/alia', actorRouter);
router.use('/actors/alia/inbox', inboxRouter);
router.use('/actors/alia/outbox', outboxRouter);
router.use('/actors/alia/followers', followersRouter);

// Following endpoint (empty for now, we don't follow anyone)
router.get('/actors/alia/following', (req, res) => {
  res.setHeader('Content-Type', 'application/activity+json; charset=utf-8');
  res.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'OrderedCollection',
    id: `${ACTOR_URI}/following`,
    totalItems: 0,
    orderedItems: [],
  });
});

// User profile page - redirect to profile on main site
router.get('/@alia', (req, res) => {
  res.redirect(301, `https://${ACTIVITYPUB_DOMAIN}/alia`);
});

// Health check
router.get('/activitypub/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ActivityPub Server',
    actor: '@alia@' + ACTIVITYPUB_DOMAIN,
    endpoints: {
      webfinger: `/.well-known/webfinger?resource=acct:alia@${ACTIVITYPUB_DOMAIN}`,
      actor: `${ACTOR_URI}`,
      inbox: `${ACTOR_URI}/inbox`,
      outbox: `${ACTOR_URI}/outbox`,
      followers: `${ACTOR_URI}/followers`,
    }
  });
});

export default router;
