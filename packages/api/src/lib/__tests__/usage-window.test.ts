import { beforeEach, describe, expect, it, vi } from 'vitest';

const spend = vi.hoisted(() => ({ used: 0, oldest: null as Date | null }));
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../db/telemetry/apiKeyUsageRepository.js', () => ({
  creditSpendWindow: vi.fn(async () => spend),
}));

const { readUsageWindow, secondsUntilReset, USAGE_WINDOW_CREDITS } = await import('../usage-window.js');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

beforeEach(() => {
  spend.used = 0;
  spend.oldest = null;
});

describe('the rolling usage window', () => {
  it('holds each plan to its own cap, and a plan with none to no window at all', async () => {
    expect((await readUsageWindow('u', 'pro', NOW))?.limit).toBe(USAGE_WINDOW_CREDITS.pro);
    expect((await readUsageWindow('u', 'free', NOW))?.limit).toBe(USAGE_WINDOW_CREDITS.free);
    // An unknown plan id is not a reason to refuse somebody who is paying.
    expect(await readUsageWindow('u', 'enterprise-legacy', NOW)).toBeNull();
  });

  it('is spent at the cap, not before it', async () => {
    spend.used = USAGE_WINDOW_CREDITS.go - 1;
    expect((await readUsageWindow('u', 'go', NOW))?.exhausted).toBe(false);
    spend.used = USAGE_WINDOW_CREDITS.go;
    expect((await readUsageWindow('u', 'go', NOW))?.exhausted).toBe(true);
  });

  it('frees up when the oldest spending turn ages out of the five hours', async () => {
    spend.used = USAGE_WINDOW_CREDITS.pro;
    spend.oldest = new Date(NOW - 3 * HOUR);
    const window = await readUsageWindow('u', 'pro', NOW);
    expect(window?.resetsAt?.getTime()).toBe(NOW + 2 * HOUR);
    expect(secondsUntilReset(window!, NOW)).toBe(2 * 60 * 60);
  });

  it('has nothing to wait for when nothing is spent', async () => {
    const window = await readUsageWindow('u', 'pro', NOW);
    expect(window?.resetsAt).toBeNull();
    expect(secondsUntilReset(window!, NOW)).toBe(1);
  });
});
