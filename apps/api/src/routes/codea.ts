import { Router, Request, Response } from 'express';
import { authenticateApiKey } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { Subscription } from '../models/subscription.js';
import { UserCredits } from '../models/user-credits.js';
import DeveloperApiKey from '../models/developer-api-key.js';
import { resolveModel } from '../lib/chat-core.js';
import { reserveCredits, finalizeCredits, type CreditReservation } from '../lib/credits-manager.js';
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
router.get('/user', authenticateApiKey, apiKeyRateLimit, async (req: Request, res: Response) => {
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
          free: 1000,
          freeLimit: 1000,
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
    console.error('[Codea] Error fetching user info:', error);
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

    console.log('[Codea] Resolving model:', model, 'for user:', userId);

    // Reserve credits
    await UserCredits.findByIdAndUpdate(
      userId,
      {
        $setOnInsert: {
          _id: userId,
          credits: { free: 1000, freeLimit: 1000, dailyRefresh: 300, lastRefresh: new Date(), paid: 0 },
        },
      },
      { upsert: true, new: true }
    );

    const reservation = await reserveCredits(userId);
    if (!reservation) {
      return res.status(402).json({
        error: 'Insufficient credits',
        details: 'You need credits to use the API'
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

    console.log('[Codea] Resolved to:', resolved.provider, resolved.modelId, 'sessionId:', sessionId);

    res.json({
      provider: resolved.provider,
      modelId: resolved.modelId,
      providerKey: resolved.keyConfig.key,
      sessionId
    });
  } catch (error: any) {
    console.error('[Codea] Error resolving model:', error);
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
      console.warn('[Codea] Session not found for usage reporting:', sessionId);
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log('[Codea] Reporting usage for session:', sessionId, 'tokens:', usage.totalTokens);

    // Finalize credits
    const { creditsCharged, creditsRemaining } = await finalizeCredits(
      session.reservation,
      usage,
      session.aliaModelId
    );

    // Clean up session
    activeSessions.delete(sessionId);

    console.log('[Codea] Charged', creditsCharged, 'credits, remaining:', creditsRemaining);

    res.json({
      success: true,
      creditsCharged,
      creditsRemaining
    });
  } catch (error: any) {
    console.error('[Codea] Error reporting usage:', error);
    res.status(500).json({ error: error.message || 'Failed to report usage' });
  }
});

export default router;
