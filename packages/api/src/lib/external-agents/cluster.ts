/**
 * How an external agent's turns cross API instances (ADR 0028).
 *
 * A daemon holds its WebSocket on ONE instance, but a turn can start on any of them (a room worker,
 * another request). With Redis, the instance that holds the socket announces it (a presence key
 * with a TTL) and listens for commands on `alia:xagent:cmd:<agentId>`; the instance that needs a
 * turn publishes there and listens for the events on `alia:xagent:evt:<turnId>`. Without Redis the
 * bus is `null` and only the local socket can answer, which is correct for one instance.
 */

import type Redis from 'ioredis';
import { log } from '../logger.js';
import { getRedisClient, getRedisSubClient } from '../redis.js';

export const CMD_PREFIX = 'alia:xagent:cmd:';
export const EVT_PREFIX = 'alia:xagent:evt:';
const PRESENCE_PREFIX = 'alia:xagent:online:';

/** How long a presence key outlives its last refresh (the relay refreshes every heartbeat, 25 s). */
export const PRESENCE_TTL_SECONDS = 90;

export interface ClusterBus {
  publish(channel: string, payload: string): Promise<void>;
  /** Resolves once the subscription is live, so nothing published afterwards is missed. */
  subscribe(channel: string, handler: (payload: string) => void): Promise<() => void>;
  /** Every channel that starts with `prefix`. */
  subscribePrefix(
    prefix: string,
    handler: (channel: string, payload: string) => void,
  ): Promise<() => void>;
  setPresence(agentId: string): Promise<void>;
  clearPresence(agentId: string): Promise<void>;
  hasPresence(agentId: string): Promise<boolean>;
}

/** Process-local bus. Two relays sharing one instance of it behave like two instances sharing Redis. */
export function createMemoryClusterBus(): ClusterBus {
  const exact = new Map<string, Set<(payload: string) => void>>();
  const prefixed = new Set<{
    prefix: string;
    handler: (channel: string, payload: string) => void;
  }>();
  const present = new Set<string>();
  return {
    async publish(channel, payload) {
      queueMicrotask(() => {
        for (const handler of exact.get(channel) ?? []) handler(payload);
        for (const sub of prefixed) {
          if (channel.startsWith(sub.prefix)) sub.handler(channel, payload);
        }
      });
    },
    async subscribe(channel, handler) {
      const set = exact.get(channel) ?? new Set();
      exact.set(channel, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    async subscribePrefix(prefix, handler) {
      const sub = { prefix, handler };
      prefixed.add(sub);
      return () => {
        prefixed.delete(sub);
      };
    },
    async setPresence(agentId) {
      present.add(agentId);
    },
    async clearPresence(agentId) {
      present.delete(agentId);
    },
    async hasPresence(agentId) {
      return present.has(agentId);
    },
  };
}

export function createRedisClusterBus(publisher: Redis, subscriber: Redis): ClusterBus {
  const exact = new Map<string, Set<(payload: string) => void>>();
  const prefixed = new Map<string, Set<(channel: string, payload: string) => void>>();

  subscriber.on('message', (channel: string, payload: string) => {
    for (const handler of exact.get(channel) ?? []) handler(payload);
  });
  subscriber.on('pmessage', (pattern: string, channel: string, payload: string) => {
    for (const handler of prefixed.get(pattern) ?? []) handler(channel, payload);
  });

  return {
    async publish(channel, payload) {
      await publisher.publish(channel, payload);
    },
    async subscribe(channel, handler) {
      let set = exact.get(channel);
      if (!set) {
        set = new Set();
        exact.set(channel, set);
        await subscriber.subscribe(channel);
      }
      set.add(handler);
      return () => {
        const current = exact.get(channel);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          exact.delete(channel);
          subscriber.unsubscribe(channel).catch(() => undefined);
        }
      };
    },
    async subscribePrefix(prefix, handler) {
      const pattern = `${prefix}*`;
      let set = prefixed.get(pattern);
      if (!set) {
        set = new Set();
        prefixed.set(pattern, set);
        await subscriber.psubscribe(pattern);
      }
      set.add(handler);
      return () => {
        const current = prefixed.get(pattern);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          prefixed.delete(pattern);
          subscriber.punsubscribe(pattern).catch(() => undefined);
        }
      };
    },
    async setPresence(agentId) {
      await publisher.set(`${PRESENCE_PREFIX}${agentId}`, '1', 'EX', PRESENCE_TTL_SECONDS);
    },
    async clearPresence(agentId) {
      await publisher.del(`${PRESENCE_PREFIX}${agentId}`);
    },
    async hasPresence(agentId) {
      return (await publisher.exists(`${PRESENCE_PREFIX}${agentId}`)) === 1;
    },
  };
}

let shared: ClusterBus | null | undefined;

/** The process's bus: Redis when `REDIS_URL` is set, else `null` (one instance). */
export function getClusterBus(): ClusterBus | null {
  if (shared !== undefined) return shared;
  const publisher = getRedisClient();
  const subscriber = getRedisSubClient();
  shared = publisher && subscriber ? createRedisClusterBus(publisher, subscriber) : null;
  if (shared === null)
    log.general.info('External agents: no Redis, serving from this instance only');
  return shared;
}
