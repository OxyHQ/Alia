import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomJobData } from '../engine.js';

const h = vi.hoisted(() => ({
  queues: new Map<string, { add: ReturnType<typeof vi.fn>; options: Record<string, unknown> }>(),
  workers: [] as string[],
  process: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn(async () => undefined);
    constructor(name: string, options: Record<string, unknown>) {
      h.queues.set(name, { add: this.add, options });
    }
    async waitUntilReady() {}
    async close() {}
  },
  Worker: class {
    constructor(name: string) {
      h.workers.push(name);
    }
    on() {}
    async close() {}
  },
}));
vi.mock('../../../redis.js', () => ({ getRedisConnection: () => ({}) }));
vi.mock('../runtime.js', () => ({
  roomRuntime: () => ({ processStep: h.process, abandon: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn() }, agents: { info: vi.fn(), error: vi.fn() } },
}));
const { initRoomQueue, startRoomWorker, enqueueRoomJob, shutdownRoomQueue, jobIdOf } = await import(
  '../queue.js'
);
const base: RoomJobData = {
  userId: 'u',
  conversationId: 'room',
  triggerId: 'trigger',
  roster: [],
  speakerId: '',
  handedByAgentId: null,
  pending: [],
  depth: 0,
  replies: 0,
  turns: 0,
  lastSpeakerId: null,
  surfaceApplicationId: null,
};

beforeEach(async () => {
  h.queues.clear();
  h.workers.length = 0;
  h.process.mockClear();
  await initRoomQueue();
});
afterEach(() => shutdownRoomQueue());

describe('versioned room queue isolation', () => {
  it('new selections and legacy drain steps use separate queues with bounded retention', async () => {
    await startRoomWorker();
    await enqueueRoomJob({ ...base, version: 2, phase: 'select' });
    await enqueueRoomJob(base);
    expect(h.workers).toEqual(['group-rooms-v2', 'group-rooms']);
    expect(h.queues.get('group-rooms-v2')?.add).toHaveBeenCalledOnce();
    expect(h.queues.get('group-rooms')?.add).toHaveBeenCalledOnce();
    expect(h.queues.get('group-rooms')?.options.defaultJobOptions).toMatchObject({
      attempts: 2,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 2000 },
    });
  });

  it('selection and speaking cannot consume one another’s deduplication key', () => {
    const selection = jobIdOf({ ...base, version: 2, phase: 'select' });
    const speaking = jobIdOf({ ...base, version: 2, phase: 'speak' });
    expect(selection).not.toBe(speaking);
    expect(selection).not.toBe(jobIdOf(base));
    expect(selection).toBe(jobIdOf({ ...base, version: 2, phase: 'select' }));
  });

  it('a lost Redis enqueue acknowledgement never executes a v2 turn locally', async () => {
    h.queues.get('group-rooms-v2')?.add.mockRejectedValue(new Error('lost acknowledgement'));
    await expect(enqueueRoomJob({ ...base, version: 2, phase: 'speak' })).rejects.toThrow(
      'lost acknowledgement',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.process).not.toHaveBeenCalled();
  });
});
