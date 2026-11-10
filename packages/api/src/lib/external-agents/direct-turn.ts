import type { Request, Response } from 'express';
import { makeChunk } from '../streaming-helpers.js';
import { buildCompletionResponse } from '../chat/response-shapes.js';
import type { SSEWriter } from '../chat/sse-writer.js';
import { saveConversationResult, type LifecycleContext } from '../chat-lifecycle.js';
import { externalHistoryOf } from './history.js';
import { runExternalAgentTurn } from './turn.js';

/**
 * Serves a direct (1:1) chat turn with an external agent (ADR 0028): the same OpenAI-shaped stream
 * the app already renders, with the deltas coming from the person's daemon instead of a model.
 *
 * Nothing is charged — the caller leaves the credit reservation unsettled and the handler's release
 * point refunds it. Returns true when an answer was delivered and stored.
 */
export async function serveExternalDirectTurn(input: {
  req: Request;
  res: Response;
  sse: SSEWriter;
  requestId: string;
  modelId: string;
  stream: boolean;
  agentId: string;
  messages: readonly { role: string; content?: unknown }[];
  lifecycle: LifecycleContext;
  signal: AbortSignal;
  /** Called once, just before the stream ends, to settle the coordinated agent turn. */
  beforeFinish?: () => Promise<void>;
}): Promise<boolean> {
  const { res, sse, requestId, modelId } = input;
  const { task, history } = externalHistoryOf(input.messages);

  if (input.stream) {
    sse.ensureHeaders();
    sse.startKeepAlive();
    res.write(
      `data: ${JSON.stringify(makeChunk(requestId, modelId, [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]))}\n\n`,
    );
  }

  const result = await runExternalAgentTurn({
    agentId: input.agentId,
    task,
    history,
    signal: input.signal,
    ...(input.stream
      ? {
          onTextDelta: (text: string) => {
            if (res.writableEnded) return;
            res.write(
              `data: ${JSON.stringify(makeChunk(requestId, modelId, [{ index: 0, delta: { content: text }, finish_reason: null }]))}\n\n`,
            );
          },
        }
      : {}),
  });
  sse.stopKeepAlive();

  if (result.error !== undefined || result.response.trim() === '') {
    const error = {
      message: result.error ?? 'The external agent returned no answer',
      type: 'server_error',
      code: 'agent_unavailable',
      retryable: true,
    };
    if (sse.sent) sse.writeError(error);
    else res.status(503).json({ error });
    return false;
  }

  await input.beforeFinish?.();
  await saveConversationResult(input.lifecycle, result.response);

  if (input.stream) {
    res.write(
      `data: ${JSON.stringify(makeChunk(requestId, modelId, [{ index: 0, delta: {}, finish_reason: 'stop' }]))}\n\n`,
    );
    sse.done();
  } else {
    res.json(
      buildCompletionResponse({
        requestId,
        model: modelId,
        content: result.response,
        finishReason: 'stop',
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        aliaUsage: {
          system_prompt_tokens: 0,
          billable_tokens: 0,
          credits_charged: 0,
          credits_remaining: 0,
          credit_warning: null,
        },
      }),
    );
  }
  return true;
}
