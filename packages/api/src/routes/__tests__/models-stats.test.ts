import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What `GET /models/stats` and `/models/stats/:modelId` actually RETURN.
 *
 * ## The defect these assert against
 *
 * Measured on `api.alia.onl` on 2026-08-19, unauthenticated:
 *
 *     {"id":"alia-lite", …, "avgLatencyMs":0, "uptime":100,
 *      "successRate":100, "totalRequests":0, "isHealthy":true}
 *
 * `totalRequests: 0` beside `uptime: 100` and `successRate: 100`, in public, for
 * every model — and the detail route put `lastSuccess: null` in the same object.
 * Zero requests and a perfect success rate are not two readings of one dataset;
 * together they are false.
 *
 * ## Why the assertions name every numeric field
 *
 * Because the sibling suite proved they must. In `health-route.test.ts` a
 * wholesale module mock that omitted ONE newly-added read made the route's own
 * `catch` swallow it, and every existing assertion passed with the numbers at
 * zero. Naming the fields is what tells an incomplete mock from a working route.
 *
 * ## What each mutation must break
 *
 *  - restoring `healthyProviders / totalProviders` over never-called rows;
 *  - restoring either `: 100` fallback;
 *  - restoring the per-mapping `getProviderHealth`, which INSERTS.
 *
 * The last one is asserted directly: the mock exposes `getProviderHealth` as a
 * spy and the tests require it never to be called. Reading a stats page must not
 * write a `provider_health` row.
 */

/** One `provider_health` row, carrying only what the aggregation reads. */
interface HealthRow {
  readonly provider: string;
  readonly modelId: string;
  readonly isHealthy: boolean;
  readonly totalRequests: number;
  readonly successRate: number;
  readonly averageLatencyMs: number;
  readonly lastSuccess: Date | null;
  readonly lastFailure: Date | null;
}

/** A provider that has genuinely served. The positive control. */
function served(over: Partial<HealthRow> = {}): HealthRow {
  return {
    provider: 'p1',
    modelId: 'm1',
    isHealthy: true,
    totalRequests: 40,
    successRate: 95,
    averageLatencyMs: 1200,
    lastSuccess: new Date('2026-08-19T12:00:00Z'),
    lastFailure: null,
    ...over,
  };
}

/**
 * A row created by a READ and never called: `is_healthy` still at its schema
 * default of `true`, no success, no requests. Production's 26 rows.
 */
function neverCalled(over: Partial<HealthRow> = {}): HealthRow {
  return {
    provider: 'p2',
    modelId: 'm2',
    isHealthy: true,
    totalRequests: 0,
    successRate: 100,
    averageLatencyMs: 0,
    lastSuccess: null,
    lastFailure: null,
    ...over,
  };
}

const MODEL = {
  id: 'alia-lite',
  name: 'Alia Lite',
  description: 'Fast responses for simple tasks',
  tier: 'lite',
  category: 'general',
  creditMultiplier: 0.5,
  supportsTools: true,
  supportsVision: false,
  maxTokens: 4096,
};

let server: Server | null = null;
/** The row-creating read. Present so its ABSENCE can be asserted. */
const getProviderHealth = vi.fn();

/**
 * Mount the REAL router and answer one request against it.
 *
 * Modules are imported fresh per call so a mock registered here reaches the
 * copy the route holds.
 */
async function probe(
  path: string,
  {
    rows = [] as readonly HealthRow[],
    mappings = [{ provider: 'p1', modelId: 'm1' }] as readonly { provider: string; modelId: string }[],
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  vi.resetModules();
  getProviderHealth.mockClear();

  vi.doMock('../../lib/chat-core.js', () => ({
    getAllAliaModels: () => Promise.resolve([MODEL]),
  }));
  vi.doMock('../../lib/gateway-client.js', () => ({
    getTierMappings: () => Promise.resolve({ lite: [...mappings] }),
    getAllProviderHealth: () => Promise.resolve([...rows]),
    getProviderHealth,
  }));

  const { default: statsRouter } = await import('../models-stats.js');
  const app = express();
  app.use('/models', statsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

afterEach(async () => {
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  vi.doUnmock('../../lib/chat-core.js');
  vi.doUnmock('../../lib/gateway-client.js');
});

/* -------------------------------------------------------------------------- */
/*  A model that has served nothing reports absence                            */
/* -------------------------------------------------------------------------- */

describe('GET /models/stats does not claim 100% of nothing', () => {
  it('reports null for every metric when no provider has been called', async () => {
    // THE case, and production's exact state: a row exists because a read
    // created it, `is_healthy` is still the schema default, nothing was served.
    const { status, body } = await probe('/models/stats', {
      rows: [neverCalled({ provider: 'p1', modelId: 'm1' })],
    });

    expect(status).toBe(200);
    const [model] = body.models as Record<string, unknown>[];
    expect(model.totalRequests).toBe(0);
    expect(model.uptime).toBeNull();
    expect(model.successRate).toBeNull();
    expect(model.avgLatencyMs).toBeNull();
    expect(model.isHealthy).toBeNull();
  });

  it('reports null when the model has no recorded row at all', async () => {
    // The other shape of "never": no row rather than a defaulted one. Both must
    // give the same answer, or the fix depends on a read having run first.
    const { status, body } = await probe('/models/stats', { rows: [] });

    expect(status).toBe(200);
    const [model] = body.models as Record<string, unknown>[];
    expect(model.totalRequests).toBe(0);
    expect(model.uptime).toBeNull();
    expect(model.successRate).toBeNull();
  });

  it('still reports the real numbers for a model that has served', async () => {
    /**
     * The positive control. Without it, nulling everything unconditionally
     * satisfies every assertion above — pessimism that measures nothing, the
     * mirror of the optimism being removed.
     */
    const { status, body } = await probe('/models/stats', {
      rows: [served({ provider: 'p1', modelId: 'm1' })],
    });

    expect(status).toBe(200);
    const [model] = body.models as Record<string, unknown>[];
    expect(model.totalRequests).toBe(40);
    expect(model.successRate).toBe(95);
    expect(model.avgLatencyMs).toBe(1200);
    expect(model.uptime).toBe(100);
    expect(model.isHealthy).toBe(true);
  });

  it('counts only providers with EVIDENCE toward uptime', async () => {
    /**
     * The mutation target the brief names. Four mappings, one served, three
     * created by a read and never called. `healthyProviders / totalProviders`
     * over `is_healthy` gives 100% — all four default to true. Requiring a
     * recorded success gives 25%.
     *
     * Note the model IS observed here, so this is not the null case: it is the
     * one where the old formula lied while `totalRequests` was non-zero, which
     * nulling alone would never have caught.
     */
    const mappings = [
      { provider: 'p1', modelId: 'm1' },
      { provider: 'p2', modelId: 'm2' },
      { provider: 'p3', modelId: 'm3' },
      { provider: 'p4', modelId: 'm4' },
    ];
    const { body } = await probe('/models/stats', {
      mappings,
      rows: [
        served({ provider: 'p1', modelId: 'm1' }),
        neverCalled({ provider: 'p2', modelId: 'm2' }),
        neverCalled({ provider: 'p3', modelId: 'm3' }),
        neverCalled({ provider: 'p4', modelId: 'm4' }),
      ],
    });

    const [model] = body.models as Record<string, unknown>[];
    expect(model.uptime).toBe(25);
    // ...and the model is unhealthy on the route's own pre-existing threshold,
    // which is not a new rule: 25% is simply below the 50% that was always there.
    expect(model.isHealthy).toBe(false);
    expect(model.totalRequests).toBe(40);
  });

  it('keeps every backing provider in the denominator, row or no row', async () => {
    /**
     * Two mappings, one served, one with NO `provider_health` row at all.
     *
     * The tempting denominator is "mappings we have data for", which would
     * report 100% here — a model at half capacity looking perfect because the
     * missing half is invisible. The honest denominator is every mapping: a
     * provider that has never answered is not serving.
     *
     * Measured as a survivor: with the denominator narrowed to recorded rows,
     * every other case in this file still passed, because they all happen to
     * have a row for each mapping.
     */
    const { body } = await probe('/models/stats', {
      mappings: [
        { provider: 'p1', modelId: 'm1' },
        { provider: 'p9', modelId: 'm9' },
      ],
      rows: [served({ provider: 'p1', modelId: 'm1' })],
    });

    const [model] = body.models as Record<string, unknown>[];
    expect(model.uptime).toBe(50);
    // The observed half is unaffected: absence in the denominator is not a
    // request that happened.
    expect(model.totalRequests).toBe(40);
  });

  it('does not count a provider the breaker has ruled against', async () => {
    // `lastSuccess` alone is not enough either: a provider that served and has
    // since been ruled unhealthy is not serving now.
    const { body } = await probe('/models/stats', {
      mappings: [
        { provider: 'p1', modelId: 'm1' },
        { provider: 'p2', modelId: 'm2' },
      ],
      rows: [
        served({ provider: 'p1', modelId: 'm1' }),
        served({ provider: 'p2', modelId: 'm2', isHealthy: false, successRate: 10 }),
      ],
    });

    const [model] = body.models as Record<string, unknown>[];
    expect(model.uptime).toBe(50);
  });
});

/* -------------------------------------------------------------------------- */
/*  Reading the route does not WRITE                                           */
/* -------------------------------------------------------------------------- */

describe('a stats request creates no provider_health row', () => {
  it('never calls the read-that-inserts, on either route', async () => {
    /**
     * `getProviderHealth` lands in `getOrCreateProviderHealth`, which INSERTS a
     * default row when none is found. Calling it once per tier mapping per model
     * is how one unauthenticated request manufactured production's whole table
     * of healthy-looking never-called providers.
     *
     * Asserted as "the function is never reached" rather than by inspecting the
     * imports, because an import can be present and unused and a dynamic call
     * can be absent from the import list.
     */
    await probe('/models/stats', { rows: [served()] });
    expect(getProviderHealth).not.toHaveBeenCalled();

    await probe('/models/stats/alia-lite', { rows: [served()] });
    expect(getProviderHealth).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  The detail route, and what it may not disclose                             */
/* -------------------------------------------------------------------------- */

describe('GET /models/stats/:modelId', () => {
  it('reports absence and no timestamps for a model nothing has called', async () => {
    const { status, body } = await probe('/models/stats/alia-lite', {
      rows: [neverCalled({ provider: 'p1', modelId: 'm1' })],
    });

    expect(status).toBe(200);
    const stats = body.stats as Record<string, unknown>;
    expect(stats.totalRequests).toBe(0);
    expect(stats.uptime).toBeNull();
    expect(stats.successRate).toBeNull();
    expect(stats.avgLatencyMs).toBeNull();
    expect(stats.isHealthy).toBeNull();
    expect(stats.lastSuccess).toBeNull();
    expect(stats.lastFailure).toBeNull();
  });

  it('reports the real numbers and the real timestamp once it has served', async () => {
    const { body } = await probe('/models/stats/alia-lite', {
      rows: [served({ provider: 'p1', modelId: 'm1' })],
    });

    const stats = body.stats as Record<string, unknown>;
    expect(stats.totalRequests).toBe(40);
    expect(stats.uptime).toBe(100);
    expect(stats.successRate).toBe(95);
    expect(stats.lastSuccess).toBe('2026-08-19T12:00:00.000Z');
  });

  it('discloses no upstream provider name and no count of them', async () => {
    /**
     * The route is public and unauthenticated. It used to return
     * `backingProviders` and `healthyProviders` — counts of the UPSTREAM
     * PROVIDERS behind an Alia model, measured at 16 for `alia-lite` in
     * production. Those are route detail, and they are gone.
     *
     * Asserted over the serialized body rather than field by field, so a count
     * reintroduced under any other name is caught too.
     */
    const { body } = await probe('/models/stats/alia-lite', {
      mappings: [
        { provider: 'secret-upstream', modelId: 'upstream-model-7' },
        { provider: 'p2', modelId: 'm2' },
      ],
      rows: [
        served({ provider: 'secret-upstream', modelId: 'upstream-model-7' }),
        served({ provider: 'p2', modelId: 'm2' }),
      ],
    });

    const serialized = JSON.stringify(body);
    // Positive control: the fixture really did reach the aggregation, so a
    // clean scan below is concealment rather than an empty response.
    expect((body.stats as Record<string, unknown>).totalRequests).toBe(80);

    expect(serialized).not.toContain('secret-upstream');
    expect(serialized).not.toContain('upstream-model-7');
    expect(serialized).not.toContain('backingProviders');
    expect(serialized).not.toContain('healthyProviders');
    // The Alia-branded identifier is the one thing that SHOULD be there.
    expect(serialized).toContain('alia-lite');
  });

  it('404s an unknown model without disclosing anything', async () => {
    const { status, body } = await probe('/models/stats/not-a-model', { rows: [served()] });
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain('p1');
  });
});
