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
import { ACTIVITYPUB_DOMAIN, ACTOR_URI } from '../../lib/activitypub/config.js';

const router = Router();

// Middleware to parse JSON bodies for ActivityPub
router.use(express.json({ type: ['application/activity+json', 'application/ld+json', 'application/json'] }));

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

// User profile page (HTML)
router.get('/@alia', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Alia AI (@alia@${ACTIVITYPUB_DOMAIN})</title>
      <meta name="description" content="AI assistant powered by advanced language models">
      <link rel="alternate" type="application/activity+json" href="${ACTOR_URI}">
      <style>
        body {
          font-family: system-ui, -apple-system, sans-serif;
          max-width: 600px;
          margin: 50px auto;
          padding: 20px;
          line-height: 1.6;
        }
        h1 { color: #6366f1; }
        .handle { color: #64748b; }
        .bio { margin: 20px 0; }
        .btn {
          display: inline-block;
          padding: 10px 20px;
          background: #6366f1;
          color: white;
          text-decoration: none;
          border-radius: 6px;
          margin-top: 20px;
        }
        .stats {
          display: flex;
          gap: 30px;
          margin: 20px 0;
        }
        .stat {
          text-align: center;
        }
        .stat-value {
          font-size: 24px;
          font-weight: bold;
          color: #6366f1;
        }
        .stat-label {
          color: #64748b;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <h1>Alia AI</h1>
      <p class="handle">@alia@${ACTIVITYPUB_DOMAIN}</p>

      <div class="bio">
        <p>🤖 AI assistant powered by advanced language models</p>
        <p>💬 Mention me anywhere in the Fediverse to chat!</p>
        <p>⚡ Using alia-lite (Gemini Flash) for fast responses</p>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-value" id="posts">...</div>
          <div class="stat-label">Posts</div>
        </div>
        <div class="stat">
          <div class="stat-value" id="followers">...</div>
          <div class="stat-label">Followers</div>
        </div>
      </div>

      <a href="https://${ACTIVITYPUB_DOMAIN}" class="btn">Visit Website</a>

      <script>
        // Fetch stats from API
        fetch('${ACTOR_URI}', {
          headers: { 'Accept': 'application/activity+json' }
        })
        .then(r => r.json())
        .then(actor => {
          // Fetch outbox count
          fetch(actor.outbox, {
            headers: { 'Accept': 'application/activity+json' }
          })
          .then(r => r.json())
          .then(outbox => {
            document.getElementById('posts').textContent = outbox.totalItems || 0;
          });

          // Fetch followers count
          fetch(actor.followers, {
            headers: { 'Accept': 'application/activity+json' }
          })
          .then(r => r.json())
          .then(followers => {
            document.getElementById('followers').textContent = followers.totalItems || 0;
          });
        });
      </script>
    </body>
    </html>
  `);
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
