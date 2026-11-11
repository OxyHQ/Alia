/**
 * The room event bus: how what a member does in a room reaches whoever is watching it (ADR 0025).
 *
 * A room's worker publishes; anything that wants to see the room subscribes — the HTTP request that
 * started the chain (it forwards the events as the SSE frames it always sent) and, through
 * {@link publishRoomEvent}, the person's sockets. They may be on different instances than the
 * worker, so with Redis the bus is Redis pub/sub on the existing clients; without it, a process-local
 * emitter. Delivery is at-most-once and best effort: the stored message is the record, an event only
 * makes it live.
 */

import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import { log } from '../../logger.js';
import { getRedisClient, getRedisSubClient } from '../../redis.js';

/** The event names a room publishes (`alia.agent_*` are the frames `docs/agent-embedding.md` §4 defines). */
type RoomEventName =
  | 'alia.agent_start'
  | 'alia.agent_delta'
  | 'alia.agent_tool'
  | 'alia.agent_end'
  /** A member's reply was stored: `{ message }`. */
  | 'group.message'
  /** The chain is over (or skipped): `{ reason }`. */
  | 'group.idle';

export interface RoomEvent {
  readonly userId: string;
  readonly conversationId: string;
  /** The person message the chain answers (its row id); lets a subscriber ignore other chains. */
  readonly chainId: string;
  readonly event: RoomEventName;
  /** The frame body, without `eventVersion`. */
  readonly data: Record<string, unknown>;
}

type RoomEventHandler = (event: RoomEvent) => void;

export interface RoomBus {
  publish(event: RoomEvent): Promise<void>;
  /** Calls `handler` for every event of one person's conversation until the returned function runs. */
  subscribe(userId: string, conversationId: string, handler: RoomEventHandler): () => void;
}

const channelOf = (userId: string, conversationId: string) =>
  `alia:group-room:${userId}:${conversationId}`;

function deliver(handlers: Iterable<RoomEventHandler>, event: RoomEvent): void {
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (err: unknown) {
      log.general.warn({ err, event: event.event }, 'A room event subscriber threw');
    }
  }
}

/** Process-local bus: the no-Redis fallback, and the bus tests run on. */
export function createInMemoryRoomBus(): RoomBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    async publish(event) {
      emitter.emit(channelOf(event.userId, event.conversationId), event);
    },
    subscribe(userId, conversationId, handler) {
      const channel = channelOf(userId, conversationId);
      const listener = (event: RoomEvent) => deliver([handler], event);
      emitter.on(channel, listener);
      return () => emitter.off(channel, listener);
    },
  };
}

/**
 * Redis pub/sub bus. One subscriber connection serves every channel of the process: a channel is
 * subscribed while it has a handler and released with the last one. A publish that fails is
 * delivered to this process's own subscribers instead, so a Redis blip degrades to "only the
 * instance that ran the worker sees it live" rather than to silence.
 */
export function createRedisRoomBus(publisher: Redis, subscriber: Redis): RoomBus {
  const handlers = new Map<string, Set<RoomEventHandler>>();
  subscriber.on('message', (channel: string, payload: string) => {
    const set = handlers.get(channel);
    if (!set) return;
    try {
      deliver(set, JSON.parse(payload) as RoomEvent);
    } catch (err: unknown) {
      log.general.warn({ err, channel }, 'Could not read a room event');
    }
  });
  return {
    async publish(event) {
      const channel = channelOf(event.userId, event.conversationId);
      try {
        await publisher.publish(channel, JSON.stringify(event));
      } catch (err: unknown) {
        log.general.warn({ err, channel }, 'Could not publish a room event; delivering locally');
        const set = handlers.get(channel);
        if (set) deliver(set, event);
      }
    },
    subscribe(userId, conversationId, handler) {
      const channel = channelOf(userId, conversationId);
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        subscriber.subscribe(channel).catch((err: unknown) => {
          log.general.warn({ err, channel }, 'Could not subscribe to a room channel');
        });
      }
      set.add(handler);
      return () => {
        const current = handlers.get(channel);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          handlers.delete(channel);
          subscriber.unsubscribe(channel).catch(() => undefined);
        }
      };
    },
  };
}

let shared: RoomBus | null = null;

/** The process's bus: Redis when `REDIS_URL` is set, else in-process. */
export function getRoomBus(): RoomBus {
  if (shared) return shared;
  const publisher = getRedisClient();
  const subscriber = getRedisSubClient();
  shared =
    publisher && subscriber ? createRedisRoomBus(publisher, subscriber) : createInMemoryRoomBus();
  return shared;
}

/**
 * Publish a room event to everyone watching: the bus (for the request that started the chain, on
 * any instance) and the person's sockets, scoped by `conversationId`. The socket room is reached
 * through the Socket.IO Redis adapter, so one emit serves every instance.
 *
 * `group:event` is the socket event for Phase 2 clients: `{ conversationId, chainId, event, data }`.
 */
export async function publishRoomEvent(event: RoomEvent): Promise<void> {
  await getRoomBus().publish(event);
  try {
    const { getIO } = await import('../../../socket.js');
    getIO()?.to(`user:${event.userId}`).emit('group:event', {
      conversationId: event.conversationId,
      chainId: event.chainId,
      event: event.event,
      data: event.data,
    });
  } catch (err: unknown) {
    log.general.warn({ err, event: event.event }, 'Could not push a room event to sockets');
  }
}
