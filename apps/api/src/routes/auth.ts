import { Router } from 'express';
import { OxyServices } from '@oxyhq/services/core';
import { authenticateToken } from '../middleware/auth.js';
import DeveloperApp from '../models/developer-app.js';
import DeveloperApiKey from '../models/developer-api-key.js';

const router = Router();

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
 * Authorize Alia Cowork desktop app
 * Creates or retrieves an API key for the user
 */
router.post('/authorize/codea', authenticateToken, async (req, res) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
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

    // Find existing active API key or create a new one
    let apiKey = await DeveloperApiKey.findOne({
      oxyUserId: userId,
      appId: app._id,
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
      apiKey.lastUsed = undefined;
      await apiKey.save();
    } else {
      // Create new API key
      plainKey = (DeveloperApiKey as any).generateKey();
      const keyHash = (DeveloperApiKey as any).hashKey(plainKey);
      const keyPrefix = plainKey.substring(0, 16);

      apiKey = await DeveloperApiKey.create({
        oxyUserId: userId,
        appId: app._id,
        name: 'Alia Cowork Key',
        keyHash,
        keyPrefix,
        scopes: ['chat:read', 'chat:write', 'models:read'],
        isActive: true,
      });
    }

    res.json({
      token: plainKey,
      appId: app._id,
    });
  } catch (error) {
    console.error('Authorize Codea error:', error);
    res.status(500).json({ error: 'Failed to authorize' });
  }
});

export default router;
