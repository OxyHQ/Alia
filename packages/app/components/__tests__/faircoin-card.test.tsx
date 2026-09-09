import { readFileSync } from 'node:fs';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The FairCoin card, drawn from a stored tool result.
 *
 * FairCoin has no exchange listing, so the number on this card is the explorer's
 * INDEXED price for one Base liquidity pool. The property worth defending above
 * every other one here is that the card says so: a price off a thin pool that
 * looks exactly like a Bitcoin quote is the failure this whole card exists to
 * avoid, and `source`/`updatedAt` travel in the payload for no other reason.
 *
 * After that, the three ways to have no line — no samples yet, a single sample,
 * and a period the explorer never answered for — have to stay three different
 * things on screen. The tool distinguishes them by storing `[]` versus omitting
 * the key, and a card that collapsed them would throw that away silently.
 *
 * Each range in the fixture carries a different number of points, so the drawn
 * path says which range is on screen without the test trusting the label.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return { View: h('View'), Pressable: h('Pressable'), ScrollView: h('ScrollView') };
});
vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    default: h('Svg'),
    Path: h('Path'),
    Defs: h('Defs'),
    LinearGradient: h('LinearGradient'),
    Stop: h('Stop'),
    Line: h('Line'),
    Text: h('SvgText'),
  };
});
vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return { Text: h('Text') };
});
// `cn` shares a module with a uuid helper that pulls expo-crypto, so importing
// class-joining alone drags the native module in. Nothing here reads classes.
vi.mock('@/lib/utils', () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
}));
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({
    colors: {
      primary: 'rgb(210, 105, 230)',
      success: 'rgb(16, 185, 129)',
      error: 'rgb(220, 38, 38)',
      border: 'rgb(228, 228, 231)',
      mutedForeground: 'rgb(113, 113, 122)',
    },
  }),
}));
// `t` returns the key, and appends what it was asked to interpolate, so a test
// can read both which string was requested and the value that went into it.
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}[${Object.values(params).join('|')}]` : key,
    locale: 'en',
  }),
}));

import { FairCoinCard, type FairCoinCardData, type FairCoinPoint } from '@/components/cards/faircoin-card';

const UP = 'rgb(16, 185, 129)';
const DOWN = 'rgb(220, 38, 38)';

/** Prices on consecutive days, which is all the chart reads off the timestamps. */
const run = (prices: number[]): FairCoinPoint[] =>
  prices.map((price, i) => [Date.UTC(2026, 8, i + 1), price]);

const stored: FairCoinCardData = {
  price: 0.0421,
  changePct: -1.8,
  volume24h: 1234,
  liquidityUsd: 56789,
  marketCapUsd: 2_000_000,
  source: 'wfair-base',
  updatedAt: '2026-09-09T12:00:00.000Z',
  series: {
    // Deliberately not monotonic: a ramp puts the extremes at the ends, where
    // any bug about which end is which happens to agree with the truth.
    '24h': run([0.04, 0.045, 0.038, 0.0421]),
    '7d': run([0.035, 0.036, 0.037, 0.039, 0.042]),
    '30d': run([0.05, 0.048, 0.046, 0.044, 0.043, 0.042]),
    '1y': run([0.02, 0.025, 0.03, 0.032, 0.035, 0.04, 0.042]),
    all: run([0.01, 0.012, 0.015, 0.02, 0.026, 0.031, 0.038, 0.042]),
  },
};

function render(data: FairCoinCardData): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<FairCoinCard data={data} />); });
  if (!tree) throw new Error('act() returned without rendering');
  return tree;
}

function texts(tree: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(tree.toJSON());
  return out;
}

/**
 * Every host node matching, and none of the composites above them: the mocked
 * `react-native-svg` passes each prop straight through, so a plain `findAll`
 * counts one grid line twice.
 */
const hosts = (tree: ReactTestRenderer, match: (props: Record<string, unknown>) => boolean) =>
  tree.root.findAll((n) => typeof n.type === 'string' && match(n.props));

/** The stroked curve. The filled twin under it has `fill` set instead. */
const curve = (tree: ReactTestRenderer) =>
  hosts(tree, (p) => typeof p.d === 'string' && p.fill === 'none')[0];

const curvePath = (tree: ReactTestRenderer) => curve(tree).props.d as string;
/** Every "Lx,y" is one point after the opening "M". */
const drawnPoints = (tree: ReactTestRenderer) => curvePath(tree).split('L').length;

const rangeButtons = (tree: ReactTestRenderer) =>
  tree.root.findAll(
    (n) => typeof n.type !== 'string' && typeof n.props.accessibilityLabel === 'string'
      && n.props.accessibilityLabel.startsWith('faircoin.range.'),
  );

const offeredRanges = (tree: ReactTestRenderer) =>
  rangeButtons(tree).map((n) => n.props.accessibilityLabel as string);

function press(tree: ReactTestRenderer, range: string) {
  const button = rangeButtons(tree).find((n) => n.props.accessibilityLabel === `faircoin.range.${range}`);
  if (!button) throw new Error(`no ${range} button; the card offers ${offeredRanges(tree).join(', ')}`);
  act(() => { button.props.onPress(); });
}

/** The colour on the delta line, which is the only styled colour in the text. */
const deltaColor = (tree: ReactTestRenderer) =>
  (hosts(tree, (p) => p.style !== null && typeof p.style === 'object' && 'color' in p.style)[0]
    .props.style as { color: string }).color;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FairCoinCard', () => {
  it('shows the coin, the indexed price and the explorer\'s own 24h change', () => {
    const t = texts(render(stored));
    expect(t).toContain('faircoin.name');
    expect(t).toContain('faircoin.symbol');
    // Four hundredths of a dollar, and every digit of it.
    expect(t).toContain('$0.0421');
    // The explorer ships no absolute change, so the percentage stands alone
    // rather than being re-derived from the ends of the intraday run.
    expect(t).toContain('(-1.80%)');
    expect(t).toContain('faircoin.since.24h');
  });

  it('says on the card itself where the price came from', () => {
    // The whole reason `source` and `updatedAt` are in the payload. A price off
    // a low-liquidity pool that presents like an exchange quote is the defect.
    const t = texts(render(stored));
    expect(t).toContain('faircoin.indexed');
    expect(t).toContain('faircoin.source[wfair-base]');
    expect(t.some((line) => line.startsWith('faircoin.updated['))).toBe(true);
    // And the stamp is a rendered time, not the raw ISO string pushed at a reader.
    expect(t).not.toContain('faircoin.updated[2026-09-09T12:00:00.000Z]');
  });

  it('leaves out a stamp it could not read rather than printing "Invalid Date"', () => {
    const t = texts(render({ ...stored, updatedAt: 'whenever' }));
    expect(t.some((line) => line.startsWith('faircoin.updated['))).toBe(false);
    expect(t.join(' ')).not.toContain('Invalid Date');
    // The source is still true and still said.
    expect(t).toContain('faircoin.source[wfair-base]');
  });

  it('offers the five ranges the explorer retains, and no invented ones', () => {
    // Not the crypto card's eight: 5D, 6M, YTD and 5Y were never sampled.
    expect(offeredRanges(render(stored))).toEqual([
      'faircoin.range.24h',
      'faircoin.range.7d',
      'faircoin.range.30d',
      'faircoin.range.1y',
      'faircoin.range.all',
    ]);
  });

  it('changes range without asking anyone', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const xhrSpy = vi.fn();
    vi.stubGlobal('XMLHttpRequest', xhrSpy);

    const tree = render(stored);
    expect(drawnPoints(tree)).toBe(4);

    const counts: Record<string, number> = { '7d': 5, '30d': 6, '1y': 7, all: 8, '24h': 4 };
    for (const [range, points] of Object.entries(counts)) {
      press(tree, range);
      expect(drawnPoints(tree)).toBe(points);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });

  it('moves the selection to the range that was pressed', () => {
    const tree = render(stored);
    const selected = () =>
      rangeButtons(tree).filter((n) => n.props.accessibilityState.selected)
        .map((n) => n.props.accessibilityLabel);

    expect(selected()).toEqual(['faircoin.range.24h']);
    press(tree, '1y');
    expect(selected()).toEqual(['faircoin.range.1y']);
  });

  it('reports the selected range\'s own change, derived from its series', () => {
    const tree = render(stored);
    press(tree, '30d');
    // 0.05 down to 0.042: eight thousandths lost, a sixth of where it started.
    expect(texts(tree)).toContain('-$0.008 (-16.00%)');
    expect(texts(tree)).toContain('faircoin.since.30d');
  });

  it('colours the delta and the curve by direction, in both directions', () => {
    const tree = render(stored);
    expect(deltaColor(tree)).toBe(DOWN);
    expect(curve(tree).props.stroke).toBe(DOWN);

    press(tree, '1y');
    expect(deltaColor(tree)).toBe(UP);
    expect(curve(tree).props.stroke).toBe(UP);
  });

  it('labels the Y axis with the extremes of the range on screen', () => {
    const shown = texts(render(stored));
    // The intraday run falls between 0.038 and 0.045, and four lines divide it.
    expect(shown).toContain('0.038');
    expect(shown).toContain('0.045');
  });

  it('tells a range with no samples yet apart from one the explorer never answered', () => {
    // The tool stores `[]` for a period it asked about and got nothing for, and
    // omits the key entirely for one whose fetch failed. Collapsing the two
    // would tell a reader that 30d does not exist.
    const partial: FairCoinCardData = {
      ...stored,
      series: { '24h': stored.series['24h'], '7d': [] },
    };
    const tree = render(partial);

    // An empty period is still a period the explorer answered for, so it is
    // still offered — and pressing it says why there is no line.
    expect(offeredRanges(tree)).toEqual(['faircoin.range.24h', 'faircoin.range.7d']);
    press(tree, '7d');
    expect(texts(tree)).toContain('faircoin.noSamples');
    expect(texts(tree)).not.toContain('faircoin.noHistory');
    expect(texts(tree)).not.toContain('faircoin.noChart');

    // And the three the explorer never answered for are named rather than
    // silently missing from the control.
    expect(texts(tree)).toContain(
      'faircoin.unavailable[faircoin.range.30d, faircoin.range.1y, faircoin.range.all]',
    );
  });

  it('names no unavailable range when the explorer answered for all five', () => {
    expect(texts(render(stored)).some((line) => line.startsWith('faircoin.unavailable'))).toBe(false);
  });

  it('calls a single sample a dot rather than either kind of nothing', () => {
    const tree = render({
      ...stored,
      series: { '24h': stored.series['24h'], '7d': run([0.039]) },
    });
    press(tree, '7d');
    expect(texts(tree)).toContain('faircoin.noChart');
    expect(texts(tree)).not.toContain('faircoin.noSamples');
    expect(texts(tree)).not.toContain('faircoin.noHistory');
  });

  it('opens on a range it can actually draw', () => {
    // 24h is the range a reader wants, but landing on an empty one shows a
    // message where the chart should be for no reason.
    const tree = render({ ...stored, series: { '24h': [], '7d': stored.series['7d'] } });
    expect(drawnPoints(tree)).toBe(5);
    expect(texts(tree)).toContain('faircoin.since.7d');
  });

  it('has no history at all when the explorer answered for no period', () => {
    const tree = render({ ...stored, series: {} });
    expect(texts(tree)).toContain('faircoin.noHistory');
    expect(texts(tree)).not.toContain('faircoin.noSamples');
    expect(rangeButtons(tree)).toHaveLength(0);
    expect(hosts(tree, (p) => typeof p.d === 'string')).toHaveLength(0);
    expect(texts(tree)).toContain(
      'faircoin.unavailable[faircoin.range.24h, faircoin.range.7d, faircoin.range.30d, faircoin.range.1y, faircoin.range.all]',
    );
    // The price it does have is still a price, and still sourced.
    expect(texts(tree)).toContain('$0.0421');
    expect(texts(tree)).toContain('faircoin.source[wfair-base]');
  });

  it('says the pool had no price instead of rendering null or NaN', () => {
    // A pool with no indexed price is a real answer from the explorer, not an
    // error, and the card has to be able to say it in words.
    const tree = render({ ...stored, price: null, changePct: null });
    const t = texts(tree);
    expect(t).toContain('faircoin.noPrice');
    expect(t).toContain('faircoin.noPriceHint');
    const all = t.join(' ');
    expect(all).not.toContain('NaN');
    expect(all).not.toContain('null');
    // Losing the quote loses neither the history nor its provenance.
    expect(drawnPoints(tree)).toBe(4);
    expect(t).toContain('faircoin.source[wfair-base]');
  });

  it('does not round a sub-cent price down to nothing', () => {
    // FAIR trades far below a dollar, and two decimals turns the whole card
    // into "$0.00" — the price, the delta and the axis alike.
    const t = texts(render({
      ...stored,
      price: 0.000023,
      changePct: null,
      series: { '24h': run([0.000021, 0.000023]) },
    }));
    expect(t).toContain('$0.000023');
    expect(t).not.toContain('$0.00');
    // The axis drops the currency symbol but not the digits.
    expect(t).toContain('0.000023');
    expect(t).toContain('0.000021');
  });

  it('leaves out the numbers the pool did not report', () => {
    const t = texts(render({ ...stored, volume24h: null, liquidityUsd: null, marketCapUsd: null }));
    expect(t).not.toContain('faircoin.volume');
    expect(t).not.toContain('faircoin.liquidity');
    expect(t).not.toContain('faircoin.marketCap');
    expect(t.join(' ')).not.toContain('NaN');
  });

  it('shortens the big numbers through a translation, not a hardcoded suffix', () => {
    const t = texts(render(stored));
    expect(t).toContain('faircoin.volume');
    expect(t).toContain('faircoin.scale.thousand[1.23]');
    expect(t).toContain('faircoin.liquidity');
    expect(t).toContain('faircoin.scale.thousand[56.79]');
    expect(t).toContain('faircoin.marketCap');
    expect(t).toContain('faircoin.scale.million[2]');

    // Spanish "billón" is 10¹², not 10⁹, so every rung of the ladder has to be
    // a string somebody can translate rather than a letter appended here.
    const big = texts(render({ ...stored, liquidityUsd: 1.5e9, marketCapUsd: 2.2e12 }));
    expect(big).toContain('faircoin.scale.billion[1.5]');
    expect(big).toContain('faircoin.scale.trillion[2.2]');
  });

  it('draws a flat range in the middle instead of dividing by its own zero span', () => {
    const tree = render({ ...stored, series: { '24h': run([0.042, 0.042]) } });
    const d = curvePath(tree);
    expect(d).not.toContain('NaN');
    // Centred in the 140-unit box, not pinned to an edge, which on a price
    // chart would read as a crash rather than as no change.
    expect(d).toBe('M0.0,70.0 L274.0,70.0');
    // And one label for the one price it has, not four reading the same number.
    expect(hosts(tree, (p) => typeof p.y1 === 'number')).toHaveLength(1);
  });

  it('asks for no string that either language is missing', () => {
    const locale = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(new URL(`../../lib/i18n/locales/${name}.json`, import.meta.url), 'utf8'));
    const en = locale('en');
    const es = locale('es');
    const resolve = (root: Record<string, unknown>, key: string): unknown =>
      key.split('.').reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        root,
      );

    // Every string the card can render, collected by walking it through every
    // range and every empty state rather than from a list here that would drift
    // from the card.
    const asked = new Set<string>();
    const collect = (tree: ReactTestRenderer) => {
      for (const shown of texts(tree)) {
        const key = /^faircoin\.[\w.-]+/.exec(shown);
        if (key) asked.add(key[0]);
      }
    };

    const full = render(stored);
    collect(full);
    for (const range of ['7d', '30d', '1y', 'all']) {
      press(full, range);
      collect(full);
    }
    // The two rungs of the scale ladder this coin is nowhere near.
    collect(render({ ...stored, liquidityUsd: 1.5e9, marketCapUsd: 2.2e12 }));
    // The pool with no price.
    collect(render({ ...stored, price: null, changePct: null }));
    // The three kinds of nothing, and the roll-call of periods that failed.
    collect(render({ ...stored, series: {} }));
    const empty = render({ ...stored, series: { '24h': stored.series['24h'], '7d': [] } });
    press(empty, '7d');
    collect(empty);
    const dot = render({ ...stored, series: { '24h': stored.series['24h'], '7d': run([0.039]) } });
    press(dot, '7d');
    collect(dot);

    // Every leaf under `faircoin` in the locale file, and nothing left over on
    // either side: a key the card stopped asking for is dead weight, and one it
    // asks for that is not there is a raw key on screen.
    const leaves = (node: unknown, prefix: string): string[] =>
      node && typeof node === 'object'
        ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${prefix}.${k}`))
        : [prefix];
    expect([...asked].sort()).toEqual(leaves(en.faircoin, 'faircoin').sort());

    for (const key of asked) {
      expect(typeof resolve(en, key), `en is missing ${key}`).toBe('string');
      expect(typeof resolve(es, key), `es is missing ${key}`).toBe('string');
    }
  });
});
