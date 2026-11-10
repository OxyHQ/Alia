/**
 * The Redis cluster bus against a real Redis (`REDIS_TEST_URL`): two "instances" with their own
 * connections see each other's presence, commands and events. Skipped when no Redis is given.
 */
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisClusterBus, type ClusterBus } from '../cluster.js';

const url = process.env.REDIS_TEST_URL;

describe.skipIf(!url)('redis cluster bus', () => {
  const clients: Redis[] = [];
  let a: ClusterBus;
  let b: ClusterBus;

  beforeAll(() => {
    const make = () => {
      const client = new Redis(url as string);
      clients.push(client);
      return client;
    };
    a = createRedisClusterBus(make(), make());
    b = createRedisClusterBus(make(), make());
  });
  afterAll(() => {
    for (const client of clients) client.disconnect();
  });

  it('shares presence between instances and clears it', async () => {
    expect(await b.hasPresence('rx-agent')).toBe(false);
    await a.setPresence('rx-agent');
    expect(await b.hasPresence('rx-agent')).toBe(true);
    await a.clearPresence('rx-agent');
    expect(await b.hasPresence('rx-agent')).toBe(false);
  });

  it('delivers a prefixed command to the other instance and an exact event back', async () => {
    const commands: [string, string][] = [];
    const stopCommands = await a.subscribePrefix('rx:cmd:', (channel, payload) =>
      commands.push([channel, payload]),
    );
    const events: string[] = [];
    const stopEvents = await b.subscribe('rx:evt:t1', (payload) => events.push(payload));

    await b.publish('rx:cmd:agent-9', '{"kind":"turn"}');
    await a.publish('rx:evt:t1', '{"type":"ack"}');
    const deadline = Date.now() + 2000;
    while ((commands.length === 0 || events.length === 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(commands).toEqual([['rx:cmd:agent-9', '{"kind":"turn"}']]);
    expect(events).toEqual(['{"type":"ack"}']);

    stopCommands();
    stopEvents();
    await b.publish('rx:cmd:agent-9', 'again');
    await new Promise((r) => setTimeout(r, 50));
    expect(commands).toHaveLength(1);
  });
});
