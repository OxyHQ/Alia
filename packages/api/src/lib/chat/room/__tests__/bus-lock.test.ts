import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { type RoomEvent, createInMemoryRoomBus, createRedisRoomBus } from '../bus.js';
import { createLocalRoomLock, createRedisRoomLock } from '../lock.js';

const event = (over: Partial<RoomEvent> = {}): RoomEvent => ({
  userId: 'u',
  conversationId: 'c',
  chainId: 'p1',
  event: 'alia.agent_delta',
  data: { content: 'hi' },
  ...over,
});

describe('in-memory bus', () => {
  it('delivers to the subscribers of that conversation only, until they leave', async () => {
    const bus = createInMemoryRoomBus();
    const mine: RoomEvent[] = [];
    const other: RoomEvent[] = [];
    const off = bus.subscribe('u', 'c', (e) => mine.push(e));
    bus.subscribe('u', 'other', (e) => other.push(e));
    await bus.publish(event());
    off();
    await bus.publish(event());
    expect(mine).toHaveLength(1);
    expect(other).toEqual([]);
  });

  it('a throwing subscriber does not stop the others', async () => {
    const bus = createInMemoryRoomBus();
    const seen: RoomEvent[] = [];
    bus.subscribe('u', 'c', () => {
      throw new Error('bad subscriber');
    });
    bus.subscribe('u', 'c', (e) => seen.push(e));
    await bus.publish(event());
    expect(seen).toHaveLength(1);
  });
});

/** Two ioredis-shaped doubles sharing one "server": publish on one reaches subscribe on the other. */
function fakeRedisPair() {
  const subscriber = new EventEmitter() as EventEmitter & {
    subscribed: Set<string>;
    subscribe: (c: string) => Promise<void>;
    unsubscribe: (c: string) => Promise<void>;
  };
  subscriber.subscribed = new Set();
  subscriber.subscribe = async (c) => {
    subscriber.subscribed.add(c);
  };
  subscriber.unsubscribe = async (c) => {
    subscriber.subscribed.delete(c);
  };
  const publisher = {
    fail: false,
    publish: async (channel: string, payload: string) => {
      if (publisher.fail) throw new Error('redis down');
      if (subscriber.subscribed.has(channel)) subscriber.emit('message', channel, payload);
      return 1;
    },
  };
  return { publisher, subscriber };
}

describe('redis bus', () => {
  it('carries events over pub/sub and releases the channel with the last subscriber', async () => {
    const { publisher, subscriber } = fakeRedisPair();
    const bus = createRedisRoomBus(publisher as unknown as Redis, subscriber as unknown as Redis);
    const seen: RoomEvent[] = [];
    const off = bus.subscribe('u', 'c', (e) => seen.push(e));
    expect(subscriber.subscribed.size).toBe(1);
    await bus.publish(event());
    expect(seen).toEqual([event()]);
    off();
    expect(subscriber.subscribed.size).toBe(0);
  });

  it('delivers locally when publishing fails, so one instance still sees its own room', async () => {
    const { publisher, subscriber } = fakeRedisPair();
    const bus = createRedisRoomBus(publisher as unknown as Redis, subscriber as unknown as Redis);
    const seen: RoomEvent[] = [];
    bus.subscribe('u', 'c', (e) => seen.push(e));
    publisher.fail = true;
    await bus.publish(event());
    expect(seen).toHaveLength(1);
  });
});

describe('room locks', () => {
  it('the local lock runs waiters of one room one at a time and in arrival order', async () => {
    const lock = createLocalRoomLock();
    const order: string[] = [];
    let active = 0;
    const job = (name: string, ms: number) =>
      lock.run('room', async () => {
        active += 1;
        expect(active).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(name);
        active -= 1;
      });
    await Promise.all([job('a', 20), job('b', 1), job('c', 1)]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a failing holder releases the room', async () => {
    const lock = createLocalRoomLock();
    await expect(
      lock.run('room', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    await expect(lock.run('room', async () => 'next')).resolves.toBe('next');
  });

  it('the redis lock holds one lease per room across lockers and releases only its own token', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: async (key: string, token: string, _px: string, _ms: number, _nx: string) => {
        if (store.has(key)) return null;
        store.set(key, token);
        return 'OK';
      },
      eval: async (script: string, _n: number, key: string, token: string) => {
        if (store.get(key) !== token) return 0;
        if (script.includes('del')) store.delete(key);
        return 1;
      },
    } as unknown as Redis;
    // Two instances: each has its OWN local lock, so only Redis can serialize them.
    const one = createRedisRoomLock(redis, createLocalRoomLock());
    const two = createRedisRoomLock(redis, createLocalRoomLock());
    let active = 0;
    let max = 0;
    const work = async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 300));
      active -= 1;
    };
    await Promise.all([one.run('room', work), two.run('room', work)]);
    expect(max).toBe(1);
    expect(store.size).toBe(0);
  });
});
