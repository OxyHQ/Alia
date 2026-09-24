import { describe, expect, it } from 'vitest';

import {
  cardOf,
  degrees,
  faircoinChart,
  forecastWeekday,
  formatPrice,
  marketChart,
  type FairCoinCardData,
  type MarketCardData,
} from '@/lib/chat/tool-cards';
import type { ToolInvocation } from '@/lib/types/messages';

/**
 * The cards a tool result draws, as the data Bloom's `LineChartCard`, `Card`
 * and `Item` are handed. The rendering is Bloom's; what is pinned here is what
 * Alia decides — which periods are offered, what the headline and the change
 * are, and that FairCoin's provenance is never dropped.
 */

/** Echoes the key and its params, so a test can see what was asked for. */
const t = (key: string, params?: Record<string, string>) =>
  params ? `${key}[${Object.values(params).join(',')}]` : key;

const HOUR = 3_600_000;
const run = (...prices: number[]): [number, number][] =>
  prices.map((price, i) => [Date.UTC(2026, 8, 1) + i * HOUR, price]);

const invocation = (result: unknown, state: ToolInvocation['state'] = 'result') =>
  ({ toolCallId: 'c1', toolName: 'weather', state, args: {}, result }) as unknown as ToolInvocation;

describe('cardOf', () => {
  it('takes a finished call whose result names a known card', () => {
    const card = cardOf(invocation({ card: { type: 'weather', data: { place: 'Madrid' } } }));
    expect(card).toEqual({ type: 'weather', data: { place: 'Madrid' } });
  });

  it('leaves a running call, an unknown card and an empty payload alone', () => {
    expect(cardOf(invocation({ card: { type: 'weather', data: {} } }, 'call'))).toBeNull();
    expect(cardOf(invocation({ card: { type: 'stocks', data: {} } }))).toBeNull();
    expect(cardOf(invocation({ card: { type: 'market' } }))).toBeNull();
    expect(cardOf(invocation(undefined))).toBeNull();
  });
});

describe('formatPrice', () => {
  it('keeps the digits a small price needs and drops the ones a big one does not', () => {
    expect(formatPrice(0.000023, 'usd', 'en-US')).toBe('$0.000023');
    expect(formatPrice(60000, 'usd', 'en-US')).toBe('$60,000.00');
  });

  it('survives a currency that is not an ISO code instead of throwing', () => {
    expect(formatPrice(12.5, 'sats', 'en-US')).toBe('12.50 SATS');
  });
});

const MARKET: MarketCardData = {
  id: 'bitcoin',
  name: 'Bitcoin',
  symbol: 'BTC',
  currency: 'usd',
  price: 110,
  changePct: 4.2,
  marketCap: 2.2e12,
  volume24h: 3.5e10,
  series: { '1D': run(100, 120, 90, 110), '1M': run(50, 100), YTD: run(70) },
};

describe('marketChart', () => {
  it('offers only the periods with a line to draw, in the switcher’s order', () => {
    const chart = marketChart(MARKET, t, 'en-US');
    expect(chart?.ranges.map((r) => r.id)).toEqual(['1D', '1M']);
    expect(chart?.defaultRange).toBe('1D');
  });

  it('reports the tool’s own change for the day, and the run’s ends for the rest', () => {
    const chart = marketChart(MARKET, t, 'en-US');
    expect(chart?.ranges[0].delta).toBeCloseTo(0.042);
    expect(chart?.ranges[1].delta).toBeCloseTo(1);
    // The headline is the quote, whichever period is showing.
    expect(chart?.ranges.every((r) => r.headline === 110)).toBe(true);
  });

  it('keeps the day’s open, high and low, and the totals, as lines under the chart', () => {
    const notes = marketChart(MARKET, t, 'en-US')?.notes ?? [];
    expect(notes[0]).toBe('market.open $100.00 · market.dayHigh $120.00 · market.dayLow $90.00');
    expect(notes[1]).toBe('market.volume market.scale.billion[35] USD · market.marketCap market.scale.trillion[2.2] USD');
  });

  it('gives up the chart, not the card, when nothing has two points', () => {
    expect(marketChart({ ...MARKET, series: { '1D': run(1) } }, t, 'en-US')).toBeNull();
    expect(marketChart({ ...MARKET, series: undefined as never }, t, 'en-US')).toBeNull();
  });
});

const FAIR: FairCoinCardData = {
  price: 0.04,
  changePct: -2,
  volume24h: 1234,
  liquidityUsd: null,
  marketCapUsd: 2_000_000,
  source: 'GeckoTerminal',
  updatedAt: '2026-09-01T10:00:00Z',
  series: { '24h': run(0.05, 0.04), '7d': [], '30d': run(0.03) },
};

describe('faircoinChart', () => {
  it('always says where the price came from, first', () => {
    const { notes } = faircoinChart(FAIR, t, 'en-US');
    expect(notes[0]).toBe('faircoin.indexed');
    expect(notes[1]).toMatch(/^faircoin\.source\[GeckoTerminal\] · faircoin\.updated\[/);
  });

  it('names the periods the explorer never answered for', () => {
    const { notes } = faircoinChart(FAIR, t, 'en-US');
    expect(notes).toContain('faircoin.unavailable[faircoin.range.1y, faircoin.range.all]');
  });

  it('writes its totals as number and suffix, since its scale strings are suffixes', () => {
    const { notes } = faircoinChart(FAIR, t, 'en-US');
    expect(notes[notes.length - 1]).toBe(
      'faircoin.volume $1.23faircoin.scale.thousand · faircoin.marketCap $2faircoin.scale.million',
    );
  });

  it('charts the drawable periods with the explorer’s own day change', () => {
    const { chart } = faircoinChart(FAIR, t, 'en-US');
    expect(chart?.ranges.map((r) => r.id)).toEqual(['24h']);
    expect(chart?.ranges[0].delta).toBeCloseTo(-0.02);
  });

  it('says why there is no line, and that there is no price, rather than drawing nothing', () => {
    const { chart, notes } = faircoinChart(
      { ...FAIR, price: null, series: { '24h': run(0.04), '7d': [] } },
      t,
      'en-US',
    );
    expect(chart).toBeNull();
    expect(notes).toContain('faircoin.noPriceHint');
    expect(notes).toContain('faircoin.noChart');
  });

  it('leaves an unreadable timestamp out instead of printing it', () => {
    const { notes } = faircoinChart({ ...FAIR, updatedAt: 'yesterday' }, t, 'en-US');
    expect(notes[1]).toBe('faircoin.source[GeckoTerminal]');
  });
});

describe('weather', () => {
  it('converts Celsius on the wire to the reader’s unit', () => {
    expect(degrees(20, 'C')).toBe('20°');
    expect(degrees(20, 'F')).toBe('68°');
  });

  it('names a forecast date’s own weekday wherever the reader is', () => {
    expect(forecastWeekday('2026-09-24', 'en-US')).toBe('Thu');
    expect(forecastWeekday('not a date', 'en-US')).toBe('not a date');
  });
});
