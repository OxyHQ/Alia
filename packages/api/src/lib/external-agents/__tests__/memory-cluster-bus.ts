import type { ClusterBus } from '../cluster.js';

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
