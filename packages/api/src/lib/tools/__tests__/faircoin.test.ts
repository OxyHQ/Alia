import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFairCoinTool } from '../faircoin.js';

/**
 * What the FairCoin tool puts into a message.
 *
 * FairCoin has no exchange ticker; the number comes from the explorer, which
 * derives it from GeckoTerminal's INDEXED price for the WFAIR/USDC pool on Base
 * rather than the pool's on-chain spot, because a low-liquidity tick is
 * manipulable within a block. This tool must not launder that provenance away —
 * hence the assertion that `source` survives into the card.
 *
 * NOT verified against the live explorer: there is no outbound network here, so
 * `fetch` is mocked. These fix the transformation and the range set; one real
 * call is what confirms the upstream field names, and it has not been made.
 */

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => ({ ok: true, json: async () => body });

const quote = {
  price: 0.0421, change24h: -1.8, volume24h: 1234, liquidityUsd: 56789,
  marketCapUsd: 2_000_000, source: 'wfair-base', updatedAt: '2026-09-09T12:00:00.000Z',
};

const history = (n: number) => ({
  history: Array.from({ length: n }, (_, i) => ({
    price_usd: 0.04 + i / 1000,
    timestamp: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
  })),
});

/** The tool fires the price call and all five period calls together. */
function mockAll(counts = [3, 4, 5, 6, 7]) {
  fetchMock.mockResolvedValueOnce(ok(quote));
  counts.forEach((n) => fetchMock.mockResolvedValueOnce(ok(history(n))));
}

const run = () => (getFairCoinTool.execute as (i: unknown, o: unknown) => Promise<any>)({}, {});

describe('getFairCoin', () => {
  it('offers exactly the ranges the explorer retains, and no invented ones', async () => {
    mockAll();
    const out = await run();
    expect(Object.keys(out.card.data.series).sort()).toEqual(['1y', '24h', '30d', '7d', 'all']);
  });

  it('keeps the provenance of the price', async () => {
    mockAll();
    const out = await run();
    expect(out.card.data.source).toBe('wfair-base');
    expect(out.card.data.updatedAt).toBe('2026-09-09T12:00:00.000Z');
  });

  it('turns timestamps into numbers the chart can plot', async () => {
    mockAll([2, 2, 2, 2, 2]);
    const out = await run();
    const [at, price] = out.card.data.series['7d'][0];
    expect(typeof at).toBe('number');
    expect(Number.isNaN(at)).toBe(false);
    expect(price).toBeCloseTo(0.04);
  });

  it('reports the quote the card renders', async () => {
    mockAll();
    const out = await run();
    expect(out.card.data).toMatchObject({
      price: 0.0421, changePct: -1.8, volume24h: 1234, liquidityUsd: 56789, marketCapUsd: 2_000_000,
    });
  });

  it('still ships a card when one period has no samples yet', async () => {
    fetchMock.mockResolvedValueOnce(ok(quote));
    fetchMock.mockResolvedValueOnce(ok(history(3)));
    fetchMock.mockResolvedValueOnce(ok({ history: [] }));
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce(ok(history(2)));
    fetchMock.mockResolvedValueOnce(ok(history(2)));

    const out = await run();
    expect(out.card).toBeDefined();
    expect(out.card.data.series['7d']).toEqual([]);
    // A period the explorer refused is absent, not silently empty — the card can
    // tell "no samples yet" from "we never asked".
    expect(out.card.data.series['30d']).toBeUndefined();
  });

  it('has no card to show when the explorer is down', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    const out = await run();
    expect(out.card).toBeUndefined();
    expect(out.error).toBeTruthy();
  });

  it('says so plainly when the pool has no price right now', async () => {
    fetchMock.mockResolvedValueOnce(ok({ ...quote, price: null }));
    [1, 2, 3, 4, 5].forEach(() => fetchMock.mockResolvedValueOnce(ok(history(2))));
    const out = await run();
    expect(out.summary).toContain('sin cotización');
    expect(out.card.data.price).toBeNull();
  });
});
