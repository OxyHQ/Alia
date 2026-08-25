import { Router } from 'express';
import { createVoiceToken, isLiveKitConfigured, getLiveKitUrl } from '../../lib/livekit-token.js';
import { getModelMappingsForTier } from '../../lib/gateway-client.js';
import { callProviderAPI, getAliaModel } from '../../lib/gateway-client.js';
import { buildIdentityGuard } from '../../lib/identity-guard.js';
import { reserveCredits, finalizeCredits, safeRefund, type CreditReservation } from '../../lib/credits-manager.js';
import { getOrCreateUserCredits } from '../../lib/user-credits-helpers.js';
import { voiceSessionManager } from '../../internal/providers/lib/voice-session-manager.js';
import { buildSystemPrompt } from '../../lib/prompt-loader.js';
import { buildUserContext } from '../../lib/user-context.js';
import { log } from '../../lib/logger.js';
import { getUserEntitlements } from '../../lib/plan-access.js';
import { aliasesForProfile } from '../../lib/routing/alias-translation.js';
import { getVoiceUsageSummary } from '../../lib/voice-usage.js';
import { getSafeErrorMessage } from '../../lib/errors/sanitize.js';
import { getDb } from '../../db/index.js';
import { loadTurnAgent } from '../../lib/agent-account.js';
import { agentPromptName } from '../../lib/agent-identity.js';
import { buildArchetypeSystemPrompt } from '../../lib/agent/archetype-prompts.js';
import { ToolPipeline } from '../../lib/tool-pipeline.js';
import { convertToolSetToOpenAITools } from '../../lib/tool-converter.js';
import type { Request, Response } from 'express';

/**
 * What a VOICE session can CARRY, whatever the assembler granted.
 *
 * ## This is a surface, not a permission, and the distinction is the point
 *
 * A voice channel has no screen. A tool whose output is something to render —
 * `canvas`, `generateFile` — would be called by the model and its result seen
 * by nobody. A tool that needs the composer, or a live container, or a browser,
 * is not reachable from a phone call either. That is a physical property of the
 * channel.
 *
 * It can only ever NARROW. Every name here has to have been produced by
 * `ToolPipeline.forUser` to survive, and an agent's grants have already decided
 * which of them it did produce — so nothing in this list can hand a session a
 * tool its owner did not grant. That is what makes it a projection rather than
 * the sixth assembler it replaced.
 *
 * The six names are exactly the six that were written out by hand before, which
 * is how "the route everybody uses does not move" is a fact rather than a hope:
 * `__tests__/voice-knows-the-agent.test.ts` enumerates them.
 */
const VOICE_SURFACE: readonly string[] = [
  'getCurrentDate',
  'sendTelegramMessage',
  'saveUserMemory',
  'updateUserMemory',
  'updateUserPreferences',
  'updateUserContext',
];

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

    /**
     * The identifier the caller asked for, in the vocabulary ENTITLEMENTS speak.
     *
     * `@alia.onl/sdk` sends `profile:v1-voice` — the routing-profile vocabulary
     * the catalogue publishes — while `allowedModelIds` comes from
     * `plans.model_ids`, which is keyed by the `alia-*` aliases. Comparing one
     * against the other refuses every request from every account on every plan,
     * and reports it as `MODEL_NOT_IN_PLAN`: a permission error that no
     * permission can satisfy. `use-catalogue.ts` records the same collision
     * biting the model picker, which is where this was found.
     *
     * Translated ONCE, here, so everything downstream — the entitlement check
     * and `startVoiceSession`, which resolves an alias to a provider — is
     * handed the same identifier.
     */
    const requestedModel = req.body.model || 'alia-v1-voice';
    const model = aliasesForProfile(requestedModel)[0] ?? requestedModel;
    const voice = req.body.voice || undefined;
    const clientInstructions = req.body.instructions || undefined;

    /**
     * The agent this VOICE session is for, named by the request exactly as a
     * text turn names one.
     *
     * Authorised by `loadTurnAgent`, the same function `lib/chat/request-context.ts`
     * uses — published-and-active, or `account:act_as` on the bot account. A
     * refusal is `null` and the session runs as ordinary Alia, which is what
     * every voice session did before this.
     */
    const requestedAgentId = typeof req.body.agentId === 'string' ? req.body.agentId : '';
    const agent =
      requestedAgentId === ''
        ? null
        : await loadTurnAgent(getDb(), {
            agentId: requestedAgentId,
            oxyUserId: userId,
            accessToken: req.accessToken,
          }).catch((err: unknown) => {
            log.general.warn({ err, agentId: requestedAgentId }, 'Could not resolve the voice agent');
            return null;
          });

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

    /**
     * The agent's own prompt, composed the way the TEXT path composes it.
     *
     * `system-prompt-builder.ts` prepends `# AGENT: <name>` above the Alia
     * prompt rather than replacing it, so voice does the same — not a third
     * shape. It goes on AFTER the client override for the same reason the guard
     * does: a session that belongs to an agent must not be able to stop being
     * that agent because the caller sent instructions.
     */
    if (agent) {
      const agentPrompt = agent.systemPrompt || buildArchetypeSystemPrompt(agent);
      if (agentPrompt) {
        voiceInstructions = `# AGENT: ${agentPromptName(agent)}\n\n${agentPrompt}\n\n---\n\n${voiceInstructions}`;
      }
    }

    /**
     * Identity guard — prepended LAST so it survives a full client override and
     * sits at the top of the voice session instructions. Nothing can strip the
     * identity boundary from a voice session.
     *
     * An agent's session says the AGENT's name; an ordinary one says the
     * model's. What does NOT change either way is the rest of the guard: the
     * provider, the foundation model and the company that trained it stay
     * unsayable. Giving an agent its name is not opening the door to naming the
     * engine.
     */
    const voiceModel = await getAliaModel(model);
    voiceInstructions = `${buildIdentityGuard({
      ...(agent ? { agentName: agentPromptName(agent) } : {}),
      modelName: voiceModel?.name,
    })}\n\n---\n\n${voiceInstructions}`;

    /**
     * The tools this session may reach, from THE assembler.
     *
     * ## Authorisation and surface are different axes, and this is where they
     * ## used to be confused
     *
     * Six descriptors used to be written out here by hand. That list was an
     * ASSEMBLER: it decided what a session could reach, and once a session can
     * belong to an agent, that decision is a permission — one the capability
     * grants already own. Two copies of a partition agree until they do not,
     * which is what `lib/__tests__/one-assembler.test.ts` exists to prevent.
     *
     * So AUTHORISATION comes from `ToolPipeline.forUser` and from nowhere else.
     * What stays here is SURFACE: a voice channel has no screen, so it cannot
     * carry a tool whose output is something to render. That is a physical
     * property of the channel, not a permission, and {@link VOICE_SURFACE} can
     * only ever narrow what the assembler already granted — it cannot add a
     * name the assembler did not produce.
     *
     * `instancedSources: []` is a FETCH decision of the same kind: a connector's
     * tools would be discarded by the projection anyway, and building them
     * first is three network round trips on a path where somebody is waiting to
     * speak.
     */
    const { tools: assembled } = await ToolPipeline.forUser({
      userId,
      accessToken: req.accessToken,
      isDirectSession: true,
      actsForPerson: true,
      agentMode: false,
      toolsEnabled: true,
      // A voice session reaches no browser and renders no citation.
      webSearch: false,
      isLocalRuntime: false,
      instancedSources: [],
      agent,
    });

    const voiceTools = await convertToolSetToOpenAITools(
      Object.fromEntries(
        Object.entries(assembled).filter(([name]) => VOICE_SURFACE.includes(name)),
      ),
    );

    /**
     * The payer's balance row, immediately before the session reserves against
     * it.
     *
     * `createSession` calls `reserveVoiceCredits`, which reserves a MINUTE —
     * fifty credits — and, like every other reserve, does not create the row it
     * spends from. Without this, an account entitled to the default allowance
     * but never provisioned was told it had no credits the first time it opened
     * voice mode, which for a plan that gates voice behind Pro is the least
     * likely moment to be believed.
     *
     * The same broken invariant as `lib/agent/session-handoff.ts`, on a path
     * that shares no code with it — hence a separate commit rather than one
     * "provisioning" change spanning both.
     */
    await getOrCreateUserCredits(userId);

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
  /**
   * Out here so the `finally` can see them, and `creditsSettled` so no exit can
   * both charge and refund — the release `routes/v1/chat-completions.ts` puts in
   * one place rather than at each exit.
   */
  let reservation: CreditReservation | null = null;
  let creditsSettled = false;
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

    reservation = await reserveCredits(userId);
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
            timeout: 15_000,
            maxAttempts: 1,
            signal: abortController.signal,
          });
          break;
        } catch (err: unknown) {
          log.general.warn({ err, provider: mapping.provider, model: mapping.modelId }, 'Transcription provider failed, trying next');
          continue;
        }
      }

      /**
       * Nothing was transcribed, so nothing is charged — and the `finally`
       * below is what does it.
       *
       * Both exits used to settle at `{ totalTokens: 0 }`, which does not mean
       * "free": `calculateCreditsFromTokens` floors at
       * `MIN_CREDITS_PER_REQUEST`, so zero tokens settles at ONE credit. That is
       * the whole reservation, kept for an audio clip the person never got back
       * as text. Leaving the reservation unsettled and letting the release
       * refund it is the difference between "consumed nothing" and "consumed
       * something too small to price", which the zero-token call cannot express.
       */
      if (abortController.signal.aborted && !result) {
        return res.status(504).json({
          error: {
            code: 'TIMEOUT',
            message: 'Transcription timed out. Please try again with a shorter audio clip.',
            retryable: true,
          },
        });
      }

      if (!result) {
        return res.status(503).json({ error: 'All transcription providers exhausted' });
      }

      // Charge minimal credits for transcription (~100 tokens equivalent)
      await finalizeCredits(reservation, {
        promptTokens: 50,
        completionTokens: 50,
        totalTokens: 100,
      });
      // Only once the charge returned: a finalize that threw leaves the
      // reservation refundable rather than silently kept.
      creditsSettled = true;

      res.json({ text: result.text });
    } finally {
      clearTimeout(globalTimer);
    }
  } catch (error: unknown) {
    log.general.error({ err: error, userId: req.user?.id }, 'Voice transcription failed');
    res.status(500).json({ error: getSafeErrorMessage(error, 'Transcription failed') });
  } finally {
    // The one place this route's reservation is released. Before this existed
    // the module imported no refund at all, so no branch of it could give a
    // credit back even where one obviously should have been.
    if (reservation && !creditsSettled) {
      await safeRefund(reservation, 'transcription produced nothing');
    }
  }
});

export default router;
