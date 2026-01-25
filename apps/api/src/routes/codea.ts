import { Router, Request, Response } from 'express';
import { authenticateApiKey } from '../middleware/auth.js';
import { Subscription } from '../models/subscription.js';
import { UserCredits } from '../models/user-credits.js';
import DeveloperApiKey from '../models/developer-api-key.js';

const router = Router();

/**
 * Map subscription plan name to Alia plan type
 */
function mapPlanToAliaPlan(planName: string | undefined): string {
  if (!planName) return 'free';

  const name = planName.toLowerCase();
  if (name.includes('enterprise')) return 'alia_enterprise';
  if (name.includes('business')) return 'alia_business';
  if (name.includes('pro+') || name.includes('pro plus') || name.includes('proplus')) return 'alia_pro_plus';
  if (name.includes('pro')) return 'alia_pro';
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
router.get('/user', authenticateApiKey, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get subscription status
    const subscription = await Subscription.findOne({
      oxyUserId: userId,
      status: { $in: ['active', 'trialing'] }
    }).sort({ createdAt: -1 });

    // Get user credits
    let userCredits = await UserCredits.findById(userId);
    if (!userCredits) {
      // Create default credits for new user
      userCredits = await UserCredits.create({
        _id: userId,
        credits: {
          free: 1000,
          freeLimit: 1000,
          dailyRefresh: 300,
          lastRefresh: new Date(),
          paid: 0,
        }
      });
    }

    // Refresh credits if needed
    await userCredits.refreshCreditsIfNeeded();

    // Get API key info for username
    const apiKey = await DeveloperApiKey.findById(req.apiKey?.id).populate('appId');

    // Calculate quota information
    const totalCredits = userCredits.credits.free + userCredits.credits.paid;
    const resetDate = new Date();
    resetDate.setDate(resetDate.getDate() + 1); // Next day for daily refresh

    // Determine plan type
    const hasActiveSubscription = !!subscription;
    const planName = subscription?.plan?.name;
    const aliaPlan = mapPlanToAliaPlan(planName);

    // Build entitlement response in the format Codea Studio Code expects
    const entitlementData = {
      // Alia-specific fields (primary)
      alia_plan: aliaPlan,
      plan: aliaPlan.replace('alia_', ''),
      sku: aliaPlan,
      has_access: true, // User has API key, so they have access
      active: true,

      // GitHub Copilot-compatible fields (for backwards compatibility)
      access_type_sku: hasActiveSubscription ? aliaPlan : 'alia_free',
      copilot_plan: aliaPlan.replace('alia_', ''),
      can_signup_for_limited: !hasActiveSubscription,
      assigned_date: subscription?.createdAt?.toISOString() || new Date().toISOString(),
      organization_login_list: [],
      analytics_tracking_id: userId,

      // Quota information
      quota_reset_date: subscription?.currentPeriodEnd?.toISOString(),
      quota_reset_date_utc: resetDate.toISOString(),
      limited_user_reset_date: resetDate.toISOString(),

      // Legacy quota format
      limited_user_quotas: {
        chat: userCredits.credits.free,
        completions: userCredits.credits.free,
      },
      monthly_quotas: {
        chat: userCredits.credits.freeLimit + (subscription?.plan?.creditsPerMonth || 0),
        completions: userCredits.credits.freeLimit + (subscription?.plan?.creditsPerMonth || 0),
      },

      // New quota snapshot format
      quota_snapshots: {
        chat: {
          entitlement: totalCredits,
          overage_count: 0,
          overage_permitted: userCredits.credits.paid > 0,
          percent_remaining: totalCredits > 0 ? 100 : 0,
          remaining: totalCredits,
          unlimited: false,
        },
        completions: {
          entitlement: totalCredits,
          overage_count: 0,
          overage_permitted: userCredits.credits.paid > 0,
          percent_remaining: totalCredits > 0 ? 100 : 0,
          remaining: totalCredits,
          unlimited: false,
        },
        premium_interactions: {
          entitlement: userCredits.credits.paid,
          overage_count: 0,
          overage_permitted: false,
          percent_remaining: userCredits.credits.paid > 0 ? 100 : 0,
          remaining: userCredits.credits.paid,
          unlimited: false,
        },
      },

      // User info
      username: (apiKey?.appId as any)?.name || 'Alia User',
      email: undefined, // Privacy: don't expose email via API
      name: 'Alia User',
    };

    res.json(entitlementData);
  } catch (error) {
    console.error('[Codea] Error fetching user entitlements:', error);
    res.status(500).json({ error: 'Failed to fetch entitlements' });
  }
});

/**
 * GET /token - Returns token entitlement data
 *
 * This endpoint can be used for additional token-based features.
 */
router.get('/token', authenticateApiKey, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Get user credits for token information
    let userCredits = await UserCredits.findById(userId);
    if (!userCredits) {
      userCredits = await UserCredits.create({
        _id: userId,
        credits: {
          free: 1000,
          freeLimit: 1000,
          dailyRefresh: 300,
          lastRefresh: new Date(),
          paid: 0,
        }
      });
    }

    await userCredits.refreshCreditsIfNeeded();

    res.json({
      valid: true,
      user_id: userId,
      credits: {
        free: userCredits.credits.free,
        paid: userCredits.credits.paid,
        total: userCredits.credits.free + userCredits.credits.paid,
      },
      features: {
        chat: true,
        completions: true,
        inline_suggestions: true,
        code_actions: true,
      },
    });
  } catch (error) {
    console.error('[Codea] Error fetching token info:', error);
    res.status(500).json({ error: 'Failed to fetch token info' });
  }
});

/**
 * GET /mcp_registry - Returns MCP (Model Context Protocol) registry data
 *
 * This endpoint returns available MCP servers for Codea Studio Code.
 */
router.get('/mcp_registry', authenticateApiKey, async (_req: Request, res: Response) => {
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
  } catch (error) {
    console.error('[Codea] Error fetching MCP registry:', error);
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

export default router;
