import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactionEvent } from '../../../../db/chat/reactionRepository.js';
vi.mock('../runtime.js', () => ({ runReactionEvent: vi.fn() }));
vi.mock('../../room/bus.js', () => ({ publishRoomEvent: vi.fn() }));
const { ReactionDispatcher } = await import('../dispatcher.js');
const event = {
  id: 'event',
  createdAt: new Date(),
  leaseToken: 'lease',
  attempts: 1,
} as ReactionEvent;
const setup = () => {
  const deps = {
    claim: vi.fn(async () => [event]),
    renew: vi.fn(async () => true),
    process: vi.fn(async (_event: ReactionEvent, _valid: () => boolean) => 'completed' as const),
    finish: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    failed: vi.fn(async () => undefined),
  };
  return { deps, worker: new ReactionDispatcher(deps) };
};
afterEach(() => vi.useRealTimers());
describe('durable reaction dispatcher', () => {
  it('completes only its claimed token and retries admission deferral without reporting failure', async () => {
    const h = setup();
    await h.worker.tick();
    expect(h.deps.finish).toHaveBeenCalledWith(event, 'completed');
    h.deps.process.mockResolvedValueOnce('deferred' as never);
    await h.worker.tick();
    expect(h.deps.retry).toHaveBeenCalledWith(event, 2000, true);
    expect(h.deps.failed).not.toHaveBeenCalled();
  });
  it('retries infrastructure failure and exposes exhausted work as a typed room failure', async () => {
    const h = setup();
    h.deps.process.mockRejectedValue(new Error('private upstream body'));
    await h.worker.tick();
    expect(h.deps.retry).toHaveBeenCalledWith(event, 2000);
    h.deps.claim.mockResolvedValue([{ ...event, attempts: 3 }]);
    await h.worker.tick();
    expect(h.deps.failed).toHaveBeenCalledWith(expect.objectContaining({ id: 'event' }));
    expect(h.deps.finish).toHaveBeenCalledWith(expect.objectContaining({ id: 'event' }), 'failed');
  });
  it('a lost lease cannot finalize work another instance may own', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.deps.renew.mockResolvedValue(false);
    let release!: () => void;
    let valid!: () => boolean;
    h.deps.process.mockImplementation(async (_, leaseValid) => {
      valid = leaseValid;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'completed';
    });
    const work = h.worker.tick();
    await vi.advanceTimersByTimeAsync(10000);
    expect(valid()).toBe(false);
    release();
    await work;
    expect(h.deps.finish).not.toHaveBeenCalled();
    expect(h.deps.retry).not.toHaveBeenCalled();
  });
  it('shutdown drains the current claim and never overlaps poll batches', async () => {
    vi.useFakeTimers();
    const h = setup();
    let release!: () => void;
    h.deps.process.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'completed';
    });
    h.worker.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.deps.claim).toHaveBeenCalledTimes(1);
    const stopped = h.worker.stop();
    release();
    await stopped;
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.deps.claim).toHaveBeenCalledTimes(1);
  });
});
