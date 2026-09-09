import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMarketQuoteTool } from '../market.js';

/**
 * What the crypto tool puts into a message.
 *
 * NOT verified against CoinGecko. `fetch` is mocked here, so these fix the
 * transformation — the slicing, the YTD cut, the shape the card reads — and say
 * nothing about whether the upstream fields are still called this. One real
 * call is what settles that, and it has not been made.
 *
 * What they do defend is the reason the tool exists in this shape: the card
 * offers eight ranges and this makes two requests, deriving the rest by slicing
 * one daily history. Eight calls per question would burn a free-tier minute,
 * and a card that re-fetched per range would show today's price under a
 * month-old question.
 */

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

const DAY = 86_400_000;
/** `days` daily points ending today, priced 100, 101, 102 … */
const dailySeries = (days: number): [number, number][] =>
  Array.from({ length: days }, (_, i) => [Date.now() - (days - 1 - i) * DAY, 100 + i]);

const ok = (body: unknown) => ({ ok: true, json: async () => body });

function mockAll({ daily = dailySeries(800) } = {}) {
  fetchMock
    .mockResolvedValueOnce(ok({ coins: [{ id: 'bitcoin', name: 'Bitcoin', symbol: 'btc' }] }))
    .mockResolvedValueOnce(ok({ prices: [[1, 79000], [2, 79500]] }))          // intraday
    .mockResolvedValueOnce(ok({ prices: daily }))                              // daily history
    .mockResolvedValueOnce(ok({ bitcoin: { usd: 78420, usd_24h_change: -0.7, usd_24h_vol: 42, usd_market_cap: 1_500_000 } }));
}

const run = (coin = 'bitcoin', currency = 'usd') =>
  (getMarketQuoteTool.execute as (i: { coin: string; currency: string }, o: unknown) => Promise<any>)(
    { coin, currency }, {},
  );

describe('getMarketQuote', () => {
  it('makes two history requests, not one per range', async () => {
    mockAll();
    await run();
    const chartCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('market_chart'));
    expect(chartCalls).toHaveLength(2);
  });

  it('carries every range the card can offer', async () => {
    mockAll();
    const out = await run();
    expect(Object.keys(out.card.data.series).sort()).toEqual(
      ['1D', '1M', '1Y', '5D', '5Y', '6M', 'MAX', 'YTD'],
    );
  });

  it('slices the shorter ranges out of the daily history', async () => {
    mockAll({ daily: dailySeries(800) });
    const out = await run();
    expect(out.card.data.series['5D']).toHaveLength(5);
    expect(out.card.data.series['1M']).toHaveLength(30);
    expect(out.card.data.series.MAX).toHaveLength(800);
  });

  it('cuts YTD at the turn of the year rather than a fixed day count', async () => {
    mockAll({ daily: dailySeries(800) });
    const out = await run();
    const startOfYear = Date.UTC(new Date().getUTCFullYear(), 0, 1);
    const ytd: [number, number][] = out.card.data.series.YTD;
    expect(ytd.every(([at]) => at >= startOfYear)).toBe(true);
    // 800 days always spans a new year, so YTD is a real cut, not the whole set.
    expect(ytd.length).toBeLessThan(800);
  });

  it('reports the quote the card renders', async () => {
    mockAll();
    const out = await run();
    expect(out.card.data).toMatchObject({
      symbol: 'BTC', currency: 'usd', price: 78420, changePct: -0.7, marketCap: 1_500_000,
    });
  });

  it('says which coin it could not find', async () => {
    fetchMock.mockResolvedValueOnce(ok({ coins: [] }));
    const out = await run('Kwyjibo');
    expect(out.error).toContain('Kwyjibo');
    expect(out.card).toBeUndefined();
  });

  it('does not invent a card when the upstream is down', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ coins: [{ id: 'bitcoin', name: 'Bitcoin', symbol: 'btc' }] }))
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce(ok({ prices: [] }))
      .mockResolvedValueOnce(ok({}));
    const out = await run();
    expect(out.card).toBeUndefined();
    expect(out.error).toBeTruthy();
  });
});
