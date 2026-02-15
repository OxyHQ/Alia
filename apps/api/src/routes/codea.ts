import { Router, Request, Response } from 'express';
import { authenticateApiKey } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { Subscription } from '../models/subscription.js';
import { UserCredits } from '../models/user-credits.js';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import DeveloperApiKey from '../models/developer-api-key.js';
import { resolveModel } from '../lib/chat-core.js';
import { reserveCredits, finalizeCredits, type CreditReservation } from '../lib/credits-manager.js';
import { log } from '../lib/logger.js';
import * as crypto from 'crypto';

const router = Router();

// Store active sessions for usage tracking
const activeSessions = new Map<string, { userId: string; reservation: CreditReservation; aliaModelId: string }>();

/**
 * Map subscription plan name to Alia plan type
 */
function mapPlanToAliaPlan(planName: string | undefined): string {
  if (!planName) return 'free';

  const name = planName.toLowerCase();
  // Codea-specific plans
  if (name.includes('codea max')) return 'alia_max';
  if (name.includes('codea pro')) return 'alia_pro';
  // Alia plans
  if (name.includes('ultra')) return 'alia_ultra';
  if (name.includes('max')) return 'alia_max';
  if (name.includes('pro')) return 'alia_pro';
  if (name.includes('go')) return 'alia_go';
  // Legacy backward compat
  if (name.includes('standard')) return 'alia_pro';
  if (name.includes('basic')) return 'alia_go';
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
    const subscriptions = await Subscription.find({
      oxyUserId: userId,
      status: { $in: ['active', 'trialing'] }
    }).sort({ createdAt: -1 });
    const subscription = subscriptions[0] || null;

    // Get user credits
    let userCredits = await UserCredits.findById(userId);
    if (!userCredits) {
      // Create default credits for new user
      userCredits = await UserCredits.create({
        _id: userId,
        credits: {
          free: 300,
          freeLimit: 300,
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

    // Determine highest plan across all active subscriptions
    const hasActiveSubscription = subscriptions.length > 0;
    const planHierarchy = ['free', 'alia_go', 'alia_pro', 'alia_max', 'alia_ultra'];
    let aliaPlan = 'alia_free';
    for (const sub of subscriptions) {
      const mapped = mapPlanToAliaPlan(sub.plan?.name);
      if (planHierarchy.indexOf(mapped) > planHierarchy.indexOf(aliaPlan)) {
        aliaPlan = mapped;
      }
    }
    const planName = subscription?.plan?.name;

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
    let userCredits = await UserCredits.findById(userId);
    if (!userCredits) {
      userCredits = await UserCredits.create({
        _id: userId,
        credits: {
          free: 300,
          freeLimit: 300,
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
  } catch (error) {
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
    let userCredits = await UserCredits.findById(userId);
    if (!userCredits) {
      userCredits = await UserCredits.create({
        _id: userId,
        credits: {
          free: 300,
          freeLimit: 300,
          dailyRefresh: 300,
          lastRefresh: new Date(),
          paid: 0,
        }
      });
    }

    await userCredits.refreshCreditsIfNeeded();

    // Get API key info
    const apiKey = await DeveloperApiKey.findById(req.apiKey?.id).populate('appId');

    res.json({
      id: userId,
      username: (apiKey?.appId as any)?.name || 'Alia User',
      credits: {
        free: userCredits.credits.free,
        paid: userCredits.credits.paid,
        total: userCredits.credits.free + userCredits.credits.paid,
      }
    });
  } catch (error) {
    log.codea.error({ err: error }, 'Error fetching user info');
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

/**
 * POST /resolve-model - Resolve Alia model to provider model and get provider key
 *
 * Request body: { model: string }
 * Response: { provider: string, modelId: string, providerKey: string, sessionId: string }
 */
router.post('/resolve-model', authenticateApiKey, apiKeyRateLimit, async (req: Request, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: 'Model is required' });
    }

    log.codea.info({ model, userId }, 'Resolving model');

    // Reserve credits
    await getOrCreateUserCredits(userId);

    const reservation = await reserveCredits(userId);
    if (!reservation) {
      return res.status(402).json({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: "You've run out of credits. Add more or upgrade your plan to continue.",
          retryable: false,
          suggestedAction: 'upgrade',
          details: { limitType: 'credits' },
        },
      });
    }

    // Resolve model
    const resolved = await resolveModel(model);

    if (!resolved) {
      return res.status(503).json({ error: 'No models available', requested_model: model });
    }

    // Generate session ID for usage tracking
    const sessionId = crypto.randomBytes(16).toString('hex');

    // Store session for later usage reporting
    activeSessions.set(sessionId, {
      userId,
      reservation,
      aliaModelId: resolved.aliasModelId
    });

    log.codea.info({ provider: resolved.provider, modelId: resolved.modelId, sessionId }, 'Resolved model');

    // Only return provider key to trusted services (telegram bot)
    const isTrustedService = !!req.headers['x-telegram-bot-secret'];
    const response: Record<string, any> = {
      provider: resolved.provider,
      modelId: resolved.modelId,
      sessionId
    };
    if (isTrustedService) {
      response.providerKey = resolved.keyConfig.key;
    }

    res.json(response);
  } catch (error: any) {
    log.codea.error({ err: error }, 'Error resolving model');
    res.status(500).json({ error: error.message || 'Failed to resolve model' });
  }
});

/**
 * POST /report-usage - Report token usage for credit tracking
 *
 * Request body: { sessionId: string, usage: { promptTokens, completionTokens, totalTokens } }
 */
router.post('/report-usage', authenticateApiKey, apiKeyRateLimit, async (req: Request, res: Response) => {
  try {
    const { sessionId, usage } = req.body;

    if (!sessionId || !usage) {
      return res.status(400).json({ error: 'sessionId and usage are required' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      log.codea.warn({ sessionId }, 'Session not found for usage reporting');
      return res.status(404).json({ error: 'Session not found' });
    }

    log.codea.info({ sessionId, totalTokens: usage.totalTokens }, 'Reporting usage for session');

    // Finalize credits
    const { creditsCharged, creditsRemaining } = await finalizeCredits(
      session.reservation,
      usage,
      session.aliaModelId
    );

    // Clean up session
    activeSessions.delete(sessionId);

    log.codea.info({ creditsCharged, creditsRemaining }, 'Credits charged');

    res.json({
      success: true,
      creditsCharged,
      creditsRemaining
    });
  } catch (error: any) {
    log.codea.error({ err: error }, 'Error reporting usage');
    res.status(500).json({ error: error.message || 'Failed to report usage' });
  }
});

export default router;
