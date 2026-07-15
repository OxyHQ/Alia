/**
 * Provider fallback retry orchestration for /v1/chat/completions.
 *
 * Drives up to `MAX_PROVIDER_RETRIES` attempts across the tier's providers/keys:
 * per attempt it re-resolves the model (skipping failed providers/keys), builds
 * the shared config (`buildBaseConfig`), then runs EITHER the non-streaming
 * `generateText` path (`runNonStreaming`) OR the streaming path (`streamText`
 * → `runStream` → text-tool fallback → save/title/credits/hooks/observability).
 * On a provider failure it classifies the error and decides key-level vs
 * provider-level skip before retrying; on success it fully sends the response.
 *
 * The retry-mutable trio (`resolved`, `aliasModelId`, `creditReservation`) and
 * the `globalTimedOut` flag live in `ChatLoopState`, owned by the route so its
 * global-timeout timer, outer catch, and last-resort synthetic observe the
 * loop's writes. Returns `completed` when a response was fully sent, or
 * `exhausted` (with the attempt count) so the route emits its synthetic reply.
 * Rethrows the provider error when content already streamed and can't be
 * retried — the route's outer catch handles the graceful mid-stream recovery.
 *
 * Behaviour is byte-identical to the inline loop it replaced. Import seams
 * (`ai`, `../chat-core.js`, `../chat-lifecycle.js`, `../logger.js`,
 * `../observability/index.js`, `../errors/index.js`) match the paths the route
 * used inline so the timeout suite's module mocks keep intercepting them.
 */
import type { Request, Response } from 'express';
import { streamText, type ToolSet } from 'ai';
import { resolveModel, reportModelUsage, type ResolvedModel } from '../chat-core.js';
import { Conversation } from '../../models/conversation.js';
import type { CreditReservation, CreditUsage } from '../credits-manager.js';
import {
  saveConversationResult,
  startParallelTitleGeneration,
  finalizeChatCredits,
  runPostChatHooks,
  notifyDisconnectedClient,
  type LifecycleContext,
} from '../chat-lifecycle.js';
import { log } from '../logger.js';
import { recordEvent } from '../observability/index.js';
import { classifyError, getRetryAfterHeader } from '../errors/index.js';
import type { FailoverReason } from '../errors/error-codes.js';
import type { ChatMessage } from '../message-converter.js';
import type { AutonomyRuntimeContext } from '../autonomy/runtime.js';
import type { SSEWriter } from './sse-writer.js';
import { buildBaseConfig } from './model-config.js';
import { runNonStreaming } from './non-streaming.js';
import { runStream, type AgentMessage, type StreamRunnerState } from './stream-runner.js';
import { runTextToolFallback } from './text-tool-fallback.js';

/** Errors that should NOT be retried on a different provider (model-level issues, not provider-level) */
const NON_RETRYABLE_STREAM: Set<FailoverReason> = new Set(['format', 'content_filter']);

/**
 * Retry-mutable state shared between the route and the provider loop. The loop
 * reassigns `resolved`/`aliasModelId` on each re-resolve and reads
 * `creditReservation` for credit finalization; the route's global-timeout timer
 * sets `globalTimedOut` (read at the top of every attempt) and reads
 * `aliasModelId`, and its outer catch + last-resort synthetic read the trio.
 */
export interface ChatLoopState {
  resolved: ResolvedModel | null;
  aliasModelId: string;
  creditReservation: CreditReservation | null;
  globalTimedOut: boolean;
}

export interface ProviderLoopParams {
  req: Request;
  res: Response;
  sse: SSEWriter;
  requestId: string;
  requestStartTime: number;
  globalTimer: NodeJS.Timeout;
  /** GLOBAL_TIMEOUT_MS — used for the per-attempt time-budget check. */
  globalTimeoutMs: number;
  state: ChatLoopState;
  body: Record<string, unknown> & { stream?: boolean; skillId?: string; conversationId?: string };
  messages: ChatMessage[];
  conversationId: string | undefined;
  thinkingMode: boolean | undefined;
  convertedMessages: unknown[];
  truncatedTools: ToolSet;
  toolNameMapping: Map<string, string>;
  /** Accumulator for delegate-to-agent replies; mutated in place by the stream runner. */
  agentMessages: AgentMessage[];
  systemPromptTokens: number;
  requestedModel: string;
  isSpanish: boolean;
  autonomyRuntime: AutonomyRuntimeContext | null;
  includeUsage: boolean;
  /** Length of the tier's provider mappings — sets the retry budget. */
  tierMappingsLength: number;
}

export type ProviderLoopResult =
  | { status: 'completed' }
  | { status: 'exhausted'; attemptedProviders: number };

/** Run the provider fallback retry loop; returns whether a response was sent or all providers were exhausted. */
export async function runProviderLoop(params: ProviderLoopParams): Promise<ProviderLoopResult> {
  const {
    req, res, sse, requestId, requestStartTime, globalTimer, globalTimeoutMs, state,
    body, messages, conversationId, thinkingMode, convertedMessages, truncatedTools,
    toolNameMapping, agentMessages, systemPromptTokens, requestedModel, isSpanish,
    autonomyRuntime, includeUsage, tierMappingsLength,
  } = params;

  // Track token usage (streaming path; the non-streaming path owns its own)
  let tokenUsage: CreditUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    systemPromptTokens,
  };

  // Tool tracking for observability
  let toolCallCount = 0;

  // Provider fallback retry loop
  // Dynamic retry budget: try every configured provider in the tier, minimum 5
  const MAX_PROVIDER_RETRIES = Math.max(tierMappingsLength, 5);
  const skipProviders = new Set<string>();
  const failedKeyIds = new Set<string>();

  /** Reasons that indicate a key-level failure (try next key, not next provider) */
  const KEY_LEVEL_REASONS: Set<FailoverReason> = new Set(['auth', 'rate_limit']);

  for (let providerAttempt = 0; providerAttempt < MAX_PROVIDER_RETRIES; providerAttempt++) {
    // Check global timeout before each provider attempt
    if (state.globalTimedOut) break;

    // Check time budget before each attempt (leave 5s for last-resort response)
    const elapsedMs = Date.now() - requestStartTime;
    if (elapsedMs > globalTimeoutMs - 10_000) {
      log.v1.warn({ elapsedMs }, 'Time budget nearly exhausted, breaking retry loop');
      break;
    }

    // Re-resolve model on retry (skipping failed providers and keys)
    if (providerAttempt > 0) {
      state.resolved = await resolveModel(requestedModel, skipProviders, failedKeyIds);
      if (!state.resolved) {
        log.v1.warn({ retries: providerAttempt }, 'No more providers available after retries');
        break;
      }
      state.aliasModelId = state.resolved.aliasModelId;
      log.v1.info({ attempt: providerAttempt, provider: state.resolved.provider, modelId: state.resolved.modelId }, 'Retrying with provider');
    }

    // Attempt 0 is guaranteed non-null by the route (it returns 503 otherwise);
    // retry attempts break above when re-resolution fails. Capture a non-null
    // local so the attempt avoids repeated non-null assertions.
    const resolved = state.resolved;
    if (!resolved) break;
    const aliasModelId = state.aliasModelId;

    // Shared with the stream runner + provider-retry catch: reflects writes made
    // inside runStream even when the stream throws mid-flight.
    const streamState: StreamRunnerState = { hasStreamedContent: false };

    // Build common config for both streaming and non-streaming, plus first-byte abort
    const { config: baseConfig, clearFirstByteTimer } = buildBaseConfig({
      resolved,
      body,
      convertedMessages,
      truncatedTools,
      thinkingMode,
      systemPromptTokens,
      streamState,
      onUsage: (usage) => { tokenUsage = usage; },
    });

    try { // Provider attempt try block

      // Handle non-streaming requests
      if (body.stream !== true) {
        await runNonStreaming({
          req,
          res,
          requestId,
          globalTimer,
          baseConfig,
          clearFirstByteTimer,
          aliasModelId,
          conversationId,
          messages,
          creditReservation: state.creditReservation,
          systemPromptTokens,
          requestStartTime,
          skillId: body.skillId,
          autonomyRuntime,
          toolNameMapping,
        });
        return { status: 'completed' };
      }

      // Start title generation in parallel for new conversations (runs during streaming)
      let titlePromise: Promise<string | null> | null = null;
      if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user) {
        titlePromise = startParallelTitleGeneration(req.user.id, conversationId, messages).catch(() => null);
      }

      // Streaming request
      const result = streamText(baseConfig);

      // Periodic keep-alive during stream processing — prevents proxy timeouts
      // during multi-step LLM calls (e.g. the follow-up request after tool execution).
      sse.startKeepAlive();

      // Track client disconnect so we can send a push notification if the response completes after they leave
      let clientDisconnected = false;
      const onClientClose = () => { clientDisconnected = true; };
      req.on('close', onClientClose);

      // Stream OpenAI-compatible chunks
      const streamResult = await runStream({
        result,
        res,
        sse,
        requestId,
        aliasModelId,
        resolved,
        baseConfig,
        convertedMessages,
        toolNameMapping,
        agentMessages,
        isSpanish,
        toolCallCount,
        state: streamState,
        onFirstChunk: clearFirstByteTimer,
      });
      let assistantResponse = streamResult.assistantResponse;
      const toolInvocations = streamResult.toolInvocations;
      toolCallCount = streamResult.toolCallCount;

      sse.stopKeepAlive();
      log.v1.info({ totalChunks: streamResult.chunkCount }, 'Stream processing complete');

      // ── Text-based tool call fallback ──
      // Some models (Gemini 3 preview, Minimax, etc.) output tool calls as text
      // instead of using the native tool calling API. Detect and execute them.
      assistantResponse = (await runTextToolFallback({
        assistantResponse,
        toolInvocations,
        tools: truncatedTools,
        convertedMessages,
        baseConfig,
        res,
        requestId,
        aliasModelId,
        resolved,
      })).assistantResponse;

      // Build lifecycle context for post-stream operations
      const lifecycleCtx: LifecycleContext = {
        userId: req.user?.id,
        conversationId,
        messages,
        aliasModelId,
        creditReservation: state.creditReservation,
        tokenUsage,
        requestStartTime,
        skillId: body.skillId,
        isApiKey: !!req.apiKey,
        autonomyRuntime,
      };

      // Save conversation
      await saveConversationResult(lifecycleCtx, assistantResponse, toolInvocations, agentMessages);

      // Send AI-generated title via SSE (generated in parallel with streaming)
      if (titlePromise && conversationId && req.user) {
        try {
          const title = await titlePromise;
          if (title) {
            res.write(`event: alia.title\ndata: ${JSON.stringify({ eventVersion: 1, title, conversationId })}\n\n`);
            await Conversation.updateOne(
              { oxyUserId: req.user.id, conversationId },
              { $set: { title } },
            );
            log.v1.info({ conversationId, title }, 'Auto-generated conversation title');
          }
        } catch (err) {
          log.v1.error({ err }, 'Failed to send inline title');
        }
      }

      // Finalize credits + send usage chunk
      const { creditsCharged, creditsRemaining, creditWarning } = await finalizeChatCredits(lifecycleCtx, req);
      if (includeUsage && state.creditReservation && req.user) {
        const usageChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: aliasModelId,
          system_fingerprint: 'fp_alia',
          service_tier: 'default',
          choices: [],
          usage: {
            prompt_tokens: tokenUsage.promptTokens,
            completion_tokens: tokenUsage.completionTokens,
            total_tokens: tokenUsage.totalTokens,
            prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
          },
          alia_usage: {
            system_prompt_tokens: tokenUsage.systemPromptTokens || 0,
            billable_tokens: Math.max(0, tokenUsage.totalTokens - (tokenUsage.systemPromptTokens || 0)),
            credits_charged: creditsCharged,
            credits_remaining: creditsRemaining,
            credit_warning: creditWarning,
          },
        };
        res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
      }

      // Fire afterChat hooks + autonomy (non-blocking)
      runPostChatHooks(lifecycleCtx, assistantResponse);

      // Record agent.end for observability (success path)
      recordEvent({
        type: 'agent.end',
        timestamp: Date.now(),
        durationMs: Date.now() - requestStartTime,
        inputTokens: tokenUsage.promptTokens,
        outputTokens: tokenUsage.completionTokens,
        toolCallCount,
      });

      sse.stopKeepAlive();
      req.off('close', onClientClose);
      res.write('data: [DONE]\n\n');
      res.end();
      clearTimeout(globalTimer);

      // If the client disconnected before the stream finished, send a push notification
      if (clientDisconnected && req.user?.id && body.conversationId) {
        notifyDisconnectedClient(req.user.id, body.conversationId, assistantResponse);
      }

      return { status: 'completed' }; // Success - exit the route handler

    } catch (providerError: unknown) {
      // Clean up timers on provider failure
      sse.stopKeepAlive();
      clearFirstByteTimer();
      // Provider attempt failed — classify with shared error classifier
      log.v1.error({ err: providerError, provider: resolved.provider, modelId: resolved.modelId }, 'Provider failed');
      const errorReason = classifyError(providerError);
      const retryAfterSec = getRetryAfterHeader(providerError);
      const retryAfterMs = retryAfterSec ? retryAfterSec * 1000 : undefined;
      await reportModelUsage(resolved.keyConfig?.keyId, resolved.provider, resolved.modelId, false, 0, errorReason, retryAfterMs);

      // Non-retryable errors: stop immediately (would fail on any provider)
      if (NON_RETRYABLE_STREAM.has(errorReason)) {
        if (streamState.hasStreamedContent) throw providerError;
        break; // Fall through to last-resort response
      }

      // If content already streamed, can't retry — fall to outer handler
      if (streamState.hasStreamedContent) {
        throw providerError;
      }

      // Discriminate key-level vs provider-level failures for smarter retry
      if (KEY_LEVEL_REASONS.has(errorReason) && resolved.keyConfig?.keyId) {
        // Key-level: skip just this key, keep the provider available
        failedKeyIds.add(resolved.keyConfig.keyId);
        log.v1.info({ provider: resolved.provider, reason: errorReason, keyId: resolved.keyConfig.keyId }, 'Key-level failure, retrying with different key');
      } else if (errorReason === 'provider_unavailable' || errorReason === 'billing') {
        // Provider-level: skip the entire provider
        skipProviders.add(resolved.provider);
        log.v1.info({ provider: resolved.provider, reason: errorReason }, 'Provider-level failure, skipping provider');
      } else {
        // timeout, unknown: skip provider to try a different one
        skipProviders.add(resolved.provider);
        log.v1.info({ provider: resolved.provider, reason: errorReason }, 'Provider failed, trying next provider');
      }

      if (providerAttempt < MAX_PROVIDER_RETRIES - 1) {
        continue; // Try next provider/key
      }

      // Last attempt exhausted — fall through to last-resort response
      break;
    }

  } // End of provider retry loop

  return { status: 'exhausted', attemptedProviders: skipProviders.size + failedKeyIds.size };
}
