/**
 * Inbox endpoint
 * Receives incoming ActivityPub activities
 */

import { Router } from 'express';
import { fetchActor } from '../../lib/activitypub/fetcher.js';
import { verifySignature, verifyDigest } from '../../lib/activitypub/signatures.js';
import { processActivity } from '../../lib/activitypub/processor.js';

const router = Router();

/**
 * POST /actors/alia/inbox
 */
router.post('/', async (req, res) => {
  try {
    const activity = req.body;

    // Validate activity
    if (!activity || !activity.type || !activity.actor) {
      console.error('[Inbox] Invalid activity: missing required fields');
      res.status(400).json({ error: 'Invalid activity' });
      return;
    }

    console.log(`[Inbox] Received ${activity.type} activity from ${activity.actor}`);

    // Fetch the actor to get their public key
    const actor = await fetchActor(activity.actor);
    if (!actor || !actor.publicKey) {
      console.error('[Inbox] Failed to fetch actor or missing public key');
      res.status(401).json({ error: 'Cannot verify signature' });
      return;
    }

    // Verify HTTP signature
    const signatureValid = verifySignature(req, actor.publicKey.publicKeyPem);
    if (!signatureValid) {
      console.error('[Inbox] Invalid HTTP signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Verify digest if present
    const digestValid = verifyDigest(req, req.body);
    if (!digestValid) {
      console.error('[Inbox] Invalid digest');
      res.status(400).json({ error: 'Invalid digest' });
      return;
    }

    console.log('[Inbox] Signature verified successfully');

    // Return 202 Accepted immediately (process in background)
    res.status(202).send();

    // Process activity asynchronously
    setImmediate(async () => {
      try {
        await processActivity(activity);
      } catch (error) {
        console.error('[Inbox] Error processing activity in background:', error);
      }
    });
  } catch (error: any) {
    console.error('[Inbox] Error:', error);

    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

/**
 * GET /actors/alia/inbox
 * Not required by spec, but some servers request it
 */
router.get('/', (req, res) => {
  res.status(405).json({ error: 'GET not supported on inbox' });
});

export default router;
