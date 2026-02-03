import { Router, Request, Response } from 'express';
import chatCompletionsRouter from './v1/chat-completions.js';
import responsesRouter from './v1/responses.js';
import modelsRouter from './v1/models.js';
import { authenticateTokenOrApiKey } from '../middleware/auth.js';
import { apiKeyRateLimit } from '../middleware/api-key-rate-limit.js';
import { resolveModel, isAliaModel } from '../lib/chat-core.js';
import { UserCredits } from '../models/user-credits.js';
import { reserveCredits, finalizeCredits, type CreditReservation } from '../lib/credits-manager.js';
import * as crypto from 'crypto';

const router = Router();

// Store active sessions for usage tracking (for direct AI SDK usage by clients)
const activeSessions = new Map<string, { userId: string; reservation: CreditReservation; aliaModelId: string }>();


router.get('/', (req, res) => {
  res.json({
    message: 'AI Platform API v1',
    version: '1.0.0'
  });
});

// Public routes (no auth required)
router.use('/models', modelsRouter);

// Apply authentication to all other v1 routes (supports both JWT and API keys)
router.use(authenticateTokenOrApiKey);

// Apply rate limiting for API key authenticated requests
router.use(apiKeyRateLimit);

/**
 * GET /v1/me
 * Get current user info (works for any authenticated client)
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

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

    res.json({
      id: userId,
      email: (req.user as any)?.email || '',
      name: (req.user as any)?.displayName || (req.user as any)?.email || '',
      credits: {
        free: userCredits.credits.free,
        paid: userCredits.credits.paid,
        total: userCredits.credits.free + userCredits.credits.paid,
      },
    });
  } catch (error: any) {
    console.error('[V1/Me] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch user info' });
  }
});

/**
 * POST /v1/resolve-model
 * Centralized endpoint to resolve Alia model to provider model and get provider key
 * Used by all clients (Cowork, Codea, Main App) for direct AI SDK usage
 *
 * Request body: { model: string, clientType?: 'cowork' | 'codea' | 'app' }
 * Response: { provider: string, modelId: string, providerKey: string, sessionId: string }
 */
router.post('/resolve-model', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not found' });
    }

    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: 'Model is required' });
    }

    console.log('[V1/ResolveModel] Resolving model:', model, 'for user:', userId);

    // Validate that the requested model exists
    if (!isAliaModel(model)) {
      return res.status(400).json({ error: `Unknown model: ${model}` });
    }

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

    const resolved = await resolveModel(model);

    if (!resolved) {
      return res.status(503).json({
        error: 'No models available',
        requested_model: model
      });
    }

    // Generate session ID for usage tracking
    const sessionId = crypto.randomBytes(16).toString('hex');

    // Store session for later usage reporting
    activeSessions.set(sessionId, {
      userId,
      reservation,
      aliaModelId: resolved.aliasModelId
    });

    console.log('[V1/ResolveModel] Resolved to:', resolved.provider, resolved.modelId, 'sessionId:', sessionId);

    // Only return provider key to trusted services (telegram bot)
    const isTrustedService = !!req.headers['x-telegram-bot-secret'];
    const response: Record<string, any> = {
      provider: resolved.provider,
      modelId: resolved.modelId,
      sessionId,
      aliaModel: model
    };
    if (isTrustedService) {
      response.providerKey = resolved.keyConfig.key;
    }

    res.json(response);
  } catch (error: any) {
    console.error('[V1/ResolveModel] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to resolve model' });
  }
});

/**
 * POST /v1/report-usage
 * Centralized endpoint to report token usage for credit tracking
 * Used by all clients (Cowork, Codea, Main App) after direct AI SDK calls
 *
 * Request body: { sessionId: string, usage: { promptTokens, completionTokens, totalTokens } }
 * Response: { success: boolean, creditsCharged: number, creditsRemaining: number }
 */
router.post('/report-usage', async (req: Request, res: Response) => {
  try {
    const { sessionId, usage } = req.body;

    if (!sessionId || !usage) {
      return res.status(400).json({ error: 'sessionId and usage are required' });
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
      console.warn('[V1/ReportUsage] Session not found:', sessionId);
      return res.status(404).json({ error: 'Session not found' });
    }

    console.log('[V1/ReportUsage] Reporting usage for session:', sessionId, 'tokens:', usage.totalTokens);

    // Finalize credits
    const { creditsCharged, creditsRemaining } = await finalizeCredits(
      session.reservation,
      usage,
      session.aliaModelId
    );

    // Clean up session
    activeSessions.delete(sessionId);

    console.log('[V1/ReportUsage] Charged', creditsCharged, 'credits, remaining:', creditsRemaining);

    res.json({
      success: true,
      creditsCharged,
      creditsRemaining
    });
  } catch (error: any) {
    console.error('[V1/ReportUsage] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to report usage' });
  }
});

// Compatibility route for old Codea extension versions
router.use('/codea/chat/completions', chatCompletionsRouter);

router.use('/chat/completions', chatCompletionsRouter);

// OpenAI Responses API support (for Vercel AI SDK compatibility)
router.use('/responses', responsesRouter);

export default router;
