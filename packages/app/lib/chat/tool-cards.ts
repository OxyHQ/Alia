import type { ToolInvocation } from '@/lib/types/messages';

/**
 * The cards a tool result draws inside the assistant turn, as data.
 *
 * Everything here is pure: the snapshot the tool stored with the message goes
 * in, and what Bloom's `LineChartCard`, `Card` and `Item` are handed comes
 * out. A thread reopened next month shows the numbers it was answered with,
 * because nothing is fetched — every range the card offers is already in the
 * snapshot. The producers are `packages/api/src/lib/tools/{weather,market,
 * faircoin}.ts` and the scheduling tool.
 */

type Translate = (key: string, params?: Record<string, string>) => string;

/** The tool results that are a card rather than a step of the turn's work. */
export const CARD_TYPES = new Set(['weather', 'market', 'faircoin', 'scheduled-task']);

export type ToolCard =
  | { type: 'weather'; data: WeatherCardData }
  | { type: 'market'; data: MarketCardData }
  | { type: 'faircoin'; data: FairCoinCardData }
  | { type: 'scheduled-task'; data: ScheduledTaskCardData };

/**
 * The card a finished call returned, if it is one this conversation draws.
 *
 * It checks the card's NAME, not the shape of its `data`, which is then cast
 * unchecked — so each card renders inside its own error boundary, and the
 * builders below guard every field they read.
 */
export function cardOf(t: ToolInvocation): ToolCard | null {
  if (t.state !== 'result') return null;
  const card = (t.result as { card?: { type?: string; data?: unknown } } | undefined)?.card;
  if (card?.type === undefined || !CARD_TYPES.has(card.type) || !card.data) return null;
  return { type: card.type, data: card.data } as ToolCard;
}

// ---------------------------------------------------------------------------
//  Shared formatting
// ---------------------------------------------------------------------------

/** `[msSinceEpoch, price]`, exactly as the tool stored it. */
export type PricePoint = [number, number];

/** A coin worth 0.000023 is not "0.00", and one worth 60000 is not "60000.000000". */
const priceDigits = (value: number) => (Math.abs(value) < 1 ? 6 : 2);

/**
 * ISO 4217 is three letters and `Intl` throws a `RangeError` on anything that
 * is not. The currency arrives from whatever the reader typed, so a typo must
 * not take the whole card down.
 */
const isCurrencyCode = (code: string) => /^[A-Za-z]{3}$/.test(code);

export function formatPrice(value: number, currency: string, locale: string): string {
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: 2,
    maximumFractionDigits: priceDigits(value),
  };
  if (!isCurrencyCode(currency)) {
    return `${value.toLocaleString(locale, options)} ${currency.toUpperCase()}`;
  }
  return value.toLocaleString(locale, { ...options, style: 'currency', currency: currency.toUpperCase() });
}

/**
 * The axis labels a price scale, not a currency: no symbol, compact, and three
 * significant digits — the chart's axis is 44px wide, and "60,000" does not fit
 * in it where "60K" does.
 */
export const formatAxis = (value: number, locale: string) =>
  value.toLocaleString(locale, { notation: 'compact', maximumSignificantDigits: 3 });

/**
 * The scale names go through a translation whole — Spanish "billón" is 10¹²,
 * not 10⁹ — so a suffix is never appended in one language and reused in the
 * next.
 */
const SCALES = [
  { at: 1e12, key: 'trillion' },
  { at: 1e9, key: 'billion' },
  { at: 1e6, key: 'million' },
  { at: 1e3, key: 'thousand' },
] as const;

function formatCompact(value: number, namespace: string, locale: string, t: Translate, fallback: string): string {
  const scale = SCALES.find((s) => Math.abs(value) >= s.at);
  if (!scale) return fallback;
  return t(`${namespace}.scale.${scale.key}`, {
    value: (value / scale.at).toLocaleString(locale, { maximumFractionDigits: 2 }),
  });
}

/**
 * A field the row did not carry reads the same as one that could not be
 * priced: `null` from the tool, `undefined` from an older row and a `NaN` that
 * survived a parse are all "no number".
 */
const quoted = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A series point as the chart reads it, labelled with its moment. */
function toPoints(series: readonly PricePoint[], intraday: boolean, locale: string) {
  return series.map(([at, value]) => ({
    label: new Date(at).toLocaleString(
      locale,
      intraday ? { hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' },
    ),
    value,
  }));
}

/** First-to-last change as a ratio, or none for a run that started at nothing. */
function runDelta(series: readonly PricePoint[]): number | undefined {
  const first = series[0][1];
  const last = series[series.length - 1][1];
  return first === 0 ? undefined : (last - first) / first;
}

export interface PriceChartRange {
  id: string;
  label: string;
  data: { label: string; value: number }[];
  headline: number;
  delta?: number;
}

/** What `LineChartCard` is handed, plus the lines the card cannot draw itself. */
export interface PriceChart {
  title: string;
  ranges: PriceChartRange[];
  defaultRange: string;
  format: (value: number) => string;
  formatAxisValue: (value: number) => string;
  /** Secondary lines under the chart, in reading order. */
  notes: string[];
}

// ---------------------------------------------------------------------------
//  Market
// ---------------------------------------------------------------------------

export interface MarketCardData {
  id: string;
  name: string;
  symbol: string;
  currency: string;
  price?: number;
  changePct?: number;
  changeAbs?: number;
  marketCap?: number;
  volume24h?: number;
  /** Optional per key: a row stored by an older version of the tool is not a crash. */
  series: Record<string, PricePoint[] | undefined>;
}

/** The order the switcher offers, not the order the tool happens to store. */
export const MARKET_RANGES = ['1D', '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'MAX'] as const;

/**
 * A quote as a line chart, or `null` when no range has two points to draw —
 * the card then says the price in words.
 *
 * A range with one point cannot be drawn and a range with none was never
 * stored, so neither is offered (YTD in the first days of January is the real
 * case). 1D reports the tool's own change rather than the ends of the series,
 * which starts whenever the window opened.
 */
export function marketChart(data: MarketCardData, t: Translate, locale: string): PriceChart | null {
  const series = data.series ?? {};
  const ranges: PriceChartRange[] = [];
  for (const id of MARKET_RANGES) {
    const run = series[id];
    if (!run || run.length < 2) continue;
    ranges.push({
      id,
      label: t(`market.range.${id}`),
      data: toPoints(run, id === '1D', locale),
      headline: quoted(data.price) ? data.price : run[run.length - 1][1],
      delta: id === '1D' && quoted(data.changePct) ? data.changePct / 100 : runDelta(run),
    });
  }
  if (ranges.length === 0) return null;

  const format = (value: number) => formatPrice(value, data.currency, locale);
  const compact = (value: number) => {
    const scaled = formatCompact(value, 'market', locale, t, '');
    return scaled === '' ? format(value) : `${scaled} ${data.currency.toUpperCase()}`;
  };
  const notes: string[] = [];
  const intraday = (series['1D'] ?? []).map(([, price]) => price);
  if (intraday.length >= 2) {
    notes.push(
      [
        `${t('market.open')} ${format(intraday[0])}`,
        `${t('market.dayHigh')} ${format(Math.max(...intraday))}`,
        `${t('market.dayLow')} ${format(Math.min(...intraday))}`,
      ].join(' · '),
    );
  }
  const totals = [
    quoted(data.volume24h) ? `${t('market.volume')} ${compact(data.volume24h)}` : null,
    quoted(data.marketCap) ? `${t('market.marketCap')} ${compact(data.marketCap)}` : null,
  ].filter((part): part is string => part !== null);
  if (totals.length > 0) notes.push(totals.join(' · '));

  return {
    title: `${data.name} · ${data.symbol}`,
    ranges,
    defaultRange: ranges.some((r) => r.id === '1D') ? '1D' : ranges[0].id,
    format,
    formatAxisValue: (value) => formatAxis(value, locale),
    notes,
  };
}

// ---------------------------------------------------------------------------
//  FairCoin
// ---------------------------------------------------------------------------

export interface FairCoinCardData {
  /** `null` is a real answer: the pool had no indexed price when asked. */
  price: number | null;
  changePct: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  /** Where the number came from, which is the one thing this card cannot drop. */
  source: string;
  updatedAt: string;
  /**
   * Absent key and empty array mean different things: the tool omits a period
   * whose fetch failed, and stores `[]` for one with no samples yet.
   */
  series: Record<string, PricePoint[] | undefined>;
}

/** Exactly what the explorer retains, in the order the switcher offers them. */
export const FAIRCOIN_RANGES = ['24h', '7d', '30d', '1y', 'all'] as const;

/**
 * FairCoin's price as a line chart, with its provenance ALWAYS in the notes.
 *
 * FairCoin has no exchange listing: the price is GeckoTerminal's indexed price
 * for a thin pool, so where it came from and when is printed in the reading
 * order — a number off a thin pool that looks exactly like an exchange quote
 * is the one thing this card must not ship. `chart` is `null` when no period
 * has two samples; the notes still say why.
 */
export function faircoinChart(
  data: FairCoinCardData,
  t: Translate,
  locale: string,
): { chart: PriceChart | null; notes: string[] } {
  const series = data.series ?? {};
  const format = (value: number) => formatPrice(value, 'USD', locale);
  const ranges: PriceChartRange[] = [];
  for (const id of FAIRCOIN_RANGES) {
    const run = series[id];
    if (!run || run.length < 2) continue;
    ranges.push({
      id,
      label: t(`faircoin.range.${id}`),
      data: toPoints(run, id === '24h', locale),
      headline: quoted(data.price) ? data.price : run[run.length - 1][1],
      delta: id === '24h' && quoted(data.changePct) ? data.changePct / 100 : runDelta(run),
    });
  }

  const notes: string[] = [t('faircoin.indexed')];
  const at = Date.parse(data.updatedAt);
  // An unparseable stamp is left out rather than printed raw: the source alone
  // is still true.
  notes.push(
    [
      t('faircoin.source', { source: data.source }),
      Number.isNaN(at)
        ? null
        : t('faircoin.updated', {
            time: new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }),
          }),
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
  );
  if (!quoted(data.price)) notes.push(t('faircoin.noPriceHint'));
  // A period the explorer never answered for is named; one it answered with too
  // few samples is said out loud, so neither reads as a period nobody asked about.
  const missing = FAIRCOIN_RANGES.filter((id) => series[id] === undefined);
  if (missing.length > 0) {
    notes.push(t('faircoin.unavailable', { ranges: missing.map((id) => t(`faircoin.range.${id}`)).join(', ') }));
  }
  if (ranges.length === 0 && missing.length < FAIRCOIN_RANGES.length) {
    const anySample = FAIRCOIN_RANGES.some((id) => (series[id]?.length ?? 0) === 1);
    notes.push(t(anySample ? 'faircoin.noChart' : 'faircoin.noSamples'));
  }
  // FairCoin's scale strings are SUFFIXES ("K", " mil"), unlike the market's
  // templates, so the number is written here and the word appended.
  const compact = (value: number) => {
    const scale = SCALES.find((s) => Math.abs(value) >= s.at);
    if (!scale) return format(value);
    const short = (value / scale.at).toLocaleString(locale, { maximumFractionDigits: 2 });
    return `$${short}${t(`faircoin.scale.${scale.key}`)}`;
  };
  const totals = [
    quoted(data.volume24h) ? `${t('faircoin.volume')} ${compact(data.volume24h)}` : null,
    quoted(data.liquidityUsd) ? `${t('faircoin.liquidity')} ${compact(data.liquidityUsd)}` : null,
    quoted(data.marketCapUsd) ? `${t('faircoin.marketCap')} ${compact(data.marketCapUsd)}` : null,
  ].filter((part): part is string => part !== null);
  if (totals.length > 0) notes.push(totals.join(' · '));

  if (ranges.length === 0) return { chart: null, notes };
  return {
    chart: {
      title: `${t('faircoin.name')} · ${t('faircoin.symbol')}`,
      ranges,
      defaultRange: ranges.some((r) => r.id === '24h') ? '24h' : ranges[0].id,
      format,
      formatAxisValue: (value) => formatAxis(value, locale),
      notes: [],
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
//  Weather
// ---------------------------------------------------------------------------

export interface WeatherCardData {
  place: string;
  timezone: string;
  current: { temperature: number; humidity: number; windSpeed: number; condition: string };
  hourly: { time: string; temperature: number; precipitationChance: number }[];
  daily: { date: string; condition: string; high: number; low: number }[];
}

/** Celsius on the wire; what the reader sees is their choice, not the answer's. */
export type TemperatureUnit = 'C' | 'F';

export const degrees = (celsius: number, unit: TemperatureUnit) =>
  `${Math.round(unit === 'C' ? celsius : (celsius * 9) / 5 + 32)}°`;

/**
 * The weekday a forecast date names, in the reader's language.
 *
 * `YYYY-MM-DD` parses as UTC midnight, which is the previous evening west of
 * Greenwich — so the day is read at noon UTC, which is the same calendar day
 * everywhere a person lives.
 */
export function forecastWeekday(date: string, locale: string): string {
  const at = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(at)) return date;
  return new Date(at).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
//  Scheduled task
// ---------------------------------------------------------------------------

export interface ScheduledTaskCardData {
  id: string;
  objective: string;
  enabled: boolean;
  trigger: import('@/lib/automations/types').AutomationTrigger;
}
