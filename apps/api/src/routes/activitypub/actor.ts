/**
 * Actor endpoint
 * Returns the Actor object for @alia
 */

import { Router } from 'express';
import { getPublicKey } from '../../lib/activitypub/signatures.js';
import {
  ACTIVITYPUB_DOMAIN,
  ACTOR_DOMAIN,
  ACTOR_URI,
  getKeyId,
  getInboxUri,
  getOutboxUri,
  getFollowersUri,
  getFollowingUri,
  ACTOR_URL
} from '../../lib/activitypub/config.js';

const router = Router();

/**
 * GET /actors/alia
 */
router.get('/', async (req, res) => {
  try {
    // Get public key from database
    const publicKey = await getPublicKey();

    // Return Actor object
    res.setHeader('Content-Type', 'application/activity+json; charset=utf-8');
    res.json({
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://w3id.org/security/v1',
      ],
      type: 'Person',
      id: ACTOR_URI,
      preferredUsername: 'alia',
      name: 'Alia AI',
      summary: 'AI assistant powered by advanced language models. Mention me to chat! Built with ActivityPub.',
      inbox: getInboxUri(),
      outbox: getOutboxUri(),
      followers: getFollowersUri(),
      following: getFollowingUri(),
      url: ACTOR_URL,
      manuallyApprovesFollowers: false,
      discoverable: true,
      published: '2026-01-24T00:00:00Z',
      publicKey: {
        id: getKeyId(),
        owner: ACTOR_URI,
        publicKeyPem: publicKey,
      },
      icon: {
        type: 'Image',
        mediaType: 'image/png',
        url: `https://${ACTIVITYPUB_DOMAIN}/alia-avatar.png`,
      },
      image: {
        type: 'Image',
        mediaType: 'image/png',
        url: `https://${ACTIVITYPUB_DOMAIN}/alia-header.png`,
      },
      attachment: [
        {
          type: 'PropertyValue',
          name: 'Website',
          value: `<a href="https://${ACTIVITYPUB_DOMAIN}" rel="me nofollow noopener noreferrer" target="_blank">https://${ACTIVITYPUB_DOMAIN}</a>`,
        },
        {
          type: 'PropertyValue',
          name: 'Model',
          value: 'alia-lite (Gemini Flash)',
        },
      ],
      tag: [],
    });
  } catch (error: any) {
    console.error('[Actor] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
