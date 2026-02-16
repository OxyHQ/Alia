import { Router } from 'express';
import { createVoiceToken, isLiveKitConfigured, getLiveKitUrl } from '../../lib/livekit-token.js';
import { getBestKeyForModel, recordKeySuccess, recordKeyFailure } from '../../internal/providers/lib/key-manager.js';
import { getModelMappingsForTier } from '../../internal/providers/lib/alia-models.js';
import { reserveCredits, finalizeCredits } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { voiceSessionManager } from '../../internal/providers/lib/voice-session-manager.js';
import { buildSystemPrompt } from '../../lib/prompt-loader.js';
import { buildUserContext } from '../../lib/user-context.js';
import { log } from '../../lib/logger.js';
import { getUserEntitlements } from '../../lib/plan-access.js';
import type { Request, Response } from 'express';
import type { OpenAITool } from '../../internal/providers/lib/types.js';

const WHISPER_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/audio/transcriptions',
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
};

const router = Router();

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
      voiceInstructions += `\n\nCRITICAL LANGUAGE RULE: You MUST respond in the SAME language the user is currently speaking.
- If the user speaks English, respond in English.
- If the user speaks Spanish, respond in Spanish.
- If the user switches languages mid-conversation, switch with them immediately.
- The language preference "${userContext.language}" is ONLY your default for the first message or when the user's language is ambiguous.
- NEVER tell the user you're responding in a language because of their "preferences" — always match their actual spoken language.`;
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
              language: { type: 'string', description: 'Preferred language (e.g., "Spanish", "English")' },
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
    });

    // Generate a user-facing LiveKit token to join the same room
    const token = await createVoiceToken(userId, session.roomName);

    res.json({
      token,
      url: getLiveKitUrl(),
      roomName: session.roomName,
      sessionId: session.sessionId,
    });

  } catch (error: any) {
    log.general.error({ err: error, userId: req.user?.id }, 'Voice session creation failed');

    const code = error.message?.includes('Insufficient credits')
      ? 'INSUFFICIENT_CREDITS'
      : error.message?.includes('Maximum concurrent sessions')
        ? 'RATE_LIMIT_EXCEEDED'
        : error.message?.includes('resolve model')
          ? 'INVALID_MODEL'
          : 'INTERNAL_ERROR';

    const status = code === 'INSUFFICIENT_CREDITS' ? 402
      : code === 'RATE_LIMIT_EXCEEDED' ? 429
        : code === 'INVALID_MODEL' ? 400
          : 500;

    res.status(status).json({
      error: {
        code,
        message: error.message || 'Failed to create voice session',
        retryable: false,
      },
    });
  }
});

/**
 * POST /v1/voice/transcribe
 * Speech-to-text transcription using OpenAI Whisper or Groq Whisper API
 * Timeout: 30 seconds per request (returns 504 if provider hangs)
 */
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

    // Resolve a Whisper-compatible provider key using the v1-audio tier
    let apiKey: string | null = null;
    let whisperUrl = '';
    let whisperModel = '';
    let resolvedKeyId: string | null = null;

    const audioMappings = getModelMappingsForTier('v1-audio');

    for (const mapping of audioMappings) {
      const url = WHISPER_URLS[mapping.provider];
      if (!url) continue;

      try {
        const keyConfig = await getBestKeyForModel(mapping.provider, mapping.modelId);
        if (keyConfig?.key) {
          apiKey = keyConfig.key;
          whisperUrl = url;
          whisperModel = mapping.modelId;
          resolvedKeyId = keyConfig.keyId || null;
          break;
        }
      } catch (err) {
        log.general.warn({ err, provider: mapping.provider, model: mapping.modelId }, 'Transcription key lookup failed');
      }
    }

    if (!apiKey) {
      log.general.error('All transcription providers exhausted, no key available');
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return res.status(503).json({ error: 'No transcription provider available' });
    }

    // Convert base64 to buffer and call Whisper API with 30s timeout
    const audioBuffer = Buffer.from(audio, 'base64');
    const mimeType = format || 'audio/m4a';
    const ext = mimeType.split('/')[1] || 'm4a';

    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', whisperModel);

    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 30000);

    let response: globalThis.Response;
    try {
      response = await fetch(whisperUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);
    } catch (fetchError: any) {
      clearTimeout(fetchTimeout);
      if (fetchError.name === 'AbortError') {
        log.general.error({ whisperModel, whisperUrl }, 'Whisper API timeout (30s)');
        if (resolvedKeyId) recordKeyFailure(resolvedKeyId, 'Whisper API timeout').catch(() => {});
        await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        return res.status(504).json({ error: 'Transcription timed out' });
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      log.general.error({ whisperModel, statusCode: response.status, errorBody }, 'Whisper API error');
      if (resolvedKeyId) recordKeyFailure(resolvedKeyId, `Whisper API ${response.status}`).catch(() => {});
      await finalizeCredits(reservation, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      return res.status(502).json({ error: 'Transcription failed' });
    }

    const result = await response.json() as { text: string };

    if (resolvedKeyId) recordKeySuccess(resolvedKeyId).catch(() => {});

    // Charge minimal credits for transcription (~100 tokens equivalent)
    await finalizeCredits(reservation, {
      promptTokens: 50,
      completionTokens: 50,
      totalTokens: 100,
    });

    res.json({ text: result.text });
  } catch (error: any) {
    log.general.error({ err: error, userId: req.user?.id }, 'Voice transcription failed');
    res.status(500).json({ error: error.message || 'Transcription failed' });
  }
});

export default router;
