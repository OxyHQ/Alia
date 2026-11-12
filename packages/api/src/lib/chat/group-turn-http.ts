/**
 * A group request subscribes to its durable room. It waits for the chain to become idle or its
 * HTTP budget to expire; the number of speakers is decided by the room, never by a first round.
 * Deliberate silence is successful. Inference/authority failures stay typed failures even after
 * partial answers. After the request ends, room events continue over the existing socket bus.
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

/** What the request observed of the room chain. */
export interface GroupServeOutcome {
  /** Replies that completed while the request was open. */
  readonly completed: number;
  /** Whether the chain ended before the request did (otherwise the room is still answering). */
  readonly settled: boolean;
  /** Deliberate silence is successful; failures must still go through failTurn. */
  readonly status: 'completed' | 'quiet' | 'continuing' | 'failed';
}

/** Failed outcomes leave the stream open for the route's failTurn; other outcomes finish it. */
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
  if (input.signal.aborted) {
    await room.abandon();
    throw input.signal.reason ?? new Error('Group request aborted before queueing');
  }

  let completed = 0;
  let settled = true;
  let status: GroupServeOutcome['status'] = 'failed';
  if (room.ready) {
    const watched = watchRoom({
      bus: deps.bus,
      userId,
      conversationId,
      chainId: room.chainId,
      remainingMs: GROUP_REQUEST_BUDGET_MS - (Date.now() - input.startedAt),
      signal: input.signal,
      emit,
      // Subscribed before the first step is queued, so no event of it is missed.
      begin: () => room.start(),
    });
    try {
      ({ completed, settled, status } = await watched);
    } catch (error: unknown) {
      await room.abandon();
      throw error;
    }
  }

  // Failure is independent of whether earlier members produced text.
  if (status === 'failed') return { completed, settled, status };

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
  return { completed, settled, status };
}

/**
 * Forward a chain's events as SSE frames until the chain ends, the budget is
 * spent or the client leaves.
 *
 * A member that declines is invisible: its `agent_start` is held until the member shows it is
 * answering (a delta, a tool call or its end), and dropped with its `declined` end. A member whose
 * turn is still running when the request ends is closed with a typed `room_continues` end so a
 * client never waits on it; its reply still lands in the room.
 */
function watchRoom(input: {
  readonly bus: RoomBus;
  readonly userId: string;
  readonly conversationId: string;
  readonly chainId: string;
  readonly remainingMs: number;
  readonly signal: AbortSignal;
  readonly emit: (event: string, data: Record<string, unknown>) => void;
  readonly begin: () => Promise<void>;
}): Promise<GroupServeOutcome> {
  return new Promise((resolve, reject) => {
    const heldStarts = new Map<string, Record<string, unknown>>();
    const open = new Set<string>();
    let failed = false;
    let completed = 0;
    let done = false;
    let begun = false;
    let pendingFinish: { settled: boolean; reason?: unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (settled: boolean, reason?: unknown) => {
      if (done) return;
      if (!begun) {
        pendingFinish = { settled, reason };
        return;
      }
      done = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      for (const consultId of open) {
        input.emit('alia.agent_end', {
          consultId,
          status: 'failed',
          error: {
            code:
              reason === 'superseded'
                ? 'agent_declined'
                : settled
                  ? 'room_failed'
                  : 'room_continues',
          },
        });
      }
      const status: GroupServeOutcome['status'] = failed
        ? 'failed'
        : !settled
          ? 'continuing'
          : reason !== 'done' && reason !== 'superseded'
            ? 'failed'
            : completed > 0
              ? 'completed'
              : 'quiet';
      resolve({ completed, settled, status });
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
      if (done || pendingFinish?.settled || event.chainId !== input.chainId) return;
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
          if (event.data.status === 'failed') failed = true;
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
          return;
        }
        case 'group.idle':
          finish(true, event.data.reason);
          return;
        default:
          return;
      }
    };

    const unsubscribe = input.bus.subscribe(input.userId, input.conversationId, onEvent);
    if (input.signal.aborted) {
      unsubscribe();
      reject(input.signal.reason ?? new Error('Group request aborted before queueing'));
      return;
    }
    input.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(false), Math.max(input.remainingMs, 0));
    input
      .begin()
      .then(() => {
        begun = true;
        if (pendingFinish) finish(pendingFinish.settled, pendingFinish.reason);
      })
      .catch((error: unknown) => {
        done = true;
        unsubscribe();
        if (timer) clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        reject(error);
      });
  });
}
