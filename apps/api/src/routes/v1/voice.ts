import { Router } from 'express';
import { createVoiceToken, isLiveKitConfigured, getLiveKitUrl } from '../../lib/livekit-token.js';
import { getModelMappingsForTier } from '../../lib/providers-client.js';
import { callProviderAPI } from '../../lib/providers-client.js';
import { reserveCredits, finalizeCredits } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { voiceSessionManager } from '../../internal/providers/lib/voice-session-manager.js';
import { buildSystemPrompt } from '../../lib/prompt-loader.js';
import { buildUserContext } from '../../lib/user-context.js';
import { log } from '../../lib/logger.js';
import { getUserEntitlements } from '../../lib/plan-access.js';
import { getVoiceUsageSummary } from '../../lib/voice-usage.js';
import { sanitizeMessage } from '../../lib/errors/sanitize.js';
import type { Request, Response } from 'express';
import type { OpenAITool } from '../../internal/providers/lib/types.js';

const router = Router();
const getSafeErrorMessage = (error: unknown, fallback: string): string =>
  sanitizeMessage(error instanceof Error ? error.message : fallback);

/**
 * POST /v1/voice/token
 *
 * Create a full voice session with a LiveKit room, then return
 * a user-facing LiveKit token so the client can join.
 *
 * Body: { model?, voice?, instructions? }
 * Returns: { token, url, roomName, sessionId }
 */
router.post('/token', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!isLiveKitConfigured()) {
      return res.status(503).json({ error: 'Voice mode is not available. LiveKit is not configured.' });
    }

    // Enforce voice-mode feature access
    const entitlements = await getUserEntitlements(userId);
    if (!entitlements.features['voice-mode']) {
      return res.status(403).json({
        error: {
          code: 'FEATURE_NOT_IN_PLAN',
          message: 'Upgrade your plan to use voice mode.',
          retryable: false,
          suggestedAction: 'upgrade',
        },
      });
    }

    // Enforce monthly voice minutes limit
    const voiceMinutesLimit = entitlements.features['voice-minutes'];
    let maxSessionDuration = 30;
    if (typeof voiceMinutesLimit === 'number' && voiceMinutesLimit > 0) {
      const usage = await getVoiceUsageSummary(userId, voiceMinutesLimit);
      if (usage.remainingMinutes <= 0) {
        return res.status(403).json({
          error: {
            code: 'VOICE_MINUTES_EXHAUSTED',
            message: `You've used all ${voiceMinutesLimit} voice minutes this month. Upgrade your plan for more.`,
            retryable: false,
            suggestedAction: 'upgrade',
            details: {
              limitType: 'voice-minutes',
              usedMinutes: usage.usedMinutes,
              limitMinutes: usage.limitMinutes,
            },
          },
        });
      }
      maxSessionDuration = Math.max(1, Math.min(Math.floor(usage.remainingMinutes), 30));
    }

    const model = req.body.model || 'alia-v1-voice';
    const voice = req.body.voice || undefined;
    const clientInstructions = req.body.instructions || undefined;

    // Enforce model access
    if (!entitlements.allowedModelIds.includes(model)) {
      return res.status(403).json({
        error: {
          code: 'MODEL_NOT_IN_PLAN',
          message: 'Upgrade your plan to use this model.',
          retryable: false,
          suggestedAction: 'upgrade',
        },
      });
    }

    // Build rich voice instructions (same logic as realtime.ts)
    let voiceInstructions = 'You are in a real-time voice conversation. Keep responses concise and conversational — avoid long lists, markdown, or code blocks. Speak naturally and expressively — vary your tone, pacing, and energy like a real person would. Use vocal inflections and reactions naturally.\n\n';

    try {
      const basePrompt = await buildSystemPrompt(model);
      voiceInstructions += basePrompt;
    } catch (e) {
      log.general.error({ err: e }, 'Error loading system prompt for voice');
    }

    const userContext = await buildUserContext(userId);
    voiceInstructions += userContext.contextString;
    if (userContext.language) {
      voiceInstructions += `\n\nMatch the language the user speaks. If their language is undetectable, default to ${userContext.language}.`;
    }

    // Allow client to override instructions entirely
    if (clientInstructions) {
      voiceInstructions = clientInstructions;
    }

    // Voice-appropriate tools (executed server-side by VoiceSessionManager)
    const voiceTools: OpenAITool[] = [
      {
        type: 'function',
        function: {
          name: 'getCurrentDate',
          description: 'Get the current date, time, and day of the week',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'sendTelegramMessage',
          description: "Send a message to user's Telegram. Use ONLY when user explicitly requests (e.g., 'send me X on Telegram', 'remind me via Telegram').",
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Complete message to send to user on Telegram' },
            },
            required: ['message'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'saveUserMemory',
          description: 'Save important user information for future conversations. Use when user shares preferences, personal info, goals, or anything they want remembered.',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Short descriptive key (e.g., "favorite_fruit", "occupation", "pet")' },
              value: { type: 'string', description: 'Memory value (e.g., "strawberries", "software engineer", "dog named Max")' },
              category: { type: 'string', description: 'Optional category: preference, personal, goal, experience' },
            },
            required: ['key', 'value'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'updateUserPreferences',
          description: 'Update user communication preferences: language, tone, response length, interests.',
          parameters: {
            type: 'object',
            properties: {
              language: { type: 'string', description: 'Preferred language as BCP 47 locale code (e.g., "en-US", "es-ES")' },
              tone: { type: 'string', description: 'Preferred tone (formal, casual, technical, friendly)' },
              responseLength: { type: 'string', enum: ['short', 'medium', 'long'], description: 'Preferred response length' },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'updateUserContext',
          description: 'Update user context: occupation, location, timezone.',
          parameters: {
            type: 'object',
            properties: {
              occupation: { type: 'string', description: 'User occupation/profession' },
              location: { type: 'string', description: 'User location (city, country)' },
              timezone: { type: 'string', description: 'User timezone' },
            },
            required: [],
          },
        },
      },
    ];

    // Create the voice session (creates LiveKit room, joins as agent, connects to provider)
    const session = await voiceSessionManager.createSession(userId, model, {
      model,
      instructions: voiceInstructions,
      voice,
      tools: voiceTools,
      maxDuration: maxSessionDuration,
    });

    // Generate a user-facing LiveKit token to join the same room
    const token = await createVoiceToken(userId, session.roomName);

    res.json({
      token,
      url: getLiveKitUrl(),
      roomName: session.roomName,
      sessionId: session.sessionId,
    });

  } catch (error: unknown) {
    log.general.error({ err: error, userId: req.user?.id }, 'Voice session creation failed');
    const rawMessage = error instanceof Error ? error.message : '';

    const code = rawMessage.includes('Insufficient credits')
      ? 'INSUFFICIENT_CREDITS'
      : rawMessage.includes('Maximum concurrent sessions')
        ? 'RATE_LIMIT_EXCEEDED'
        : rawMessage.includes('resolve model')
          ? 'INVALID_MODEL'
          : 'INTERNAL_ERROR';

    const status = code === 'INSUFFICIENT_CREDITS' ? 402
      : code === 'RATE_LIMIT_EXCEEDED' ? 429
        : code === 'INVALID_MODEL' ? 400
          : 500;

    res.status(status).json({
      error: {
        code,
        message: getSafeErrorMessage(error, 'Failed to create voice session'),
        retryable: false,
      },
    });
  }
});

/**
 * POST /v1/voice/transcribe
 * Speech-to-text transcription using OpenAI Whisper or Groq Whisper API
 * Global timeout: 55s (well under DO's ~120s gateway limit)
 * Per-provider timeout: 25s, 1 attempt each (fail fast → try next provider)
 */
const TRANSCRIBE_TIMEOUT_MS = 55_000;

router.post('/transcribe', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { audio, format } = req.body as { audio?: string; format?: string };
    if (!audio) {
      return res.status(400).json({ error: 'Audio data is required (base64 encoded)' });
    }

    // Ensure user has credits
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

    // Prepare audio metadata for provider transcription call
    const mimeType = format || 'audio/m4a';
    const ext = mimeType.split('/')[1] || 'm4a';

    // Global timeout — respond before DO's ~120s gateway limit
    const abortController = new AbortController();
    const globalTimer = setTimeout(() => abortController.abort(), TRANSCRIBE_TIMEOUT_MS);

    try {
      // Try each audio provider until one succeeds (1 attempt each, fail fast)
      const audioMappings = await getModelMappingsForTier('v1-audio');
      let result: { text: string } | null = null;

      for (const mapping of audioMappings) {
        if (abortController.signal.aborted) break;
        try {
          result = await callProviderAPI<{ text: string }>({
            provider: mapping.provider,
            modelId: mapping.modelId,
            endpoint: '/v1/audio/transcriptions',
            audio: {
              base64: audio,
              mimeType,
              filename: `audio.${ext}`,
            },
            extraFormFields: {
              model: mapping.modelId,
            },
            timeout: 25_000,
            maxAttempts: 1,
            signal: abortController.signal,
          });
          break;
        } catch (err: any) {
          log.general.warn({ err, provider: mapping.provider, model: mapping.modelId }, 'Transcription provider failed, trying next');
          continue;
        }
      }

      if (abortController.signal.aborted && !result) {
        await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        return res.status(504).json({
          error: {
            code: 'TIMEOUT',
            message: 'Transcription timed out. Please try again with a shorter audio clip.',
            retryable: true,
          },
        });
      }

      if (!result) {
        await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        return res.status(503).json({ error: 'All transcription providers exhausted' });
      }

      // Charge minimal credits for transcription (~100 tokens equivalent)
      await finalizeCredits(reservation, {
        promptTokens: 50,
        completionTokens: 50,
        totalTokens: 100,
      });

      res.json({ text: result.text });
    } finally {
      clearTimeout(globalTimer);
    }
  } catch (error: unknown) {
    log.general.error({ err: error, userId: req.user?.id }, 'Voice transcription failed');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Transcription failed') });
  }
});

export default router;
