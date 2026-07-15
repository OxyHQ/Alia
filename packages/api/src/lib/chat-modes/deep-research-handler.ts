import type { Response } from 'express';
import { writeContentChunk, writeStopChunk } from '../streaming-helpers.js';
import { runDeepResearch, type ResearchProgress } from '../research/research-engine.js';
import { saveConversation, generateConversationTitle } from '../conversation-saver.js';
import { finalizeCredits, refundReservation, type CreditReservation, type CreditUsage } from '../credits-manager.js';
import { estimateMessageTokens } from '../token-counter.js';
import { runAutonomyAfterChat, type AutonomyRuntimeContext } from '../autonomy/runtime.js';
import { sanitizeMessage } from '../errors/index.js';
import { log } from '../logger.js';
import type { ChatMessage } from '../message-converter.js';

export interface DeepResearchContext {
  res: Response;
  requestId: string;
  aliasModelId: string;
  userId: string;
  conversationId?: string;
  messages: ChatMessage[];
  creditReservation: CreditReservation | null;
  autonomyRuntime: AutonomyRuntimeContext | null;
  requestStartTime: number;
  globalTimer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
}

/**
 * Handles deep research mode — multi-query web search with source tracking and citations.
 * Returns true if handled (caller should return), false if skipped (e.g. empty query).
 */
export async function handleDeepResearch(ctx: DeepResearchContext): Promise<boolean> {
  const { res, requestId, aliasModelId, userId, conversationId, messages, autonomyRuntime, requestStartTime, globalTimer } = ctx;
  const { creditReservation } = ctx;

  const userQuery = messages.filter((m: ChatMessage) => m.role === 'user').pop()?.content || '';
  const queryText = typeof userQuery === 'string' ? userQuery : '';

  if (!queryText.trim()) return false;

  log.v1.info({ conversationId, autoDetected: false }, 'Deep research mode activated');

  try {
    const result = await runDeepResearch(queryText, messages as Array<{ role: string; content: string }>, {
      userId,
      signal: ctx.signal,
      onProgress: (progress: ResearchProgress) => {
        if (!res.writableEnded) {
          res.write(`event: alia.research_progress\ndata: ${JSON.stringify({
            eventVersion: 1,
            phase: progress.phase,
            message: progress.message,
            subQuestions: progress.subQuestions,
            sourcesFound: progress.sourcesFound,
            currentQuery: progress.currentQuery,
            iteration: progress.iteration,
          })}\n\n`);
        }
      },
    });

    // Stream the final report as content deltas (OpenAI SSE format)
    const CHUNK_SIZE = 100;
    for (let i = 0; i < result.report.length; i += CHUNK_SIZE) {
      writeContentChunk(res, requestId, aliasModelId, result.report.slice(i, i + CHUNK_SIZE));
    }

    // Send sources metadata as named event
    res.write(`event: alia.research_progress\ndata: ${JSON.stringify({
      eventVersion: 1,
      phase: 'complete',
      sources: result.sources,
      totalSearches: result.totalSearches,
      subQuestions: result.subQuestions,
    })}\n\n`);

    // Send final chunk with finish_reason
    writeStopChunk(res, requestId, aliasModelId);
    res.write('data: [DONE]\n\n');
    res.end();

    // Save conversation and generate title
    if (conversationId && userId) {
      saveConversation({
        userId,
        conversationId,
        messages,
        assistantResponse: result.report,
      }).catch(err => log.v1.warn({ err }, 'Failed to save research conversation'));

      const firstUserMsg = typeof messages[0]?.content === 'string' ? messages[0].content : '';
      if (firstUserMsg) {
        generateConversationTitle(userId, conversationId, firstUserMsg)
          .catch(err => log.v1.error({ err }, 'Research title generation failed'));
      }
    }

    // Finalize credits
    if (creditReservation) {
      const promptTokenEstimate = messages.reduce(
        (sum: number, m: ChatMessage) => sum + estimateMessageTokens(m.role, typeof m.content === 'string' ? m.content : ''), 0
      );
      const completionTokens = Math.ceil(result.report.length / 4);
      finalizeCredits(creditReservation, {
        promptTokens: promptTokenEstimate,
        completionTokens,
        totalTokens: promptTokenEstimate + completionTokens,
        systemPromptTokens: 0,
      } as CreditUsage).catch((err: unknown) => log.v1.error({ err }, 'finalizeCredits failed after deep research'));
    }

    runAutonomyAfterChat({
      userId,
      runtimeContext: autonomyRuntime,
      messages,
      assistantResponse: result.report,
      latencyMs: Date.now() - requestStartTime,
    }).catch(err => log.v1.warn({ err }, 'Autonomy after-chat learn failed'));

    clearTimeout(globalTimer);
    return true;
  } catch (err: unknown) {
    log.v1.error({ err }, 'Deep research failed');
    if (creditReservation) {
      refundReservation(creditReservation).catch((err2: unknown) => log.v1.error({ err: err2 }, 'refundReservation failed after deep research error'));
    }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({
        error: {
          message: sanitizeMessage((err as Error)?.message || 'Research failed.'),
          type: 'server_error',
          param: null,
          code: 'research_failed',
        },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    clearTimeout(globalTimer);
    return true;
  }
}
