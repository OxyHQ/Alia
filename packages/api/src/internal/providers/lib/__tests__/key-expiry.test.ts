import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `provider_keys.expires_at` is ENFORCED — epic #139.
 *
 * The column was declared in the Mongo port and read by nothing: it appeared
 * only in the repository's safe projection, so a key past its expiry was still
 * selected and still signed upstream calls. A column that looks like enforcement
 * and is decoration is worse than an absent one, because `rotation_schedule`
 * sits beside it with a `manual` default and a reader concludes expiry is
 * handled.
 *
 * ## What these tests have to discriminate
 *
 * A guard that refuses everything passes "an expired key is refused" and is
 * catastrophic — it empties the pool. So the expiry cases are paired with the
 * two that must STILL be selected, and the null case is the one that matters
 * most: nothing in this package writes `expires_at`, so in practice almost every
 * row is null and treating null as "expired at the epoch" would refuse the whole
 * pool on the first request.
 *
 * The mutation evidence is recorded in the PR: `<=` to `>=` fails
 * `selects a key whose expiry is in the future`; dropping the `key.expiresAt &&`
 * null guard fails `selects a key with no expiry at all`; deleting the branch
 * fails `refuses a key past its expiry`.
 */

const loadActiveProviderKeys = vi.fn();
const keyUsageWindows = vi.fn();
const warn = vi.fn();
const debug = vi.fn();

vi.mock('../../../../db/providers/providerKeyRepository.js', () => ({
  loadActiveProviderKeys: (...args: unknown[]) => loadActiveProviderKeys(...args) as unknown,
  findProviderKeyById: vi.fn(),
  markKeyCreditExhausted: vi.fn(),
  maxPriorityInGroup: vi.fn(),
  providerKeyStats: vi.fn(),
  recordKeyFailure: vi.fn(),
  recordKeySpend: vi.fn(),
  recordKeySuccess: vi.fn(),
  recordKeyUsage: vi.fn(),
  setKeyCooldown: vi.fn(),
}));

vi.mock('../../../../db/telemetry/apiUsageRepository.js', () => ({
  keyUsageWindows: (...args: unknown[]) => keyUsageWindows(...args) as unknown,
  recordApiUsage: vi.fn(),
}));

vi.mock('../../../../db/index.js', () => ({ getDb: () => ({}) }));

vi.mock('../../../../lib/logger.js', () => ({
  log: { keys: { warn, debug, info: vi.fn(), error: vi.fn() } },
}));

const { getBestKeyForModel } = await import('../key-manager.js');

const HOUR = 60 * 60 * 1000;

/**
 * A key that is usable on every axis except the one a test sets.
 *
 * Spelled out rather than partial-and-cast: the selection loop reads the
 * cooldown, the credit limit and the stored value before it can return, so a
 * fixture missing one of them would fail for a reason the test is not about.
 */
function usableKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    provider: 'openai',
    keyPrefix: 'sk-live...',
    key: 'a-stored-credential',
    isPaid: false,
    cooldownUntil: null,
    expiresAt: null,
    creditLimitUsd: null,
    spentUsd: 0,
    rateLimitRps: null,
    rateLimitRpm: null,
    rateLimitRph: null,
    rateLimitRpd: null,
    rateLimitTps: null,
    rateLimitTpm: null,
    rateLimitTph: null,
    rateLimitTpd: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  keyUsageWindows.mockResolvedValue({ second: 0, minute: 0, hour: 0, day: 0 });
});

describe('an expired provider key is not selected (#139)', () => {
  /**
   * The cache in `key-manager` is keyed by provider and lives 10s, so every test
   * uses its own provider name. Sharing one would let an earlier test's rows
   * answer a later test's call, and the failure would look like a logic bug.
   */
  it('refuses a key past its expiry', async () => {
    loadActiveProviderKeys.mockResolvedValue([
      usableKey({ expiresAt: new Date(Date.now() - HOUR) }),
    ]);

    const chosen = await getBestKeyForModel('expired-only', 'some-model');

    expect(chosen).toBeNull();
  });

  it('says which key it refused and why, rather than degrading silently', async () => {
    const expiresAt = new Date(Date.now() - HOUR);
    loadActiveProviderKeys.mockResolvedValue([usableKey({ expiresAt })]);

    await getBestKeyForModel('expired-logged', 'some-model');

    // The whole reason the check is here rather than in the selection query: a
    // row filtered out in SQL cannot be logged as skipped, and an expiry that
    // bites an unmeasured production population must announce itself.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: 'sk-live...', expiresAt }),
      'Key past expires_at, skipping',
    );
  });

  it('selects a key with no expiry at all', async () => {
    // The vacuity floor. Nothing in this package writes `expires_at`, so this is
    // the shape of essentially every real row: if null were treated as expired,
    // the guard would refuse the entire pool and the test above would still pass.
    loadActiveProviderKeys.mockResolvedValue([usableKey({ expiresAt: null })]);

    const chosen = await getBestKeyForModel('no-expiry', 'some-model');

    expect(chosen).not.toBeNull();
    expect(chosen?.keyId).toBe('key-1');
  });

  it('selects a key whose expiry is in the future', async () => {
    // The other direction: the comparison must discriminate past from future,
    // not merely notice that the column is set.
    loadActiveProviderKeys.mockResolvedValue([
      usableKey({ expiresAt: new Date(Date.now() + HOUR) }),
    ]);

    const chosen = await getBestKeyForModel('future-expiry', 'some-model');

    expect(chosen).not.toBeNull();
    expect(chosen?.keyId).toBe('key-1');
  });

  it('skips the expired key and takes the next usable one', async () => {
    // The pool case, and the one that proves the guard is a SKIP rather than an
    // abort: an expired key at the front must not hide a live key behind it.
    loadActiveProviderKeys.mockResolvedValue([
      usableKey({ id: 'expired', keyPrefix: 'sk-old...', expiresAt: new Date(Date.now() - HOUR) }),
      usableKey({ id: 'live', keyPrefix: 'sk-new...', expiresAt: new Date(Date.now() + HOUR) }),
    ]);

    const chosen = await getBestKeyForModel('mixed-pool', 'some-model');

    expect(chosen?.keyId).toBe('live');
  });

  it('treats an expiry exactly at now as expired', async () => {
    // The boundary is stated rather than left to whichever way `<=` was written.
    // A credential is not valid AT the instant it expires.
    const now = new Date('2026-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    loadActiveProviderKeys.mockResolvedValue([usableKey({ expiresAt: new Date(now) })]);

    const chosen = await getBestKeyForModel('boundary', 'some-model');

    expect(chosen).toBeNull();
  });
});
