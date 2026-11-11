/**
 * `/auth` — the session endpoints.
 *
 * The desktop authorization flow that used to live here (`POST /auth/token`)
 * minted `alia_sk_*` developer credentials. It answered `410 Gone` after
 * issuance closed, and was removed outright with the keys themselves: clients
 * sign in with Oxy.
 */

import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { log } from '../lib/logger.js';
import { oxy } from '../lib/oxy.js';

const router = Router();

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
    const user = await oxy.users.get(req.user.id);

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

export default router;
