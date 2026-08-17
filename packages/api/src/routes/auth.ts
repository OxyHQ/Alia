/**
 * `/auth` — the session endpoints, plus the desktop authorization flow that used
 * to mint `alia_sk_*` credentials and no longer does.
 *
 * ## The second minting path
 *
 * `docs/developers-portal.md` describes `POST /developer/apps/:appId/keys` as
 * the way an `alia_sk_*` key comes into existence. It was not the only one: this
 * router held a complete PKCE exchange that created an Alia developer
 * APPLICATION per user on `/authorize/codea` and `/authorize/cowork`, then minted
 * — or silently REPLACED the secret of — a key on `/token`, for any caller able
 * to complete the challenge. Two of the checkboxes in #139 workstream 11 are
 * unreachable while it exists, so it is closed here alongside the documented one.
 *
 * ## What that costs, stated plainly
 *
 * `packages/alia-cowork/src/main/auth.ts:213` and
 * `packages/alia-codea-cli/src/commands/auth.ts:78` still call `POST /auth/token`
 * to sign in. They now receive `410` and cannot obtain a NEW credential; every
 * credential they already hold keeps authenticating for the whole compatibility
 * window, so a signed-in installation is unaffected. The replacement is not
 * speculative — `packages/alia-codea/src/authProvider.ts:618` already
 * authenticates against Oxy's own `/auth/oauth/token`, so the VS Code extension
 * has made this move and the other two clients follow it.
 */

import { Router } from 'express';
import { OxyServices } from '@oxyhq/core';
import { authenticateToken } from '../middleware/auth.js';
import { refuseIssuance } from '../middleware/credential-deprecation.js';
import { log } from '../lib/logger.js';

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
 * The desktop authorization flow: CLOSED.
 *
 * `/authorize/*` registered an Alia developer application and `/token` minted
 * the `alia_sk_*` credential the application held. Both are Oxy's under ADR 0001,
 * so both refuse. The routes keep their shape because the shipped clients above
 * cannot be updated in place, and a refusal that names the replacement is the
 * only thing they can act on; a deleted route would answer `404` and read as an
 * outage.
 *
 * `authenticateToken` is gone from the two `/authorize/*` routes with the work
 * they used to do. Requiring a session to be told that a capability no longer
 * exists withholds the instruction from exactly the caller who is stuck — a CLI
 * whose stored credential has lapsed cannot authenticate, and would have got a
 * `401` with nothing in it.
 */
router.post('/authorize/codea', (_req, res) => {
  refuseIssuance(res, 'developer_application');
});

router.post('/authorize/cowork', (_req, res) => {
  refuseIssuance(res, 'developer_application');
});

/**
 * POST /auth/token — the credential mint. CLOSED.
 *
 * It refuses before reading the request, so no authorization code is consumed
 * and no PKCE challenge is verified: there is no path through this handler that
 * reaches a write, which is why the store, the challenge check and the fallback
 * map were deleted rather than left behind an early return.
 *
 * The `subject` is `developer_api_key` rather than the application: this route
 * both created a key and REPLACED the secret of an existing one, and replacing a
 * secret issues a new credential just as surely as inserting a row does. That is
 * the reason `DeveloperApiKeyUpdate` no longer admits `keyHash` — see
 * `db/developers/developerRepository.ts`.
 */
router.post('/token', (_req, res) => {
  refuseIssuance(res, 'developer_api_key');
});

export default router;
