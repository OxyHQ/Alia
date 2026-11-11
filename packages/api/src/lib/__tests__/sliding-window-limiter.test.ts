import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ redis: null as null | { eval: ReturnType<typeof vi.fn> } }));

vi.mock('../redis.js', () => ({
  getRedisClient: () => H.redis,
  withRedisTimeout: <T>(p: Promise<T>) => p,
}));

import { checkWindowLimit, resetLocalWindows } from '../sliding-window-limiter.js';

describe('sliding window limiter', () => {
  beforeEach(() => {
    H.redis = { eval: vi.fn() };
    resetLocalWindows();
  });

  it('decides in ONE atomic script call and maps its reply', async () => {
    H.redis?.eval.mockResolvedValueOnce([1, 3, 0]);
    expect(await checkWindowLimit('k', 5, { onUnavailable: 'open' })).toEqual({ allowed: true });
    expect(H.redis?.eval).toHaveBeenCalledTimes(1);

    H.redis?.eval.mockResolvedValueOnce([0, 5, Date.now() - 30_000]);
    const refused = await checkWindowLimit('k', 5, { onUnavailable: 'open' });
    expect(refused).toMatchObject({ allowed: false, current: 5, limit: 5 });
    expect(refused.resetInSeconds).toBeGreaterThan(0);
    expect(H.redis?.eval).toHaveBeenCalledTimes(2);
  });

  it('fails open when asked to, on a missing or throwing Redis', async () => {
    H.redis?.eval.mockRejectedValueOnce(new Error('down'));
    expect((await checkWindowLimit('k', 1, { onUnavailable: 'open' })).allowed).toBe(true);
    H.redis = null;
    expect((await checkWindowLimit('k', 1, { onUnavailable: 'open' })).allowed).toBe(true);
  });

  it('degrades to a bounded local window when asked to, instead of no limit', async () => {
    H.redis?.eval.mockRejectedValue(new Error('down'));
    expect((await checkWindowLimit('k', 2, { onUnavailable: 'local' })).allowed).toBe(true);
    expect((await checkWindowLimit('k', 2, { onUnavailable: 'local' })).allowed).toBe(true);
    expect((await checkWindowLimit('k', 2, { onUnavailable: 'local' })).allowed).toBe(false);
    H.redis = null;
    expect((await checkWindowLimit('k', 2, { onUnavailable: 'local' })).allowed).toBe(false);
  });
});
