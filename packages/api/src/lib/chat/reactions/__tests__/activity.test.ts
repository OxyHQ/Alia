import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ mark: vi.fn(), clear: vi.fn() }));
vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../../db/chat/reactionRepository.js', () => ({
  markConversationActivity: h.mark,
  clearConversationActivity: h.clear,
  isConversationActive: vi.fn(),
}));
const { holdConversationActivity } = await import('../../activity.js');
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.mark.mockResolvedValue(undefined);
  h.clear.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());
describe('durable activity renewal', () => {
  it('renews beyond the crash TTL, then clears only after the last renewal', async () => {
    const lost = vi.fn();
    const stop = await holdConversationActivity('person', 'room', 'turn', lost);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(h.mark).toHaveBeenCalledTimes(33);
    expect(h.clear).not.toHaveBeenCalled();
    await stop();
    expect(h.clear).toHaveBeenCalledWith({}, 'person', 'room', 'turn');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.mark).toHaveBeenCalledTimes(33);
    expect(lost).not.toHaveBeenCalled();
  });
  it('does not let a late renewal resurrect an ended turn', async () => {
    const stop = await holdConversationActivity('person', 'room', 'turn', vi.fn());
    let release!: () => void;
    h.mark.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = stop();
    expect(h.clear).not.toHaveBeenCalled();
    release();
    await stopped;
    expect(h.clear).toHaveBeenCalledTimes(1);
  });
  it('cancels inference on renewal failure and leaves activity between room phases', async () => {
    const lost = vi.fn();
    const stop = await holdConversationActivity('person', 'room', 'chain', lost, {
      clearOnStop: false,
    });
    h.mark.mockRejectedValueOnce(new Error('database unavailable'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lost).toHaveBeenCalledTimes(1);
    await stop();
    expect(h.clear).not.toHaveBeenCalled();
  });
});
