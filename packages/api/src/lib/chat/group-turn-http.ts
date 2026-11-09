/**
 * The HTTP side of a group turn: the request that reaches `POST /v1/chat/completions` for a
 * conversation that is a group, answered by `runGroupTurn` instead of by Alia.
 *
 * It is answered as a stream and only as a stream (a group's replies arrive one member at a time,
 * which is what a stream is for), and only for the person's own session: each member's turn is
 * funded by, and reads the apps of, that person (`AgentTurnPerson`).
 */

import type { Request, Response } from 'express';
import { appSurfaceOf } from '../app-surface.js';
import { saveConversation } from '../conversation-saver.js';
import { createResponseSSEEmitter } from '../sse-emitter.js';
import { log } from '../logger.js';
import { type GroupInputMessage, type GroupReply, runGroupTurn } from './group-turn.js';
import type { SSEWriter } from './sse-writer.js';

type SaveParams = Parameters<typeof saveConversation>[0];

/** Why a request cannot be a group turn, as the OpenAI-shaped error body. */
function refusal(res: Response, message: string, param: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', param, code: null } });
}

/**
 * Serve one group turn. Resolves with the replies that completed (empty when nobody could answer,
 * in which case nothing is stored and the caller ends the turn with a typed failure), or `null`
 * when the request was refused before a stream opened.
 */
export async function serveGroupTurn(input: {
  readonly req: Request;
  readonly res: Response;
  readonly sse: SSEWriter;
  readonly userId: string;
  readonly conversationId: string;
  readonly memberAgentIds: readonly string[];
  readonly requestId: string;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}): Promise<GroupReply[] | null> {
  const { req, res, sse, userId, conversationId, memberAgentIds } = input;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.stream !== true) {
    refusal(res, 'A group conversation is answered as a stream: send stream: true.', 'stream');
    return null;
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    refusal(res, 'messages must be a non-empty array.', 'messages');
    return null;
  }
  const history = messages.filter(
    (message): message is GroupInputMessage =>
      typeof message === 'object' &&
      message !== null &&
      typeof (message as { role?: unknown }).role === 'string',
  );
  if (history.at(-1)?.role !== 'user') {
    refusal(res, 'The last message of a group turn must be the person’s own.', 'messages');
    return null;
  }

  sse.ensureHeaders();
  const emitter = createResponseSSEEmitter(res, sse.ensureHeaders);
  emitter.emit('alia.group_turn', {
    eventVersion: 1,
    conversationId,
    agentIds: memberAgentIds,
  });

  const replies = await runGroupTurn({
    memberAgentIds,
    person: {
      oxyUserId: userId,
      ...(req.accessToken ? { accessToken: req.accessToken } : {}),
      isDirectSession: true,
      surfaceApplicationId: await appSurfaceOf(req),
    },
    messages: history,
    emitter,
    startedAt: input.startedAt,
    signal: input.signal,
  });
  if (replies.length === 0) return replies;

  const assistantMessageId =
    typeof body.assistantMessageId === 'string' ? body.assistantMessageId : undefined;
  try {
    await saveConversation({
      userId,
      conversationId,
      messages: history as unknown as SaveParams['messages'],
      assistantResponse: '',
      omitLeadReply: true,
      agentMessages: replies.map((reply) => ({ ...reply })),
      ...(assistantMessageId === undefined ? {} : { assistantMessageId }),
    });
  } catch (error: unknown) {
    // The replies were streamed and paid for; losing them from storage is reported, not hidden.
    log.v1.error({ err: error, conversationId }, 'Error saving a group conversation');
  }

  res.write(
    `data: ${JSON.stringify({
      id: input.requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'alia',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
  );
  sse.done();
  return replies;
}
