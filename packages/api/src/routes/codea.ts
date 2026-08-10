import { Router, Request, Response } from 'express';
import { authenticateApiKey } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { getDb } from '../db/index.js';
import { findActiveSubscriptions } from '../db/billing/subscriptionRepository.js';
import { getRefreshedUserCredits } from '../lib/user-credits-helpers.js';
import DeveloperApiKey from '../models/developer-api-key.js';
import type { IDeveloperApp } from '../models/developer-app.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * Map subscription plan name to Alia plan type
 */
function mapPlanToAliaPlan(planName: string | undefined): string {
  if (!planName) return 'alia_free';

  const name = planName.toLowerCase();
  // Codea-specific plans
  if (name.includes('codea max')) return 'alia_max';
  if (name.includes('codea pro')) return 'alia_pro';
  // Alia plans
  if (name.includes('ultra')) return 'alia_ultra';
  if (name.includes('max')) return 'alia_max';
  if (name.includes('pro')) return 'alia_pro';
  if (name.includes('go')) return 'alia_go';
  return 'alia_free';
}

/**
 * GET /user - Returns entitlement data for Codea Studio Code
 *
 * This endpoint is called by Codea Studio Code's defaultAccount service
 * to determine the user's subscription status and available features.
 *
 * Authentication: API Key (alia_sk_*)
 */
router.get('/user', authenticateApiKey, apiKeyRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get all active subscriptions (user may have both Alia and Codea)
    const subscriptions = await findActiveSubscriptions(getDb(), userId);
    const subscription = subscriptions[0] || null;

    // Get user credits
    const userCredits = await getRefreshedUserCredits(userId);

    // Get API key info for username
    const apiKey = await DeveloperApiKey.findById(req.apiKey?.id).populate<{ appId: IDeveloperApp }>('appId');

    // Calculate quota information
    const totalCredits = userCredits.creditsFree + userCredits.creditsPaid;
    const resetDate = new Date();
    resetDate.setDate(resetDate.getDate() + 1); // Next day for daily refresh

    // Determine highest plan across all active subscriptions
    const planHierarchy = ['alia_free', 'alia_go', 'alia_pro', 'alia_max', 'alia_ultra'];
    let aliaPlan = 'alia_free';
    for (const sub of subscriptions) {
      const mapped = mapPlanToAliaPlan(sub.planSnapshotName);
      if (planHierarchy.indexOf(mapped) > planHierarchy.indexOf(aliaPlan)) {
        aliaPlan = mapped;
      }
    }

    // Build entitlement response with Alia-native fields only (no legacy compatibility payloads)
    const entitlementData = {
      alia_plan: aliaPlan,
      plan: aliaPlan.replace('alia_', ''),
      sku: aliaPlan,
      has_access: true,
      active: true,
      assigned_date: subscription?.createdAt?.toISOString() || new Date().toISOString(),

      quota_reset_date: subscription?.currentPeriodEnd?.toISOString(),
      quota_reset_date_utc: resetDate.toISOString(),
      quota_snapshots: {
        chat: {
          entitlement: totalCredits,
          overage_count: 0,
          overage_permitted: userCredits.creditsPaid > 0,
          percent_remaining: totalCredits > 0 ? 100 : 0,
          remaining: totalCredits,
          unlimited: false,
        },
        completions: {
          entitlement: totalCredits,
          overage_count: 0,
          overage_permitted: userCredits.creditsPaid > 0,
          percent_remaining: totalCredits > 0 ? 100 : 0,
          remaining: totalCredits,
          unlimited: false,
        },
        premium_interactions: {
          entitlement: userCredits.creditsPaid,
          overage_count: 0,
          overage_permitted: false,
          percent_remaining: userCredits.creditsPaid > 0 ? 100 : 0,
          remaining: userCredits.creditsPaid,
          unlimited: false,
        },
      },

      username: apiKey?.appId?.name || 'Alia User',
      email: undefined,
      name: 'Alia User',
    };

    res.json(entitlementData);
  } catch (error: unknown) {
    log.codea.error({ err: error }, 'Error fetching user entitlements');
    res.status(500).json({ error: 'Failed to fetch entitlements' });
  }
});

/**
 * GET /token - Returns token entitlement data
 *
 * This endpoint can be used for additional token-based features.
 */
router.get('/token', authenticateApiKey, apiKeyRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get user credits for token information
    const userCredits = await getRefreshedUserCredits(userId);

    res.json({
      valid: true,
      user_id: userId,
      credits: {
        free: userCredits.creditsFree,
        paid: userCredits.creditsPaid,
        total: userCredits.creditsFree + userCredits.creditsPaid,
      },
      features: {
        chat: true,
        completions: true,
        inline_suggestions: true,
        code_actions: true,
      },
    });
  } catch (error: unknown) {
    log.codea.error({ err: error }, 'Error fetching token info');
    res.status(500).json({ error: 'Failed to fetch token info' });
  }
});

/**
 * GET /mcp_registry - Returns MCP (Model Context Protocol) registry data
 *
 * This endpoint returns available MCP servers for Codea Studio Code.
 */
router.get('/mcp_registry', authenticateApiKey, apiKeyRateLimit, async (_req: Request, res: Response) => {
  try {
    // Return available MCP servers
    // This can be expanded to include user-specific or organization-specific servers
    res.json({
      servers: [],
      policies: {
        mcp: true,
        chat_preview_features_enabled: true,
        chat_agent_enabled: true,
        mcpAccess: 'allow_all',
      },
    });
  } catch (error: unknown) {
    log.codea.error({ err: error }, 'Error fetching MCP registry');
    res.status(500).json({ error: 'Failed to fetch MCP registry' });
  }
});

/**
 * GET /health - Health check for Codea endpoints
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'codea',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /me - Get current user info
 */
router.get('/me', authenticateApiKey, apiKeyRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get user credits
    const userCredits = await getRefreshedUserCredits(userId);

    // Get API key info
    const apiKey = await DeveloperApiKey.findById(req.apiKey?.id).populate<{ appId: IDeveloperApp }>('appId');

    res.json({
      id: userId,
      username: apiKey?.appId?.name || 'Alia User',
      credits: {
        free: userCredits.creditsFree,
        paid: userCredits.creditsPaid,
        total: userCredits.creditsFree + userCredits.creditsPaid,
      }
    });
  } catch (error: unknown) {
    log.codea.error({ err: error }, 'Error fetching user info');
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

/**
 * POST /resolve-model
 * Removed: direct provider resolution is internal-only.
 */
router.post('/resolve-model', authenticateApiKey, apiKeyRateLimit, async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Use /v1/chat/completions with Alia model IDs. Direct model resolution is internal-only.',
  });
});

/**
 * POST /report-usage
 * Removed: usage is tracked automatically by runtime.
 */
router.post('/report-usage', authenticateApiKey, apiKeyRateLimit, async (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Endpoint removed',
    message: 'Usage is tracked automatically by Alia runtime.',
  });
});

export default router;
