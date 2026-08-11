import { Router } from 'express';
import { OxyServices } from '@oxyhq/core';
import { authenticateToken } from '../middleware/auth.js';
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import {
  findOwnedAppByName,
  findOwnedKeyByName,
  insertApiKey,
  insertApp,
  updateOwnedKey,
} from '../db/developers/developerRepository.js';
import { generateDeveloperApiKey, hashDeveloperApiKey } from '../lib/api-key-crypto.js';
import { log } from '../lib/logger.js';
import { getRedisClient } from '../lib/redis.js';

const router = Router();

const AUTH_CODE_PREFIX = 'pkce:';
const AUTH_CODE_TTL = 300; // 5 minutes

interface AuthCodeData {
  userId: string;
  codeChallenge: string;
  appId: string;
}

// In-memory fallback when Redis is unavailable (dev environments)
const memoryFallback = new Map<string, AuthCodeData & { expiresAt: number }>();

async function storeAuthCode(code: string, data: AuthCodeData): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(AUTH_CODE_PREFIX + code, JSON.stringify(data), 'EX', AUTH_CODE_TTL);
      return;
    } catch (err: unknown) {
      log.auth.warn({ err }, 'Redis storeAuthCode failed, using memory fallback');
    }
  }
  memoryFallback.set(code, { ...data, expiresAt: Date.now() + AUTH_CODE_TTL * 1000 });
}

/**
 * Atomically get and delete an auth code (one-time use).
 * Uses GETDEL on Redis to prevent TOCTOU race conditions.
 */
async function consumeAuthCode(code: string): Promise<AuthCodeData | null> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await redis.getdel(AUTH_CODE_PREFIX + code);
      return raw ? JSON.parse(raw) : null;
    } catch (err: unknown) {
      log.auth.warn({ err }, 'Redis consumeAuthCode failed, trying memory fallback');
    }
  }
  const entry = memoryFallback.get(code);
  memoryFallback.delete(code);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) return null;
  return { userId: entry.userId, codeChallenge: entry.codeChallenge, appId: entry.appId };
}

// Initialize Oxy client
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
const oxyClient = new OxyServices({
  baseURL: OXY_API_URL,
});

/**
 * GET /auth/me
 * Get current user from Oxy session
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Get full user data from Oxy
    const user = await oxyClient.getUserById(req.user.id);

    res.json({
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        name: user.name,
        avatar: user.avatar,
      },
    });
  } catch (error: unknown) {
    log.auth.error({ err: error }, 'Get user error');
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * POST /auth/logout
 * Logout - handled by Oxy on client side, this endpoint exists for compatibility
 */
router.post('/logout', authenticateToken, async (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

/**
 * POST /auth/authorize/codea
 * Authorize Alia Codea desktop app with PKCE
 * Returns an authorization code that can be exchanged for a token
 */
router.post('/authorize/codea', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { code_challenge, code_challenge_method } = req.body;

    // Validate PKCE parameters
    if (!code_challenge) {
      res.status(400).json({ error: 'code_challenge is required' });
      return;
    }

    if (code_challenge_method && code_challenge_method !== 'S256') {
      res.status(400).json({ error: 'Only S256 code_challenge_method is supported' });
      return;
    }

    const userId = req.user.id;
    const appName = 'Alia Codea';

    // Find or create the Alia Codea app for this user
    let app = await findOwnedAppByName(getDb(), userId, appName);

    if (!app) {
      app = await insertApp(getDb(), {
        oxyUserId: userId,
        name: appName,
        description: 'Alia Codea desktop application',
        isActive: true,
      });
    }

    // Generate authorization code
    const authCode = crypto.randomBytes(32).toString('base64url');

    // Store the code with challenge in Redis (TTL-based expiry)
    await storeAuthCode(authCode, {
      userId,
      codeChallenge: code_challenge,
      appId: app.id.toString(),
    });

    res.json({
      code: authCode,
      appId: app.id,
    });
  } catch (error: unknown) {
    log.auth.error({ err: error }, 'Authorize Codea error');
    res.status(500).json({ error: 'Failed to authorize' });
  }
});

/**
 * POST /auth/authorize/cowork
 * Authorize Alia Cowork desktop app with PKCE
 * Returns an authorization code that can be exchanged for a token
 */
router.post('/authorize/cowork', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { code_challenge, code_challenge_method } = req.body;

    // Validate PKCE parameters
    if (!code_challenge) {
      res.status(400).json({ error: 'code_challenge is required' });
      return;
    }

    if (code_challenge_method && code_challenge_method !== 'S256') {
      res.status(400).json({ error: 'Only S256 code_challenge_method is supported' });
      return;
    }

    const userId = req.user.id;
    const appName = 'Alia Cowork';

    // Find or create the Alia Cowork app for this user
    let app = await findOwnedAppByName(getDb(), userId, appName);

    if (!app) {
      app = await insertApp(getDb(), {
        oxyUserId: userId,
        name: appName,
        description: 'Alia Cowork desktop application',
        isActive: true,
      });
    }

    // Generate authorization code
    const authCode = crypto.randomBytes(32).toString('base64url');

    // Store the code with challenge in Redis (TTL-based expiry)
    await storeAuthCode(authCode, {
      userId,
      codeChallenge: code_challenge,
      appId: app.id.toString(),
    });

    res.json({
      code: authCode,
      appId: app.id,
    });
  } catch (error: unknown) {
    log.auth.error({ err: error }, 'Authorize Cowork error');
    res.status(500).json({ error: 'Failed to authorize' });
  }
});

/**
 * POST /auth/token
 * Exchange authorization code for token using PKCE
 */
router.post('/token', async (req, res) => {
  try {
    const { grant_type, code, code_verifier, client_id } = req.body;

    // Validate request
    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'Invalid grant_type' });
      return;
    }

    if (!code || !code_verifier) {
      res.status(400).json({ error: 'code and code_verifier are required' });
      return;
    }

    // Accept both codea and cowork as valid client IDs
    if (client_id !== 'codea' && client_id !== 'cowork') {
      res.status(400).json({ error: 'Invalid client_id' });
      return;
    }

    // Atomically get and delete authorization code (one-time use)
    const authData = await consumeAuthCode(code);
    if (!authData) {
      res.status(400).json({ error: 'Invalid or expired authorization code' });
      return;
    }

    // Verify PKCE challenge
    const computedChallenge = crypto
      .createHash('sha256')
      .update(code_verifier)
      .digest('base64url');

    if (computedChallenge !== authData.codeChallenge) {
      res.status(400).json({ error: 'Invalid code_verifier' });
      return;
    }

    // Now create or regenerate the API key
    const userId = authData.userId;
    const appId = authData.appId;

    // Find existing active API key or create a new one
    const keyName = 'Alia Cowork Key';
    let apiKey = await findOwnedKeyByName(getDb(), appId, userId, keyName);

    const plainKey = generateDeveloperApiKey();
    const keyHash = hashDeveloperApiKey(plainKey);
    const keyPrefix = plainKey.substring(0, 16);

    if (apiKey) {
      /**
       * Regenerate the key: the user is re-authorizing, so the old credential
       * stops working. `lastUsedAt` goes back to null because this is a
       * different key wearing the same row.
       *
       * The lookup is by NAME within the app rather than by `isActive: true`, so
       * re-authorizing after a revocation reuses the row instead of leaving a
       * dead one behind and colliding on nothing. An inactive key is reactivated
       * here, which is what re-authorization means.
       */
      apiKey =
        (await updateOwnedKey(getDb(), apiKey.id, appId, userId, {
          keyHash,
          keyPrefix,
          lastUsedAt: null,
          isActive: true,
        })) ?? apiKey;
    } else {
      apiKey = await insertApiKey(getDb(), {
        oxyUserId: userId,
        appId: appId,
        name: keyName,
        keyHash,
        keyPrefix,
        scopes: ['chat:read', 'chat:write', 'models:read'],
        isActive: true,
      });
    }

    res.json({
      token: plainKey,
      token_type: 'Bearer',
    });
  } catch (error: unknown) {
    log.auth.error({ err: error }, 'Token exchange error');
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

export default router;
