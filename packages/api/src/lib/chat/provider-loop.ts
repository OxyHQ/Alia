/**
 * One Kaana-hosted attempt for /v1/chat/completions.
 *
 * Builds the shared config (`buildBaseConfig`), then runs either the non-streaming
 * `generateText` path (`runNonStreaming`) OR the streaming path (`streamText`
 * → `runStream` → text-tool fallback → save/title/credits/hooks/observability).
 * Kaana owns deployment choice, key rotation and route changes. Alia never
 * re-resolves a hosted failure around it.
 *
 * `resolved`, `routingProfileId`, `creditReservation` and `globalTimedOut` live in
 * `ChatLoopState`, owned by the route so its
 * global-timeout timer, outer catch, and last-resort synthetic observe the
 * loop's writes. Returns `completed` when a response was fully sent, or
 * `exhausted` (with the attempt count) so the route emits its synthetic reply.
 * Rethrows an inference error when content already streamed; the route's outer
 * catch handles graceful mid-stream recovery.
 *
 * Behaviour is byte-identical to the inline loop it replaced. Import seams
 * (`ai`, `../chat-core.js`, `../chat-lifecycle.js`, `../logger.js`,
 * `../observability/index.js`, `../errors/index.js`) match the paths the route
 * used inline so the timeout suite's module mocks keep intercepting them.
 */
import type { Request, Response } from 'express';
import { streamText, type ToolSet } from 'ai';
import type { ResolvedModel } from '../chat-core.js';
import { getDb } from '../../db/index.js';
import { updateConversationTitle } from '../../db/chat/conversationRepository.js';
import type { CreditReservation, CreditUsage } from '../credits-manager.js';
import {
  saveConversationResult,
  turnProducedOutput,
  startParallelTitleGeneration,
  finalizeChatCredits,
  runPostChatHooks,
  notifyDisconnectedClient,
  type LifecycleContext,
  type TurnObservation,
} from '../chat-lifecycle.js';
import { log } from '../logger.js';
import { recordEvent } from '../observability/index.js';
import type { EffortLevel } from '../reasoning-effort.js';
import type { SkillRuntime } from '../skills/runtime.js';
import { classifyError, toAliaError } from '../errors/index.js';
import { AliaErrorCode, type FailoverReason } from '../errors/error-codes.js';
import type { ChatMessage } from '../message-converter.js';
import type { AutonomyRuntimeContext } from '../autonomy/runtime.js';
import type { SSEWriter } from './sse-writer.js';
import { buildBaseConfig } from './model-config.js';
import { runNonStreaming } from './non-streaming.js';
import { runStream, type AgentMessage, type StreamRunnerState } from './stream-runner.js';
import { runTextToolFallback } from './text-tool-fallback.js';

/** Terminal model-response errors that need no route-level substitution. */
const TERMINAL_STREAM_ERRORS: Set<FailoverReason> = new Set(['format', 'content_filter']);

/**
 * Mutable state shared between the route and the hosted attempt. The route's
 * global-timeout timer sets `globalTimedOut`, and the outer catch plus
 * last-resort synthetic reply read the same state.
 */
export interface ChatLoopState {
  resolved: ResolvedModel | null;
  routingProfileId: string;
  creditReservation: CreditReservation | null;
  /**
   * Whether the reservation has been resolved — charged or refunded. It stays
   * false until something settles it, so the handler's single release point can
   * refund a reservation no exit path accounted for. `creditReservation` alone
   * cannot say this: it is still read after finalization to build the usage chunk.
   */
  creditsSettled: boolean;
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
  body: Record<string, unknown> & { stream?: boolean; conversationId?: string };
  /** This turn's skill runtime. Read for what ACTIVATED, which is only final once the turn is. */
  skills: SkillRuntime;
  messages: ChatMessage[];
  conversationId: string | undefined;
  /** The level, resolved once at the request boundary. */
  reasoningEffort: EffortLevel | null;
  convertedMessages: unknown[];
  truncatedTools: ToolSet;
  toolNameMapping: Map<string, string>;
  /** Accumulator for delegate-to-agent replies; mutated in place by the stream runner. */
  agentMessages: AgentMessage[];
  systemPromptTokens: number;
  requestedModel: string;
  /**
   * The SAME routing options the first resolve used. Re-resolving under a
   * different (wider) policy would reintroduce silent substitution one retry
   * later, which is exactly the shape ADR 0003 invariant 3 forbids.
   */
  isSpanish: boolean;
  autonomyRuntime: AutonomyRuntimeContext | null;
  includeUsage: boolean;
}

export type ProviderLoopResult =
  | { status: 'completed' }
  | { status: 'exhausted'; attemptedProviders: number };

/** Run one Kaana-hosted attempt and report whether a response was sent. */
export async function runProviderLoop(params: ProviderLoopParams): Promise<ProviderLoopResult> {
  const {
    req, res, sse, requestId, requestStartTime, globalTimer, globalTimeoutMs, state,
    body, messages, conversationId, reasoningEffort, convertedMessages, truncatedTools,
    toolNameMapping, agentMessages, systemPromptTokens, requestedModel, isSpanish,
    autonomyRuntime, includeUsage, skills,
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

  /**
   * What this turn observed, shared with the stream runner and the
   * non-streaming branch.
   *
   * The disconnect listener is registered once, before either response mode.
   */
  const observation: TurnObservation = { timeToFirstTokenMs: null, cancelled: false };

  const onClientClose = (): void => { observation.cancelled = true; };
  req.on('close', onClientClose);

  /**
   * The lifecycle context AS IT STANDS, read fresh at each call because the
   * `tokenUsage` is captured asynchronously by `onFinish`.
   */
  const lifecycleContext = (): LifecycleContext => ({
    userId: req.user?.id,
    conversationId,
    messages,
    routingProfileId: state.routingProfileId,
    requestedModel,
    reasoningEffort,
    creditReservation: state.creditReservation,
    tokenUsage,
    requestStartTime,
    skillNames: skills.activated().map((skill: { name: string }) => skill.name),
    isApiKey: !!req.apiKey,
    autonomyRuntime,
  });

  /**
   * The error class this turn ends with if it never completes.
   *
   * It starts as the generic hosted-inference exhaustion class and becomes the
   * specific class the Kaana failure classified into.
   */
  let failureClass: AliaErrorCode = AliaErrorCode.FALLBACK_EXHAUSTED;

  /**
   * The usage record for a turn that did not complete.
   *
   * The empty assistant response is the fact rather than a placeholder: nothing
   * usable reached the caller, which is what `runAutonomyAfterChat` reads to
   * score the run. The listener comes off here because this is the last thing
   * that happens on every failing exit.
   */
  const recordFailedTurn = (errorClass: AliaErrorCode): void => {
    req.off('close', onClientClose);
    runPostChatHooks(lifecycleContext(), '', observation, errorClass);
  };

  hostedAttempt: {
    // Check the global timeout before opening the hosted stream.
    if (state.globalTimedOut) {
      failureClass = AliaErrorCode.TIMEOUT;
      break hostedAttempt;
    }

    // Leave enough time for the last-resort response.
    const elapsedMs = Date.now() - requestStartTime;
    if (elapsedMs > globalTimeoutMs - 10_000) {
      log.v1.warn({ elapsedMs }, 'Time budget nearly exhausted before Kaana inference');
      failureClass = AliaErrorCode.TIMEOUT;
      break hostedAttempt;
    }

    // The route returns 503 before this function when resolution is absent.
    const resolved = state.resolved;
    if (!resolved) break hostedAttempt;
    const routingProfileId = state.routingProfileId;

    // Shared with the stream runner and catch: reflects writes made
    // inside runStream even when the stream throws mid-flight.
    const streamState: StreamRunnerState = { hasStreamedContent: false };

    // Build common config for both streaming and non-streaming, plus first-byte abort
    const { config: baseConfig, clearFirstByteTimer } = buildBaseConfig({
      resolved,
      body,
      convertedMessages,
      truncatedTools,
      reasoningEffort,
      systemPromptTokens,
      streamState,
      onUsage: (usage) => { tokenUsage = usage; },
    });

    try {

      // Handle non-streaming requests
      if (body.stream !== true) {
        await runNonStreaming({
          settlement: state,
          req,
          res,
          requestId,
          globalTimer,
          baseConfig,
          clearFirstByteTimer,
          routingProfileId,
          requestedModel,
          reasoningEffort,
          conversationId,
          messages,
          creditReservation: state.creditReservation,
          systemPromptTokens,
          requestStartTime,
          skills,
          autonomyRuntime,
          toolNameMapping,
          observation,
        });
        req.off('close', onClientClose);
        return { status: 'completed' };
      }

      // Start title generation in parallel for new conversations (runs during streaming)
      let titlePromise: Promise<string | null> | null = null;
      if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user) {
        /**
         * The catch is what keeps a title failure from failing the TURN, and
         * the log is what keeps it from being invisible. `() => null` was both
         * at once: `generateTitle` swallows its own faults, so anything that
         * reaches here is a fault of the two existence queries above it, and
         * the whole feature could stop working against a sick database with
         * nothing anywhere to say so.
         */
        titlePromise = startParallelTitleGeneration(req.user.id, conversationId, messages).catch((err: unknown) => {
          log.v1.error({ err, conversationId }, 'Parallel title generation failed');
          return null;
        });
      }

      // Streaming request
      const result = streamText(baseConfig);

      // Periodic keep-alive during stream processing — prevents proxy timeouts
      // during multi-step LLM calls (e.g. the follow-up request after tool execution).
      sse.startKeepAlive();

      // Stream OpenAI-compatible chunks
      const streamResult = await runStream({
        result,
        res,
        sse,
        requestId,
        routingProfileId,
        resolved,
        baseConfig,
        convertedMessages,
        toolNameMapping,
        agentMessages,
        isSpanish,
        toolCallCount,
        state: streamState,
        onFirstChunk: () => {
          // Called on EVERY chunk, so the first one wins: time to FIRST token,
          // not time to the most recent one.
          //
          // Timed HERE, where the provider stream is consumed, rather than after
          // the SSE frame is written — so the number is the model's latency and
          // not the model's latency plus this process's own write path. Both are
          // worth knowing and they are different questions; conflating them is
          // how a socket-buffering problem gets attributed to a provider.
          observation.timeToFirstTokenMs ??= Date.now() - requestStartTime;
          clearFirstByteTimer();
        },
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
        routingProfileId,
        resolved,
      })).assistantResponse;

      // Build lifecycle context for post-stream operations
      const lifecycleCtx = lifecycleContext();

      // Save conversation
      await saveConversationResult(lifecycleCtx, assistantResponse, toolInvocations, agentMessages);

      // Send AI-generated title via SSE (generated in parallel with streaming)
      if (titlePromise && conversationId && req.user) {
        try {
          const title = await titlePromise;
          if (title) {
            res.write(`event: alia.title\ndata: ${JSON.stringify({ eventVersion: 1, title, conversationId })}\n\n`);
            await updateConversationTitle(getDb(), req.user.id, conversationId, title);
            // The title is a model summary of the user's own conversation.
            log.v1.info({ conversationId }, 'Auto-generated conversation title');
          }
        } catch (err) {
          log.v1.error({ err }, 'Failed to send inline title');
        }
      }

      /**
       * Finalize credits + send usage chunk.
       *
       * Only for a turn that produced something. `calculateCreditsFromTokens`
       * bills `MIN_CREDITS_PER_REQUEST` for zero tokens, which makes the
       * adjustment exactly zero and quietly keeps the whole reservation as the
       * charge — a person pays for an answer that never arrived. Left unsettled,
       * the handler's release point refunds it.
       */
      const producedOutput = turnProducedOutput(assistantResponse, toolInvocations);
      const { creditsCharged, creditsRemaining, creditWarning } = producedOutput
        ? await finalizeChatCredits(lifecycleCtx, req, state)
        : { creditsCharged: 0, creditsRemaining: 0, creditWarning: null };
      if (includeUsage && state.creditReservation && req.user) {
        const usageChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: routingProfileId,
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
      runPostChatHooks(lifecycleCtx, assistantResponse, observation, null);

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
      if (observation.cancelled && req.user?.id && body.conversationId) {
        notifyDisconnectedClient(req.user.id, body.conversationId, assistantResponse);
      }

      return { status: 'completed' }; // Success - exit the route handler

    } catch (inferenceError: unknown) {
      // Clean up timers on inference failure.
      sse.stopKeepAlive();
      clearFirstByteTimer();
      log.v1.error({ err: inferenceError, modelId: resolved.modelId }, 'Kaana inference failed');
      const errorReason = classifyError(inferenceError);

      // The class this failure would end the turn with, if nothing after it
      // succeeds. `toAliaError` owns the reason -> code table, so this is the
      // same classification the client is answered with rather than a second
      // one that can disagree with it.
      failureClass = toAliaError(inferenceError).code;

      if (TERMINAL_STREAM_ERRORS.has(errorReason)) {
        if (streamState.hasStreamedContent) {
          recordFailedTurn(failureClass);
          throw inferenceError;
        }
        break hostedAttempt;
      }

      // If content already streamed, the outer handler finishes the SSE reply.
      if (streamState.hasStreamedContent) {
        recordFailedTurn(failureClass);
        throw inferenceError;
      }

      // Kaana owns routing and retries; Alia never re-resolves around it.
      break hostedAttempt;
    }

  }

  // Every exit above that is not `completed` is a turn that
  // failed, and this is the only place it gets a usage record.
  recordFailedTurn(failureClass);
  return { status: 'exhausted', attemptedProviders: 1 };
}
