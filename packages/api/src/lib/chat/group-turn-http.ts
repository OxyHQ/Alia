/**
 * The HTTP side of a group turn: the request that reaches `POST /v1/chat/completions` for a
 * conversation that is a group.
 *
 * It no longer runs the members (ADR 0025). The room does, in a worker, past this request's end.
 * The request prepares the chain (the person's message is stored, the members they may reach are
 * checked, each member's authority is minted: `room/start.ts`), subscribes to the room's event bus,
 * queues the first step, and forwards the chain's events as the SSE frames it has always sent
 * (`alia.agent_start`, `agent_delta`, `agent_tool`, `agent_end`) until the FIRST ROUND settles —
 * every member the person's message asked has ended its turn — or the request's own limit nears.
 * Then it ends cleanly; whatever the room still has to say (a member answering another's `@mention`)
 * arrives on the person's sockets and in the stored conversation.
 *
 * It is answered as a stream and only as a stream, and only for the person's own session.
 */

import type { Request, Response } from 'express';
import { appSurfaceOf } from '../app-surface.js';
import { log } from '../logger.js';
import { createResponseSSEEmitter } from '../sse-emitter.js';
import { type RoomBus, type RoomEvent, getRoomBus } from './room/bus.js';
import { type PrepareRoom, prepareRoom } from './room/start.js';
import type { GroupInputMessage } from './room/transcript.js';
import type { SSEWriter } from './sse-writer.js';

/** The share of a request's 80 seconds a group may stay open, leaving the rest to end the stream. */
export const GROUP_REQUEST_BUDGET_MS = 70_000;

/** Why a request cannot be a group turn, as the OpenAI-shaped error body. */
function refusal(res: Response, message: string, param: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', param, code: null } });
}

export interface GroupHttpDeps {
  readonly bus: RoomBus;
  readonly prepareRoom: PrepareRoom;
}

const defaultDeps = (): GroupHttpDeps => ({ bus: getRoomBus(), prepareRoom });

/** What the request saw of the first round. */
export interface GroupServeOutcome {
  /** Replies that completed while the request was open. */
  readonly completed: number;
  /** Whether the first round ended before the request did (otherwise the room is still answering). */
  readonly settled: boolean;
}

/**
 * Serve one group turn. Resolves with what the request saw (when nobody could answer it is
 * `completed: 0, settled: true` and the stream is left open: the caller ends it with a typed failure), or `null` when
 * the request was refused before a stream opened.
 */
export async function serveGroupTurn(
  input: {
    readonly req: Request;
    readonly res: Response;
    readonly sse: SSEWriter;
    readonly userId: string;
    readonly conversationId: string;
    readonly memberAgentIds: readonly string[];
    readonly requestId: string;
    readonly startedAt: number;
    readonly signal: AbortSignal;
  },
  deps: GroupHttpDeps = defaultDeps(),
): Promise<GroupServeOutcome | null> {
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
  const emit = (event: string, data: Record<string, unknown>) => {
    try {
      emitter.emit(event, { eventVersion: 1, ...data });
    } catch (error: unknown) {
      log.general.warn({ err: error, event }, 'Could not emit a group turn event');
    }
  };
  emit('alia.group_turn', { conversationId, agentIds: memberAgentIds });

  const room = await deps.prepareRoom({
    userId,
    conversationId,
    memberAgentIds,
    messages: history,
    accessToken: req.accessToken,
    surfaceApplicationId: await appSurfaceOf(req),
  });
  for (const agentId of room.unreachableAgentIds) {
    emit('alia.agent_end', {
      consultId: `unreachable-${agentId}`,
      status: 'failed',
      error: { code: 'agent_unavailable' },
    });
  }

  let completed = 0;
  let settled = true;
  if (room.firstRoundSize > 0) {
    const watched = watchFirstRound({
      bus: deps.bus,
      userId,
      conversationId,
      chainId: room.chainId,
      firstRoundSize: room.firstRoundSize,
      remainingMs: GROUP_REQUEST_BUDGET_MS - (Date.now() - input.startedAt),
      signal: input.signal,
      emit,
      // Subscribed before the first step is queued, so no event of it is missed.
      begin: () => room.start(),
    });
    try {
      ({ completed, settled } = await watched);
    } catch (error: unknown) {
      await room.abandon();
      throw error;
    }
  }

  // Nobody answered and the round is over: the caller ends the stream with a typed failure instead.
  if (settled && completed === 0) return { completed, settled };

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
  return { completed, settled };
}

/**
 * Forward a chain's events as SSE frames until its first round ends, the chain ends, the budget is
 * spent or the client leaves.
 *
 * A member that declines is invisible: its `agent_start` is held until the member shows it is
 * answering (a delta, a tool call or its end), and dropped with its `declined` end. A member whose
 * turn is still running when the request ends is closed with a typed `room_continues` end so a
 * client never waits on it; its reply still lands in the room.
 */
function watchFirstRound(input: {
  readonly bus: RoomBus;
  readonly userId: string;
  readonly conversationId: string;
  readonly chainId: string;
  readonly firstRoundSize: number;
  readonly remainingMs: number;
  readonly signal: AbortSignal;
  readonly emit: (event: string, data: Record<string, unknown>) => void;
  readonly begin: () => Promise<void>;
}): Promise<{ completed: number; settled: boolean }> {
  return new Promise((resolve, reject) => {
    const heldStarts = new Map<string, Record<string, unknown>>();
    const open = new Set<string>();
    let ended = 0;
    let completed = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      for (const consultId of open) {
        input.emit('alia.agent_end', {
          consultId,
          status: 'failed',
          error: { code: 'room_continues' },
        });
      }
      resolve({ completed, settled });
    };
    const onAbort = () => finish(false);

    const release = (consultId: string) => {
      const start = heldStarts.get(consultId);
      if (!start) return;
      heldStarts.delete(consultId);
      open.add(consultId);
      input.emit('alia.agent_start', start);
    };

    const onEvent = (event: RoomEvent) => {
      if (done || event.chainId !== input.chainId) return;
      const consultId = typeof event.data.consultId === 'string' ? event.data.consultId : '';
      switch (event.event) {
        case 'alia.agent_start':
          heldStarts.set(consultId, event.data);
          return;
        case 'alia.agent_delta':
        case 'alia.agent_tool':
          release(consultId);
          input.emit(event.event, event.data);
          return;
        case 'alia.agent_end': {
          ended += 1;
          if (event.data.status === 'declined') {
            // Nothing was said: show nothing, unless the member already did something visible.
            heldStarts.delete(consultId);
            if (open.delete(consultId)) {
              input.emit('alia.agent_end', {
                consultId,
                status: 'failed',
                error: { code: 'agent_declined' },
              });
            }
          } else {
            // The start always precedes its end, even for a reply that arrived whole.
            release(consultId);
            open.delete(consultId);
            if (event.data.status === 'completed') completed += 1;
            input.emit('alia.agent_end', event.data);
          }
          if (ended >= input.firstRoundSize) finish(true);
          return;
        }
        case 'group.idle':
          finish(true);
          return;
        default:
          return;
      }
    };

    const unsubscribe = input.bus.subscribe(input.userId, input.conversationId, onEvent);
    if (input.signal.aborted) return finish(false);
    input.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(false), Math.max(input.remainingMs, 0));
    input.begin().catch((error: unknown) => {
      done = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}
