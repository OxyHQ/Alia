import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  countUsableKeys,
  createProviderKey,
  deleteProviderKey,
  findProviderKeyById,
  findSafeProviderKeyById,
  hashProviderKey,
  listProviderKeyDiagnostics,
  listSafeProviderKeys,
  loadActiveProviderKeys,
  markKeyCreditExhausted,
  maxPriorityInGroup,
  providerKeyHashExists,
  providerKeyPrefix,
  providerKeyStats,
  recordKeyFailure,
  recordKeySpend,
  recordKeySuccess,
  recordKeyUsage,
  resetAllKeyCooldowns,
  rotateProviderKey,
  updateProviderKey,
  type NewProviderKey,
} from '../providers/providerKeyRepository';
import { keyUsageWindows, recordApiUsage } from '../telemetry/apiUsageRepository';
import { providerKeys } from '../schema/providers';

/**
 * `provider_keys` and `api_usage`, against a real server.
 *
 * This table decides which upstream credential serves a request, and every way
 * it can be wrong is quiet: a key that never leaves cooldown, a failure counter
 * that stops counting, an archived credential put back into rotation, a secret
 * in an admin response. So the cases below assert the state that must NOT be
 * reached as often as the one that must.
 *
 * `provider` is a CHECK-constrained column, so fixtures use real provider names
 * and are separated by `name`/`key` instead. Every read here is either by id or
 * filtered, except the three that are deliberately table-wide.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

let seq = 0;
function newKey(over: Partial<NewProviderKey> = {}): NewProviderKey {
  seq += 1;
  const secret = `pk-secret-${seq}-${Math.random().toString(36).slice(2)}`;
  return {
    name: `pk-${seq}`,
    provider: 'openai',
    keyHash: hashProviderKey(secret),
    keyPrefix: providerKeyPrefix(secret),
    key: secret,
    environment: 'production',
    isPaid: false,
    tier: 'free',
    priority: 10,
    rateLimit: {},
    creditLimitUsd: null,
    rateLimitResetMs: null,
    ...over,
  };
}

describe('the safe projection', () => {
  it('never carries the secret or its digest', async () => {
    const created = await createProviderKey(db, newKey());

    for (const row of [created, await findSafeProviderKeyById(db, created.id)]) {
      expect(row).toBeDefined();
      // The `Omit` is what makes reaching for these fail `tsc`; this is the
      // runtime half, because a `select *` slipping back in would compile.
      expect(row).not.toHaveProperty('key');
      expect(row).not.toHaveProperty('keyHash');
    }
    // ...and the row really does hold them, so the absence above is a
    // projection rather than an empty column.
    const full = await findProviderKeyById(db, created.id);
    expect(full?.key).toBeTruthy();
    expect(full?.keyHash).toHaveLength(64);
  });

  it('never carries a credential the provider quoted back at us, either', async () => {
    /**
     * `last_failure_reason` is built from an upstream error body, and an
     * upstream 401 echoes the credential it rejected. The column is INSIDE the
     * projection above, so whatever is stored travels with every "safe" read —
     * and `Omit<…, 'key' | 'keyHash'>` cannot catch it, because the column is
     * legitimately named and legitimately present (#139 workstream 15).
     *
     * The value is synthetic and assembled from fragments: shaped like a
     * project key, a single repeated letter for a body, nothing to rotate.
     */
    const synthetic = ['sk', 'proj', 'B'.repeat(40) + 'ENDS0043'].join('-');
    const created = await createProviderKey(db, newKey({ name: 'pk-failure-reason' }));
    const reason = `test-model 401: {"error":{"message":"Incorrect API key provided: ${synthetic}"}}`;
    // The control: what the repository is handed really does carry it, so a
    // clean read below is redaction rather than an empty column.
    expect(reason).toContain(synthetic);

    await recordKeyFailure(db, created.id, reason, 20, new Date(), false);

    const safe = await findSafeProviderKeyById(db, created.id);
    expect(safe?.lastFailureReason).not.toContain(synthetic);
    expect(safe?.lastFailureReason).not.toContain(synthetic.slice(0, 12));
    // And it is still worth reading — which is why the column is redacted
    // rather than dropped, and why a classification does not replace it.
    expect(safe?.lastFailureReason).toContain('401');
    expect(safe?.lastFailureReason).toContain('Incorrect API key provided');
  });

  it('reports whether a key HAS a value without returning it', async () => {
    const withValue = await createProviderKey(db, newKey({ name: 'pk-diag-has' }));
    const blank = await createProviderKey(db, newKey({ name: 'pk-diag-blank' }));
    await db.update(providerKeys).set({ key: null }).where(eq(providerKeys.id, blank.id));

    const diagnostics = await listProviderKeyDiagnostics(db);
    const has = diagnostics.find((d) => d.id === withValue.id);
    const none = diagnostics.find((d) => d.id === blank.id);

    expect(has?.hasKeyValue).toBe(true);
    expect(has?.keyLength).toBeGreaterThan(0);
    expect(none?.hasKeyValue).toBe(false);
    expect(none?.keyLength).toBe(0);
    expect(has).not.toHaveProperty('key');
  });
});

describe('selection order', () => {
  it('serves FREE keys before paid, and by priority within each group', async () => {
    const provider = 'cohere';
    const paidLow = await createProviderKey(db, newKey({ provider, isPaid: true, priority: 1 }));
    const freeHigh = await createProviderKey(db, newKey({ provider, isPaid: false, priority: 90 }));
    const freeLow = await createProviderKey(db, newKey({ provider, isPaid: false, priority: 2 }));

    const keys = await loadActiveProviderKeys(db, provider);
    const ids = keys.map((k) => k.id);
    // The paid key has the LOWEST priority number of the three, so a query that
    // sorted by priority alone would put it first. Free-before-paid wins.
    expect(ids).toEqual([freeLow.id, freeHigh.id, paidLow.id]);
  });

  it('excludes archived and inactive keys', async () => {
    const provider = 'perplexity';
    const live = await createProviderKey(db, newKey({ provider }));
    const off = await createProviderKey(db, newKey({ provider }));
    const gone = await createProviderKey(db, newKey({ provider }));
    await updateProviderKey(db, off.id, { isActive: false });
    await db.update(providerKeys).set({ isArchived: true }).where(eq(providerKeys.id, gone.id));

    const ids = (await loadActiveProviderKeys(db, provider)).map((k) => k.id);
    expect(ids).toEqual([live.id]);
  });
});

describe('recording failures', () => {
  it('moves the key to the back of its group and counts the failure', async () => {
    const provider = 'mistral';
    const key = await createProviderKey(db, newKey({ provider, priority: 5 }));
    await createProviderKey(db, newKey({ provider, priority: 40 }));

    const max = await maxPriorityInGroup(db, provider, false);
    expect(max).toBe(40);

    const outcome = await recordKeyFailure(db, key.id, 'boom', max ?? 999, new Date(), false);
    expect(outcome?.currentPriority).toBe(41);
    expect(outcome?.consecutiveFailures).toBe(1);
    expect(outcome?.totalFailures).toBe(1);
    expect(outcome?.archived).toBe(false);
  });

  it('does NOT count a rate limit toward either failure counter', async () => {
    const key = await createProviderKey(db, newKey({ provider: 'groq' }));

    const outcome = await recordKeyFailure(db, key.id, '429 rate limit', 20, new Date(), true);
    // The priority still moves — the key goes to the back of the queue either
    // way — but a transient quota must never archive a working credential.
    expect(outcome?.currentPriority).toBe(21);
    expect(outcome?.consecutiveFailures).toBe(0);
    expect(outcome?.totalFailures).toBe(0);
  });

  it('archives and deactivates once total failures reach the key\'s ceiling', async () => {
    const key = await createProviderKey(db, newKey({ provider: 'together' }));
    await db.update(providerKeys).set({ maxTotalFailures: 10 }).where(eq(providerKeys.id, key.id));

    for (let i = 0; i < 9; i += 1) {
      await recordKeyFailure(db, key.id, 'boom', 10, new Date(), false);
    }
    // The negative half: nine failures is not ten.
    expect((await findProviderKeyById(db, key.id))?.isArchived).toBe(false);

    const outcome = await recordKeyFailure(db, key.id, 'boom', 10, new Date(), false);
    expect(outcome?.archived).toBe(true);
    const row = await findProviderKeyById(db, key.id);
    expect(row?.isArchived).toBe(true);
    expect(row?.isActive).toBe(false);
    expect(row?.archivedAt).not.toBeNull();
    expect(row?.archivedReason).toContain('10 total failures');
  });

  it('CLAMPS the priority at the column ceiling instead of failing the write', async () => {
    /**
     * The port hazard. Mongo had no constraint, so `maxPriority + 1` grew
     * without bound; the Postgres column carries `between 1 and 1000`. The
     * caller swallows errors, so an unclamped write would make failures — and
     * archival with them — silently stop being recorded at the ceiling.
     */
    const key = await createProviderKey(db, newKey({ provider: 'xai' }));

    const outcome = await recordKeyFailure(db, key.id, 'boom', 1000, new Date(), false);
    expect(outcome?.currentPriority).toBe(1000);
    // And the write really landed: the counter moved, which is what would stop
    // if the statement had been rejected.
    expect(outcome?.totalFailures).toBe(1);
  });
});

describe('recording successes', () => {
  it('restores the original priority, clears the run and the cooldown', async () => {
    const key = await createProviderKey(db, newKey({ provider: 'deepseek', priority: 7 }));
    await recordKeyFailure(db, key.id, 'boom', 300, new Date(), false);
    await db
      .update(providerKeys)
      .set({ cooldownUntil: new Date(Date.now() + 600_000) })
      .where(eq(providerKeys.id, key.id));
    expect((await findProviderKeyById(db, key.id))?.currentPriority).toBe(301);

    const row = await recordKeySuccess(db, key.id, new Date());
    expect(row?.currentPriority).toBe(7);
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.successCount).toBe(1);
    // The source cleared the cooldown in a SECOND write, leaving a window where
    // the key read as healthy and was still in cooldown.
    expect(row?.cooldownUntil).toBeNull();
  });

  it('reactivates a merely deactivated key but NEVER an archived one', async () => {
    const off = await createProviderKey(db, newKey({ provider: 'cerebras' }));
    await updateProviderKey(db, off.id, { isActive: false });
    expect((await recordKeySuccess(db, off.id, new Date()))?.isActive).toBe(true);

    const archived = await createProviderKey(db, newKey({ provider: 'cerebras' }));
    await db
      .update(providerKeys)
      .set({ isArchived: true, isActive: false })
      .where(eq(providerKeys.id, archived.id));

    // A credential retired for repeated failure must not be put back into
    // rotation by one late success.
    const row = await recordKeySuccess(db, archived.id, new Date());
    expect(row?.isActive).toBe(false);
    expect(row?.isArchived).toBe(true);
  });
});

describe('usage, spend and credit limits', () => {
  it('increments request and token counters atomically', async () => {
    const key = await createProviderKey(db, newKey({ provider: 'openai' }));

    await Promise.all(
      Array.from({ length: 10 }, () => recordKeyUsage(db, key.id, 100, new Date())),
    );

    const row = await findProviderKeyById(db, key.id);
    // Ten concurrent recordings. A read-modify-write would report fewer.
    expect(row?.totalRequests).toBe(10);
    expect(row?.totalTokens).toBe(1000);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it('accumulates spend rather than overwriting it', async () => {
    const key = await createProviderKey(db, newKey({ provider: 'anthropic' }));
    await recordKeySpend(db, key.id, 1.5);
    await recordKeySpend(db, key.id, 2.25);
    expect((await findProviderKeyById(db, key.id))?.spentUsd).toBeCloseTo(3.75, 6);
  });

  it('marks a key exhausted only when a limit is SET', async () => {
    const limited = await createProviderKey(db, newKey({ provider: 'google', creditLimitUsd: 25 }));
    const unlimited = await createProviderKey(db, newKey({ provider: 'google', creditLimitUsd: null }));

    expect(await markKeyCreditExhausted(db, limited.id)).toBe(true);
    expect((await findProviderKeyById(db, limited.id))?.spentUsd).toBe(25);

    /**
     * Null means UNLIMITED, not zero. Without the guard the spend would be set
     * to NULL, which violates `not null` — or, if the column allowed it, would
     * make an unlimited key look exhausted. Either way the row must not move.
     */
    expect(await markKeyCreditExhausted(db, unlimited.id)).toBe(false);
    expect((await findProviderKeyById(db, unlimited.id))?.spentUsd).toBe(0);
  });
});

describe('operator actions', () => {
  it('clears cooldowns and failure runs, and counts only the rows it changed', async () => {
    const cooling = await createProviderKey(db, newKey({ provider: 'novita' }));
    const failing = await createProviderKey(db, newKey({ provider: 'novita' }));
    const clean = await createProviderKey(db, newKey({ provider: 'novita' }));
    await db
      .update(providerKeys)
      .set({ cooldownUntil: new Date(Date.now() + 60_000) })
      .where(eq(providerKeys.id, cooling.id));
    await db
      .update(providerKeys)
      .set({ consecutiveFailures: 3 })
      .where(eq(providerKeys.id, failing.id));

    const reset = await resetAllKeyCooldowns(db);
    expect(reset).toBeGreaterThanOrEqual(2);

    expect((await findProviderKeyById(db, cooling.id))?.cooldownUntil).toBeNull();
    expect((await findProviderKeyById(db, failing.id))?.consecutiveFailures).toBe(0);
    // The clean key was never in the filter, so its `updated_at` is untouched.
    expect((await findProviderKeyById(db, clean.id))?.consecutiveFailures).toBe(0);
  });

  it('rotates the credential, the digest and the prefix together', async () => {
    const key = await createProviderKey(db, newKey({ provider: 'fireworks' }));
    const before = await findProviderKeyById(db, key.id);

    const replacement = `rotated-${Math.random().toString(36).slice(2)}`;
    const rotated = await rotateProviderKey(db, key.id, replacement, new Date());
    expect(rotated?.rotatedAt).not.toBeNull();

    const after = await findProviderKeyById(db, key.id);
    expect(after?.key).toBe(replacement);
    expect(after?.keyHash).toBe(hashProviderKey(replacement));
    expect(after?.keyPrefix).toBe(providerKeyPrefix(replacement));
    // All three moved together — a rotation that updated the secret and left
    // the digest behind would break the duplicate check silently.
    expect(after?.keyHash).not.toBe(before?.keyHash);
  });

  it('detects a duplicate digest before it reaches the unique index', async () => {
    const secret = `dup-${Math.random().toString(36).slice(2)}`;
    await createProviderKey(db, newKey({ provider: 'replicate', keyHash: hashProviderKey(secret), key: secret }));

    expect(await providerKeyHashExists(db, hashProviderKey(secret))).toBe(true);
    expect(await providerKeyHashExists(db, hashProviderKey(`${secret}-other`))).toBe(false);
  });

  it('deletes a key and returns it, or null when there is nothing to delete', async () => {
    const key = await createProviderKey(db, newKey({ provider: 'hyperbolic' }));
    expect((await deleteProviderKey(db, key.id))?.id).toBe(key.id);
    expect(await findProviderKeyById(db, key.id)).toBeNull();
    // A second delete finds nothing — the route turns this into a 404.
    expect(await deleteProviderKey(db, key.id)).toBeNull();
  });

  it('counts usable keys, excluding archived and inactive', async () => {
    const before = await countUsableKeys(db);
    const live = await createProviderKey(db, newKey({ provider: 'sambanova' }));
    const dead = await createProviderKey(db, newKey({ provider: 'sambanova' }));
    await db.update(providerKeys).set({ isArchived: true }).where(eq(providerKeys.id, dead.id));

    expect(await countUsableKeys(db)).toBe(before + 1);
    expect(typeof (await countUsableKeys(db))).toBe('number');
    expect(live.isActive).toBe(true);
  });

  it('lists keys filtered, without secrets, priority-ordered', async () => {
    const provider = 'openrouter';
    await createProviderKey(db, newKey({ provider, priority: 50 }));
    await createProviderKey(db, newKey({ provider, priority: 3 }));

    const listed = await listSafeProviderKeys(db, { provider });
    expect(listed).toHaveLength(2);
    /**
     * The source sorted by `priority`, a field this model does not have — so
     * the secondary ordering was never applied and the result was arbitrary
     * within a provider. This sorts by `current_priority`, which is what the
     * name was reaching for.
     */
    expect(listed[0].currentPriority).toBe(3);
    expect(listed[1].currentPriority).toBe(50);
    expect(listed[0]).not.toHaveProperty('key');
  });
});

describe('provider statistics', () => {
  it('reports ZERO rather than NaN for a provider with no keys', async () => {
    /**
     * The source divided by `keys.length` with no guard, so an empty set gave
     * `NaN` — which `JSON.stringify` renders as `null`. That is a bug rather
     * than a decision.
     */
    const stats = await providerKeyStats(db, 'cloudflare');
    expect(stats.total).toBe(0);
    expect(stats.averageSuccessRate).toBe(0);
    expect(Number.isNaN(stats.averageSuccessRate)).toBe(false);
  });

  it('averages the success rate, counting an UNUSED key as one', async () => {
    const provider = 'cloudflare';
    const used = await createProviderKey(db, newKey({ provider }));
    await createProviderKey(db, newKey({ provider })); // never used

    // Three successes, one failure => 0.75 for this key.
    await db
      .update(providerKeys)
      .set({ successCount: 3, totalFailures: 1, totalRequests: 4 })
      .where(eq(providerKeys.id, used.id));

    const stats = await providerKeyStats(db, provider);
    expect(stats.total).toBe(2);
    expect(stats.active).toBe(2);
    // (0.75 + 1) / 2 — an unused key is not evidence of unreliability, which is
    // what the source's `total > 0 ? ... : 1` said.
    expect(stats.averageSuccessRate).toBeCloseTo(0.875, 6);
    expect(stats.totalRequests).toBe(4);
    expect(stats.totalFailures).toBe(1);
    expect(typeof stats.totalRequests).toBe('number');
  });
});

describe('api_usage rate-limit windows', () => {
  it('separates the four windows and counts each as a NUMBER', async () => {
    const keyId = `au-key-${Math.random().toString(36).slice(2)}`;
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);

    await recordApiUsage(db, { keyId, provider: 'openai', modelId: 'm', tokens: 10, timestamp: ago(100) });
    await recordApiUsage(db, { keyId, provider: 'openai', modelId: 'm', tokens: 20, timestamp: ago(30_000) });
    await recordApiUsage(db, { keyId, provider: 'openai', modelId: 'm', tokens: 40, timestamp: ago(1_800_000) });
    await recordApiUsage(db, { keyId, provider: 'openai', modelId: 'm', tokens: 80, timestamp: ago(50_000_000) });
    // Outside the day window entirely.
    await recordApiUsage(db, { keyId, provider: 'openai', modelId: 'm', tokens: 999, timestamp: ago(90_000_000) });

    const w = await keyUsageWindows(db, keyId, now);

    expect(w.second).toEqual({ count: 1, tokens: 10 });
    expect(w.minute).toEqual({ count: 2, tokens: 30 });
    expect(w.hour).toEqual({ count: 3, tokens: 70 });
    // The day window excludes the 999 — nesting, not four independent scans.
    expect(w.day).toEqual({ count: 4, tokens: 150 });
    expect(typeof w.minute.tokens).toBe('number');
  });

  it('returns zeros for a key with no usage', async () => {
    const w = await keyUsageWindows(db, 'au-key-nothing', new Date());
    expect(w.day).toEqual({ count: 0, tokens: 0 });
    expect(w.second).toEqual({ count: 0, tokens: 0 });
  });

  it('never counts another key\'s usage', async () => {
    const mine = `au-mine-${Math.random().toString(36).slice(2)}`;
    const theirs = `au-theirs-${Math.random().toString(36).slice(2)}`;
    await recordApiUsage(db, { keyId: mine, provider: 'openai', modelId: 'm', tokens: 5 });
    await recordApiUsage(db, { keyId: theirs, provider: 'openai', modelId: 'm', tokens: 500 });

    expect((await keyUsageWindows(db, mine, new Date())).day).toEqual({ count: 1, tokens: 5 });
    // The positive control for the filter.
    expect((await keyUsageWindows(db, theirs, new Date())).day).toEqual({ count: 1, tokens: 500 });
  });
});
