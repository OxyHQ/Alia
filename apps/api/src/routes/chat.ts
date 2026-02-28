// Internal Alia Chat API - Simple streaming endpoint
// This is separate from /api/v1/chat/completions which is OpenAI-compatible for external clients

import { Router } from 'express';
import { streamText, stepCountIs } from 'ai';
import { getAIModel, resolveModel, reportModelUsage } from '../lib/chat-core.js';
import { getAliaModel, getDefaultAliaModel } from '../lib/providers-client.js';
import type { DeviceInfo } from '../lib/tools/index.js';
import { processMessagesForPlatform } from '../lib/message-processor.js';
import type { RecalledMemory } from '../lib/memory/recall.js';
import { compactHistory } from '../lib/history-compaction.js';
import { optionalAuth } from '../middleware/auth.js';
import { saveConversation, extractConversationTitle, generateConversationTitle, generateTitle } from '../lib/conversation-saver.js';
import { Conversation } from '../models/conversation.js';
import { CanvasSession } from '../models/canvas-session.js';
import { finalizeCredits, safeRefund, type CreditReservation, type CreditUsage } from '../lib/credits-manager.js';
import { estimateMessageTokens } from '../lib/token-counter.js';
import { recordUsage } from '../middleware/api-key-rate-limit.js';
import { runAfterChatHooks } from '../lib/hooks/index.js';
import { emitCanvasUpdate } from '../socket.js';
import { incrementDailyCost, isApproachingDailyCap, getDailyCostCap } from '../lib/sliding-window-limiter.js';
import { log } from '../lib/logger.js';
import { writeSSE, TextBatcher, setupSSEHeaders } from '../lib/streaming-helpers.js';
import { recordEvent } from '../lib/observability/index.js';
import { runDeepResearch, type ResearchProgress } from '../lib/research/research-engine.js';
import { MAX_CHAT_RETRIES } from '../lib/constants.js';
import { getAutoRoutedModel } from '../lib/query-classifier.js';
import { calculateCostComparison } from '../lib/cost-calculator.js';
import {
  buildChatSystemPrompt,
  loadUserContext,
  loadSkillPrompt,
  loadAgentPrompt,
  buildChatTools,
  classifyProviderError,
  handleKeyExhaustion,
  processAndCompactMessages,
  checkContext,
  wrapTools,
  resolveModelForChat,
  getModelContextWindow,
  runPreChatHooks,
} from '../services/chat.service.js';

const router = Router();

router.post('/', optionalAuth, async (req, res) => {
  // Set a timeout for the entire request (90 seconds)
  const requestTimeout = setTimeout(() => {
    if (!res.headersSent) {
      log.chat.error('Request timeout after 90s');
      res.status(504).json({ error: 'Request timeout - server took too long to respond' });
    }
  }, 90000);

  // Declare creditReservation outside try block so it's accessible in catch
  let creditReservation: CreditReservation | null = null;
  const requestStartTime = Date.now();

  try {
    const { messages, conversationId, model: requestedModel, thinkingMode, skillId, agentId, deepResearch } = req.body as {
      messages: any[];
      conversationId?: string;
      model?: string;
      thinkingMode?: boolean;
      skillId?: string;
      agentId?: string;
      deepResearch?: boolean;
    };

    if (!messages || !messages.length) {
      clearTimeout(requestTimeout);
      res.status(400).json({ error: 'No messages provided' });
      return;
    }

    if (thinkingMode) {
      log.chat.info('Thinking mode enabled for this request');
    }

    log.chat.info('Request received, loading keys...');
    if (requestedModel) {
      log.chat.info({ requestedModel }, 'User requested model');
    }

    // Extract device info from headers if available
    let deviceInfo: DeviceInfo | null = null;
    const deviceInfoHeader = req.headers['x-device-info'];
    if (deviceInfoHeader && typeof deviceInfoHeader === 'string') {
      try {
        deviceInfo = JSON.parse(deviceInfoHeader);
      } catch (e) {
        log.chat.error({ err: e }, 'Failed to parse device info header');
      }
    }

    // Determine source platform from headers
    // x-source header can be: app, telegram, api, web, discord, whatsapp, slack
    // Platform type supports 'app' | 'telegram' for message processing
    const sourceHeader = req.headers['x-source'] as string | undefined;
    const isTelegram = req.headers['x-telegram-bot'] === 'true';
    const platform: 'app' | 'telegram' = (sourceHeader === 'telegram' || isTelegram ? 'telegram' : 'app');

    // Process incoming messages to remove platform-incompatible tags
    // This saves tokens by not sending irrelevant formatting to the AI
    const processedMessages = processMessagesForPlatform(
      messages.filter(m => m && m.role).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
      platform
    );

    // Load user context (credits, memory, profile) via service
    let userContext = req.user ? await loadUserContext(req.user.id) : null;
    creditReservation = userContext?.creditReservation ?? null;

    if (req.user && !creditReservation) {
      log.chat.info('Insufficient credits');
      clearTimeout(requestTimeout);
      res.status(402).json({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: "You've run out of credits. Add more or upgrade your plan to continue.",
          retryable: false,
          suggestedAction: 'upgrade',
          details: { limitType: 'credits' },
        },
      });
      return;
    }

    const oxyUser = userContext?.oxyUser ?? null;
    const memory = userContext?.memory ?? null;
    const userTier = userContext?.userTier;

    // Load skill/agent prompts via service
    const skillPrompt = skillId ? await loadSkillPrompt(skillId) : null;
    const agentPrompt = agentId ? await loadAgentPrompt(agentId) : null;

    // ── Deep Research Mode ──
    // When activated via toggle, route to the specialized research engine
    // with multi-query web search, source tracking, and citation synthesis.
    if (deepResearch && req.user?.id) {
      const userQuery = processedMessages.filter(m => m.role === 'user').pop()?.content || '';
      if (userQuery) {
        setupSSEHeaders(res);

        try {
          const result = await runDeepResearch(userQuery, processedMessages, {
            userId: req.user.id,
            signal: req.socket.destroyed ? AbortSignal.abort() : undefined,
            onProgress: (progress: ResearchProgress) => {
              // Stream progress events as SSE
              writeSSE(res, `data: ${JSON.stringify({
                type: 'research_progress',
                phase: progress.phase,
                message: progress.message,
                subQuestions: progress.subQuestions,
                sourcesFound: progress.sourcesFound,
                currentQuery: progress.currentQuery,
                iteration: progress.iteration,
              })}\n\n`);
            },
          });

          // Stream the final report as content deltas
          const reportChunks = chunkString(result.report, 100);
          for (const chunk of reportChunks) {
            writeSSE(res, `data: ${JSON.stringify({
              choices: [{ delta: { content: chunk } }],
            })}\n\n`);
          }

          // Send sources metadata
          writeSSE(res, `data: ${JSON.stringify({
            type: 'research_complete',
            sources: result.sources,
            totalSearches: result.totalSearches,
            subQuestions: result.subQuestions,
          })}\n\n`);

          writeSSE(res, 'data: [DONE]\n\n');
          res.end();

          // Save conversation and generate title
          if (conversationId && req.user?.id) {
            await saveConversation({
              userId: req.user.id,
              conversationId,
              messages: processedMessages,
              assistantResponse: result.report,
            }).catch(err =>
              log.chat.warn({ err }, 'Failed to save research conversation')
            );

            const firstUserMsg = typeof processedMessages[0]?.content === 'string' ? processedMessages[0].content : '';
            if (firstUserMsg) {
              generateConversationTitle(req.user.id, conversationId, firstUserMsg)
                .catch(err => log.chat.error({ err }, 'Research title generation failed'));
            }
          }

          // Finalize credits
          const promptTokenEstimate = processedMessages.reduce(
            (sum, m) => sum + estimateMessageTokens(m.role, typeof m.content === 'string' ? m.content : ''), 0
          );
          const completionTokens = Math.ceil(result.report.length / 4);
          await finalizeCredits(creditReservation, {
            promptTokens: promptTokenEstimate,
            completionTokens,
            totalTokens: promptTokenEstimate + completionTokens,
            systemPromptTokens: 0,
          }).catch(() => {});
        } catch (err: any) {
          log.chat.error({ err }, 'Deep research failed');
          if (!res.headersSent) {
            res.status(500).json({ error: 'Deep research failed' });
          } else {
            writeSSE(res, `data: ${JSON.stringify({ type: 'error', error: err.message || 'Research failed' })}\n\n`);
            writeSSE(res, 'data: [DONE]\n\n');
            res.end();
          }
          await safeRefund(creditReservation, 'research error');
        }

        clearTimeout(requestTimeout);
        return;
      }
    }

    // ── Provider retry loop ──
    // When a provider fails (billing, auth, etc.), mark the key as exhausted
    // and retry with a different provider. This prevents cascading failures.
    let resolved: Awaited<ReturnType<typeof resolveModel>> | null = null;
    let assistantResponse = '';
    let hasReceivedContent = false;
    let tokenUsage: CreditUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, systemPromptTokens: 0 };
    let toolCallCount = 0;
    let streamSuccess = false;
    const failedKeyIds = new Set<string>(); // Track failed key IDs for skip on retry
    let titlePromise: Promise<string | null> | null = null;

    for (let attempt = 0; attempt < MAX_CHAT_RETRIES; attempt++) {
      // ── Resolve model (picks a healthy provider/key) ──
      try {
        // Auto-route: classify query complexity when user hasn't explicitly chosen a model
        const lastUserMsg = processedMessages.filter(m => m.role === 'user').pop()?.content || '';
        const aliasModelId = getAutoRoutedModel(requestedModel, lastUserMsg, processedMessages);
        if (attempt > 0) {
          log.chat.info({ aliasModelId, attempt: attempt + 1, skipKeyIds: [...failedKeyIds] }, 'Retrying model resolution after provider failure');
        } else {
          log.chat.info({ aliasModelId }, 'Resolving model');
        }
        resolved = await resolveModel(aliasModelId, undefined, failedKeyIds.size > 0 ? failedKeyIds : undefined);
        log.chat.info({ resolved: resolved ? `${resolved.aliasModelId} -> ${resolved.provider}/${resolved.modelId}` : 'none' }, 'Resolved model');
      } catch (keyError: any) {
        log.chat.error({ err: keyError }, 'Error loading keys');
        clearTimeout(requestTimeout);

        await safeRefund(creditReservation, 'key resolution error');

        if (res.headersSent) {
          writeSSE(res, `data: ${JSON.stringify({ type: 'error', error: 'Service temporarily unavailable. Unable to connect to AI models.' })}\n\n`);
          writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        } else {
          res.status(503).json({
            error: 'Service temporarily unavailable',
            details: 'Unable to connect to AI models. Please try again later.'
          });
        }
        return;
      }

      if (!resolved) {
        // Try alia-lite as fallback if we were requesting something else
        const aliasModelId = requestedModel || getDefaultAliaModel();
        if (aliasModelId !== 'alia-lite') {
          log.chat.info('No providers for requested model, trying alia-lite fallback');
          try {
            resolved = await resolveModel('alia-lite');
          } catch { /* ignore */ }
        }
        if (!resolved) {
          log.chat.info('No available models');
          clearTimeout(requestTimeout);

          await safeRefund(creditReservation, 'no available models');

          if (res.headersSent) {
            writeSSE(res, `data: ${JSON.stringify({ type: 'error', error: 'All AI models are currently unavailable. Please try again later.' })}\n\n`);
            writeSSE(res, 'data: [DONE]\n\n');
            res.end();
          } else {
            res.status(503).json({
              error: 'No AI models available',
              details: 'All models are currently unavailable or disabled. Please try again later.'
            });
          }
          return;
        }
      }

      const model = getAIModel(resolved.keyConfig);

      // Record agent start event for observability
      recordEvent({
        type: 'agent.start',
        timestamp: Date.now(),
        provider: resolved.provider,
        modelId: resolved.aliasModelId,
        userId: req.user?.id,
        conversationId,
        platform,
      });

      // Build tools via service (only load MCP tools on first attempt)
      const tools = attempt === 0
        ? await buildChatTools({ userId: req.user?.id, deviceInfo, isAdmin: oxyUser?.username === 'nate' })
        : await buildChatTools({ userId: req.user?.id, deviceInfo, isAdmin: oxyUser?.username === 'nate' });

      // Run beforeChat hooks (only on first attempt)
      let recalledMemories: RecalledMemory[] | undefined;
      if (attempt === 0 && req.user?.id) {
        recalledMemories = await runPreChatHooks({
          userId: req.user.id,
          conversationId,
          messages: processedMessages,
          model: resolved.aliasModelId,
          skillId,
          platform,
        });
        if (recalledMemories?.length) {
          log.chat.info({ recalled: recalledMemories.length, total: memory?.memories?.length || 0 }, 'Memory recall');
        }
      }

      // Build personalized system prompt (with skill injection + recalled memories)
      let systemPrompt = await buildChatSystemPrompt(oxyUser, memory, platform, skillPrompt, recalledMemories, agentPrompt);

      // Inject current model identity so Alia knows which tier it's running as
      const aliaModel = await getAliaModel(resolved.aliasModelId);
      if (aliaModel) {
        systemPrompt += `\n\nYou are currently using the **${aliaModel.name}** model. When asked what model you use, say you are using ${aliaModel.name}.`;
      }

      // Estimate system prompt tokens (so we don't charge users for our system prompts)
      const systemPromptTokens = estimateMessageTokens('system', systemPrompt);
      if (attempt === 0) log.chat.info({ systemPromptTokens }, 'Estimated system prompt tokens');

      // Get model context window
      const modelContextTokens = await getModelContextWindow(resolved.aliasModelId);

      // Context window guard — block if messages would exceed 90% of context (first attempt only)
      if (attempt === 0) {
        const contextCheck = checkContext(processedMessages, systemPrompt, modelContextTokens);
        if (!contextCheck.fits) {
          clearTimeout(requestTimeout);
          await safeRefund(creditReservation, 'context length exceeded');
          res.status(400).json({
            error: 'Your conversation is too long for this model. Please start a new chat or use a shorter message.',
            code: 'CONTEXT_LENGTH_EXCEEDED',
            details: { estimatedTokens: contextCheck.estimatedTokens, limit: contextCheck.contextLimit, usage: contextCheck.usage },
          });
          return;
        }
      }

      // History compaction — trim older messages if approaching context limit
      const historyBudget = Math.floor(modelContextTokens * 0.6);
      const compactedMessages = compactHistory(processedMessages as any, historyBudget);

      // Wrap tools with truncation to cap large tool results (saves tokens)
      const truncatedTools = wrapTools(tools, modelContextTokens);

      // Set headers for SSE streaming (only once)
      if (attempt === 0) setupSSEHeaders(res);

      // Reset usage tracking for this attempt
      tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, systemPromptTokens };

      // Configure streamText with thinking mode support
      // maxRetries: 0 — we handle retries ourselves via the provider retry loop
      const streamConfig: any = {
        model,
        messages: compactedMessages as any,
        tools: truncatedTools,
        stopWhen: stepCountIs(5),
        system: systemPrompt,
        temperature: 0.6,
        maxRetries: 0,
        onFinish: async (result) => {
          if (result.usage) {
            tokenUsage = {
              promptTokens: result.usage.inputTokens || 0,
              completionTokens: result.usage.outputTokens || 0,
              totalTokens: result.usage.totalTokens || 0,
              systemPromptTokens,
            };
            log.chat.info({ tokenUsage }, 'Token usage captured');
          } else {
            log.chat.warn('No usage data available from AI SDK');
          }
        },
      };

      // Enable extended thinking for Anthropic models when thinking mode is requested
      if (thinkingMode && resolved.provider === 'anthropic') {
        log.chat.info('Configuring Anthropic extended thinking mode');
        streamConfig.experimental_thinking = true;
      }

      // Start title generation in parallel for new conversations (first attempt only)
      if (attempt === 0 && !titlePromise && conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user) {
        const existing = await Conversation.findOne(
          { oxyUserId: req.user.id, conversationId },
          { messages: 1 }
        ).lean();
        if (!existing || !existing.messages?.length) {
          const firstUserMsgRaw = messages.find((m: any) => m.role === 'user')?.content;
          const firstUserMsg = typeof firstUserMsgRaw === 'string'
            ? firstUserMsgRaw
            : Array.isArray(firstUserMsgRaw)
              ? ((firstUserMsgRaw as any[]).find((p: any) => p.type === 'text')?.text ?? '')
              : '';
          if (firstUserMsg) {
            titlePromise = generateTitle(firstUserMsg);
          }
        }
      }

      const result = streamText(streamConfig);

      // Reset per-attempt state
      assistantResponse = '';
      hasReceivedContent = false;
      toolCallCount = 0;
      let streamTimeout: NodeJS.Timeout | null = null;
      const batcher = new TextBatcher(res);

      // Tool invocation tracking (ZeroClaw pattern)
      const toolTimers = new Map<string, number>();
      const MAX_TOOL_CALLS = 15;

      // Set a timeout for stream inactivity (30 seconds without any content)
      const resetStreamTimeout = () => {
        if (streamTimeout) clearTimeout(streamTimeout);
        streamTimeout = setTimeout(() => {
          if (!hasReceivedContent && !res.writableEnded) {
            log.chat.error('Stream timeout - no content received in 30s');
            batcher.flush();
            const errorEvent = {
              type: 'error',
              error: 'Stream timeout - the AI model did not respond in time. Please try again.'
            };
            writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
            writeSSE(res, 'data: [DONE]\n\n');
            res.end();
          }
        }, 30000) as any;
      };

      resetStreamTimeout();
      let providerError: string | null = null; // Set when stream yields a retryable error

      try {
        for await (const chunk of result.fullStream) {
          // Mark that we've received content
          if (chunk.type === 'text-delta' || chunk.type === 'tool-call' || (chunk as any).type === 'thinking-delta') {
            hasReceivedContent = true;
            if (streamTimeout) clearTimeout(streamTimeout);
          }

          // Intercept provider error events from the AI SDK
          // These come as stream events (not thrown), e.g. 402 Insufficient Balance
          if ((chunk as any).type === 'error') {
            const errObj = (chunk as any).error || chunk;
            const errMsg = String(errObj?.message || errObj?.error?.message || JSON.stringify(errObj).slice(0, 300));
            const statusCode = errObj?.statusCode || errObj?.status;
            const { isBilling, isAuth } = classifyProviderError(errMsg, statusCode);

            log.chat.warn({ errMsg, statusCode, isBilling, isAuth, provider: resolved!.provider, attempt: attempt + 1 }, 'Provider error in stream');

            // Mark key as exhausted for billing/auth errors
            if ((isBilling || isAuth) && resolved!.keyConfig?.keyId) {
              handleKeyExhaustion(resolved!.keyConfig.keyId, resolved!.provider, isBilling ? 'billing' : 'auth');
            }

            // Track the failed key so retry skips it (not the entire provider)
            if (resolved!.keyConfig?.keyId) failedKeyIds.add(resolved!.keyConfig.keyId);

            // Report failure to providers API
            reportModelUsage(resolved!.keyConfig?.keyId, resolved!.provider, resolved!.modelId, false, Date.now() - requestStartTime, errMsg);

            // If we can retry (no content sent yet), signal retry
            if (!hasReceivedContent && attempt < MAX_CHAT_RETRIES - 1) {
              providerError = errMsg;
              break; // Exit stream loop to retry with next key/provider
            }

            // Can't retry — forward error to client
            if (!res.writableEnded) {
              writeSSE(res, `data: ${JSON.stringify({ type: 'error', error: errMsg })}\n\n`);
            }
            break;
          }

          // Handle thinking deltas (extended thinking mode)
          if ((chunk as any).type === 'thinking-delta' && thinkingMode) {
            batcher.flush();
            const thinkingEvent = JSON.stringify({
              type: 'thinking-delta',
              text: (chunk as any).text || (chunk as any).thinking || ''
            });
            writeSSE(res, `data: ${thinkingEvent}\n\n`);
            continue;
          }

          // Handle text deltas with intelligent batching
          if (chunk.type === 'text-delta') {
            assistantResponse += chunk.text;
            batcher.add(chunk.text);
          }
          // Non-text events (tool calls, etc.) are sent immediately
          else {
            batcher.flush();

            if (chunk.type === 'tool-call') {
              toolTimers.set((chunk as any).toolCallId, Date.now());
              toolCallCount++;

              if (toolCallCount > MAX_TOOL_CALLS) {
                log.chat.warn({ toolCallCount, max: MAX_TOOL_CALLS }, 'Tool call limit exceeded');
                writeSSE(res, `data: ${JSON.stringify({
                  type: 'error',
                  error: 'Too many tool calls in a single request. Please simplify your request.'
                })}\n\n`);
                break;
              }
            }

            if (chunk.type === 'tool-result') {
              const startTime = toolTimers.get((chunk as any).toolCallId);
              const durationMs = startTime ? Date.now() - startTime : 0;
              toolTimers.delete((chunk as any).toolCallId);

              recordEvent({
                type: 'tool.call',
                timestamp: Date.now(),
                toolName: (chunk as any).toolName || 'unknown',
                durationMs,
                success: !(chunk as any).isError,
                resultSizeChars: JSON.stringify((chunk as any).result || '').length,
              });
            }

            if (chunk.type === 'finish' && assistantResponse) {
              log.chat.info({ title: extractConversationTitle(assistantResponse, messages) }, 'Extracted title');
            }

            // Handle canvas tool results
            if (chunk.type === 'tool-result' && (chunk as any).toolName === 'canvas' && (chunk as any).result) {
              const component = (chunk as any).result;
              if (conversationId && req.user?.id) {
                CanvasSession.findOneAndUpdate(
                  { oxyUserId: req.user.id, conversationId },
                  { $push: { components: { ...component, createdAt: new Date() } } },
                  { upsert: true, returnDocument: 'after' }
                ).catch(err => log.chat.error({ err }, 'Canvas save error'));
                emitCanvasUpdate(conversationId, component);
              }
              const canvasEvent = JSON.stringify({ type: 'canvas-component', component });
              writeSSE(res, `data: ${canvasEvent}\n\n`);
            }

            const event = JSON.stringify(chunk);
            writeSSE(res, `data: ${event}\n\n`);
          }
        }

        // Flush any remaining text and clean up batcher
        batcher.cleanup();
        if (streamTimeout) clearTimeout(streamTimeout);

        // If a retryable provider error was detected, continue to next attempt
        if (providerError) {
          log.chat.info({ attempt: attempt + 1, provider: resolved!.provider, error: providerError }, 'Retrying with different provider');
          continue; // Next iteration of the retry loop
        }

        // Check if we got any response
        if (!hasReceivedContent) {
          log.chat.error('Stream completed but no content was received');
          writeSSE(res, `data: ${JSON.stringify({
            type: 'error',
            error: 'No response received from AI model. Please try again.'
          })}\n\n`);
        }

        // Record success for observability
        recordEvent({
          type: 'agent.end',
          timestamp: Date.now(),
          durationMs: Date.now() - requestStartTime,
          inputTokens: tokenUsage.promptTokens,
          outputTokens: tokenUsage.completionTokens,
          toolCallCount,
        });

        // Report successful usage to providers API
        reportModelUsage(
          resolved.keyConfig?.keyId,
          resolved.provider,
          resolved.modelId,
          true,
          Date.now() - requestStartTime,
        );

        streamSuccess = true;
        break; // Success — exit retry loop

      } catch (streamError: any) {
        const errMsg = String(streamError?.message || 'Unknown error');
        const latency = Date.now() - requestStartTime;
        log.chat.error({ err: streamError, attempt: attempt + 1 }, 'Error during streaming');

        // Clean up timers
        if (streamTimeout) clearTimeout(streamTimeout);
        batcher.cleanup();

        // Classify the error and feed it back to the key manager
        const { isBilling, isAuth } = classifyProviderError(errMsg);

        if ((isBilling || isAuth) && resolved.keyConfig?.keyId) {
          handleKeyExhaustion(resolved.keyConfig.keyId, resolved.provider, isBilling ? 'billing' : 'auth');
        }

        // Track the failed key so retry skips it (not the entire provider)
        if (resolved.keyConfig?.keyId) failedKeyIds.add(resolved.keyConfig.keyId);

        // Report failure to providers API
        reportModelUsage(
          resolved.keyConfig?.keyId,
          resolved.provider,
          resolved.modelId,
          false,
          latency,
          errMsg,
        );

        // Record error for observability
        recordEvent({
          type: 'agent.end',
          timestamp: Date.now(),
          durationMs: latency,
          toolCallCount,
          error: errMsg,
        });

        // If no content was sent to client yet, we can retry with a different provider
        if (!hasReceivedContent && attempt < MAX_CHAT_RETRIES - 1) {
          log.chat.info({ attempt: attempt + 1, errMsg, provider: resolved.provider }, 'Retrying with different provider');
          continue; // Try next provider
        }

        // Content was already sent or last attempt — send error to client and end
        await safeRefund(creditReservation, 'streaming error');

        if (!res.writableEnded) {
          writeSSE(res, `data: ${JSON.stringify({
            type: 'error',
            error: errMsg || 'An error occurred while streaming the response'
          })}\n\n`);
          writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        }
        clearTimeout(requestTimeout);
        return;
      }
    } // end retry loop

    // If all retries failed without throwing (shouldn't happen, but safety net)
    if (!streamSuccess) {
      await safeRefund(creditReservation, 'all provider retries exhausted');
      if (!res.writableEnded) {
        writeSSE(res, `data: ${JSON.stringify({
          type: 'error',
          error: 'All AI providers are currently unavailable. Please try again later.'
        })}\n\n`);
        writeSSE(res, 'data: [DONE]\n\n');
        res.end();
      }
      clearTimeout(requestTimeout);
      return;
    }

    // Finalize credits based on actual token usage and model tier
    if (creditReservation && req.user) {
      try {
        log.chat.info({ tokenUsage }, 'About to finalize credits with token usage');
        const { creditsCharged, creditsRemaining } = await finalizeCredits(
          creditReservation,
          tokenUsage,
          resolved?.aliasModelId
        );

        log.chat.info({ creditsCharged, creditsRemaining }, 'Credits finalized successfully');

        // Track daily cost in sliding window limiter
        incrementDailyCost(req.user.id, creditsCharged);

        // Calculate cost savings from smart routing
        const costComparison = resolved ? calculateCostComparison(
          resolved.aliasModelId,
          resolved.provider,
          resolved.modelId,
          tokenUsage.promptTokens,
          tokenUsage.completionTokens,
        ) : null;

        const creditUpdate: Record<string, any> = {
          type: 'credit-update',
          credits: creditsRemaining,
          creditsUsed: creditsCharged,
          totalTokens: tokenUsage.totalTokens,
          promptTokens: tokenUsage.promptTokens,
          completionTokens: tokenUsage.completionTokens,
        };

        // Include savings data when meaningful (>20%)
        if (costComparison && costComparison.savingsPercent > 20) {
          creditUpdate.savingsPercent = costComparison.savingsPercent;
        }
        log.chat.info({ creditUpdate }, 'Sending credit update event');
        writeSSE(res, `data: ${JSON.stringify(creditUpdate)}\n\n`);

        // Send spending alert if approaching daily cost cap
        if (isApproachingDailyCap(req.user.id, userTier || 'free')) {
          const cap = getDailyCostCap(userTier || 'free');
          writeSSE(res, `data: ${JSON.stringify({
            type: 'spending-alert',
            message: 'You are approaching your daily usage limit.',
            dailyCostCap: cap,
          })}\n\n`);
        }

        // Record usage so the credits usage chart has data
        recordUsage(req, 200, tokenUsage.totalTokens, undefined, creditsCharged).catch(err =>
          log.chat.error({ err }, 'Error recording usage')
        );
      } catch (error) {
        log.chat.error({ err: error }, 'Error finalizing credits');
      }
    } else {
      log.chat.info({ hasCreditReservation: !!creditReservation, hasUser: !!req.user }, 'Skipping credit finalization');
    }

    // Fire afterChat hooks (non-blocking)
    runAfterChatHooks({
      userId: req.user?.id,
      conversationId,
      messages,
      model: resolved?.aliasModelId || 'alia-v1',
      skillId,
      platform: 'app',
      metadata: { provider: resolved?.provider || 'unknown' },
      response: assistantResponse,
      tokenUsage,
      modelUsed: resolved?.keyConfig?.modelId || 'unknown',
      latencyMs: Date.now() - requestStartTime,
    }).catch(err => log.chat.error({ err }, 'Error in afterChat hooks'));

    // Auto-save conversation if conversationId provided and user is authenticated
    if (conversationId && typeof conversationId === 'string' && conversationId.trim() && req.user && assistantResponse) {
      try {
        await saveConversation({
          userId: req.user.id,
          conversationId,
          messages,
          assistantResponse,
          source: platform,
          agentId,
        });
        log.chat.info({ conversationId }, 'Conversation saved successfully');
      } catch (error) {
        log.chat.error({ err: error, conversationId }, 'Error saving conversation');
      }
    } else if (!conversationId && req.user) {
      log.chat.warn('ConversationId not provided - conversation will not be saved');
    }

    // Send AI-generated title via SSE (generated in parallel with streaming)
    if (titlePromise && conversationId && req.user) {
      try {
        const title = await titlePromise;
        if (title) {
          writeSSE(res, `data: ${JSON.stringify({ type: 'title_update', title, conversationId })}\n\n`);
          await Conversation.updateOne(
            { oxyUserId: req.user.id, conversationId },
            { $set: { title } },
          );
          log.chat.info({ conversationId, title }, 'Auto-generated conversation title');
        }
      } catch (err) {
        log.chat.error({ err }, 'Failed to send inline title');
      }
    }

    // Send completion marker
    writeSSE(res, 'data: [DONE]\n\n');
    res.end();
    clearTimeout(requestTimeout);

  } catch (e: any) {
    log.chat.error({ err: e }, 'Request failed');
    clearTimeout(requestTimeout);

    await safeRefund(creditReservation, 'request failed');

    if (!res.headersSent) {
      // Headers not sent yet, send JSON error
      res.status(500).json({
        error: e.message || 'An error occurred while processing your request',
        details: e.stack ? e.stack.split('\n')[0] : undefined
      });
    } else {
      // Headers already sent (streaming started), send error event and close
      const errorEvent = {
        type: 'error',
        error: e.message || 'An error occurred while processing your request'
      };
      writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
      writeSSE(res, 'data: [DONE]\n\n');
      res.end();
    }
  }
});

router.get('/', async (req, res) => {
  res.json({
    status: '🟢 Online',
    service: 'Alia AI Chat',
    tools: {
      getCurrentDate: true,
      webSearch: true,
      webScraper: true
    }
  });
});

/** Split a string into chunks of a given size. */
function chunkString(str: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

export default router;
