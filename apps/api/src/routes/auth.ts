import { Router } from 'express';
import { OxyServices } from '@oxyhq/core';
import { authenticateToken } from '../middleware/auth.js';
import DeveloperApp from '../models/developer-app.js';
import DeveloperApiKey from '../models/developer-api-key.js';
import crypto from 'crypto';

const router = Router();

// In-memory store for PKCE authorization codes (in production, use Redis or similar)
// Map of code -> { userId, codeChallenge, appId, expiresAt }
const authorizationCodes = new Map<
  string,
  { userId: string; codeChallenge: string; appId: string; expiresAt: number }
>();

// Clean up expired codes periodically
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authorizationCodes) {
    if (data.expiresAt < now) {
      authorizationCodes.delete(code);
    }
  }
}, 60000); // Clean every minute

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
  } catch (error) {
    console.error('Get user error:', error);
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
    let app = await DeveloperApp.findOne({
      oxyUserId: userId,
      name: appName,
    });

    if (!app) {
      app = await DeveloperApp.create({
        oxyUserId: userId,
        name: appName,
        description: 'Alia Codea desktop application',
        isActive: true,
      });
    }

    // Generate authorization code
    const authCode = crypto.randomBytes(32).toString('base64url');

    // Store the code with challenge (expires in 5 minutes)
    authorizationCodes.set(authCode, {
      userId,
      codeChallenge: code_challenge,
      appId: app._id.toString(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    res.json({
      code: authCode,
      appId: app._id,
    });
  } catch (error) {
    console.error('Authorize Codea error:', error);
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
    let app = await DeveloperApp.findOne({
      oxyUserId: userId,
      name: appName,
    });

    if (!app) {
      app = await DeveloperApp.create({
        oxyUserId: userId,
        name: appName,
        description: 'Alia Cowork desktop application',
        isActive: true,
      });
    }

    // Generate authorization code
    const authCode = crypto.randomBytes(32).toString('base64url');

    // Store the code with challenge (expires in 5 minutes)
    authorizationCodes.set(authCode, {
      userId,
      codeChallenge: code_challenge,
      appId: app._id.toString(),
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    res.json({
      code: authCode,
      appId: app._id,
    });
  } catch (error) {
    console.error('Authorize Cowork error:', error);
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

    // Get and validate authorization code
    const authData = authorizationCodes.get(code);
    if (!authData) {
      res.status(400).json({ error: 'Invalid or expired authorization code' });
      return;
    }

    // Check expiration
    if (authData.expiresAt < Date.now()) {
      authorizationCodes.delete(code);
      res.status(400).json({ error: 'Authorization code has expired' });
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

    // Code is valid, delete it (one-time use)
    authorizationCodes.delete(code);

    // Now create or regenerate the API key
    const userId = authData.userId;
    const appId = authData.appId;

    // Find existing active API key or create a new one
    let apiKey = await DeveloperApiKey.findOne({
      oxyUserId: userId,
      appId: appId,
      isActive: true,
    });

    let plainKey: string;

    if (apiKey) {
      // Regenerate key for security (user is re-authorizing)
      plainKey = (DeveloperApiKey as any).generateKey();
      const keyHash = (DeveloperApiKey as any).hashKey(plainKey);
      const keyPrefix = plainKey.substring(0, 16);

      apiKey.keyHash = keyHash;
      apiKey.keyPrefix = keyPrefix;
      apiKey.lastUsedAt = undefined;
      await apiKey.save();
    } else {
      // Create new API key
      plainKey = (DeveloperApiKey as any).generateKey();
      const keyHash = (DeveloperApiKey as any).hashKey(plainKey);
      const keyPrefix = plainKey.substring(0, 16);

      apiKey = await DeveloperApiKey.create({
        oxyUserId: userId,
        appId: appId,
        name: 'Alia Cowork Key',
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
  } catch (error) {
    console.error('Token exchange error:', error);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

export default router;
