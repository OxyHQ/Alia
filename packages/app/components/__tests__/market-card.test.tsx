import { readFileSync } from 'node:fs';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The market card, drawn from a stored tool result.
 *
 * The fixture is shaped like a row in `tool_invocations` rather than like live
 * state, because the property worth defending is the one the tool spent two
 * requests to buy: every range the card offers is already in that row. Pressing
 * 5Y must not reach the network, or a thread reopened next month would show
 * today's price under a month-old question — or nothing at all.
 *
 * Each range in the fixture has a different number of points, so the drawn path
 * says which range is on screen without the test having to trust the label.
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
// can read both which string was requested and the number that went into it.
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}[${Object.values(params).join('|')}]` : key,
    locale: 'en',
  }),
}));

import { MarketCard, type MarketCardData, type MarketPoint } from '@/components/cards/market-card';

const UP = 'rgb(16, 185, 129)';
const DOWN = 'rgb(220, 38, 38)';

/** A run of `count` points from `start`, moving by `step` each time. */
function ramp(count: number, start: number, step: number): MarketPoint[] {
  return Array.from({ length: count }, (_, i) => [Date.UTC(2026, 8, i + 1), start + step * i]);
}

const stored: MarketCardData = {
  id: 'bitcoin',
  name: 'Bitcoin',
  symbol: 'BTC',
  currency: 'usd',
  price: 104,
  changePct: 4.5,
  changeAbs: 4.48,
  marketCap: 1.23e12,
  volume24h: 4.5e9,
  series: {
    // Intraday, and deliberately not monotonic: the day's high and low are read
    // off it, and a ramp would put them at the ends where any bug agrees.
    '1D': [
      [Date.UTC(2026, 8, 9, 0), 100],
      [Date.UTC(2026, 8, 9, 6), 108],
      [Date.UTC(2026, 8, 9, 12), 96],
      [Date.UTC(2026, 8, 9, 18), 104],
    ],
    '5D': ramp(5, 92, 3),
    // The one that fell: 130 down to 104 is a fifth of where it started.
    '1M': [130, 126, 120, 115, 110, 104].map((p, i): MarketPoint => [Date.UTC(2026, 8, i + 1), p]),
    '6M': ramp(7, 70, 5),
    YTD: ramp(8, 60, 6),
    '1Y': ramp(9, 50, 7),
    '5Y': ramp(10, 30, 8),
    MAX: ramp(11, 10, 9),
  },
};

function render(data: MarketCardData): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => { tree = create(<MarketCard data={data} />); });
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
      && n.props.accessibilityLabel.startsWith('market.range.'),
  );

function press(tree: ReactTestRenderer, range: string) {
  const button = rangeButtons(tree).find((n) => n.props.accessibilityLabel === `market.range.${range}`);
  if (!button) throw new Error(`no ${range} button; the card offers ${rangeButtons(tree).length}`);
  act(() => { button.props.onPress(); });
}

/** The colour on the delta line, which is the only styled colour in the text. */
const deltaColor = (tree: ReactTestRenderer) =>
  (hosts(tree, (p) => p.style !== null && typeof p.style === 'object' && 'color' in p.style)[0]
    .props.style as { color: string }).color;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MarketCard', () => {
  it('shows the coin, the quoted price and the quote\'s own 24h change', () => {
    const t = texts(render(stored));
    expect(t).toContain('Bitcoin');
    expect(t).toContain('BTC');
    expect(t).toContain('$104.00');
    // The tool ships `changeAbs` precisely so two clients cannot round it two
    // different ways; the card must not re-derive it from the intraday ends.
    expect(t).toContain('+$4.48 (+4.50%)');
    expect(t).toContain('market.since.1D');
  });

  it('changes range without asking anyone', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const xhrSpy = vi.fn();
    vi.stubGlobal('XMLHttpRequest', xhrSpy);

    const tree = render(stored);
    expect(drawnPoints(tree)).toBe(4);

    // Every range in the payload, in the order the control offers them.
    const counts: Record<string, number> = {
      '5D': 5, '1M': 6, '6M': 7, YTD: 8, '1Y': 9, '5Y': 10, MAX: 11, '1D': 4,
    };
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

    expect(selected()).toEqual(['market.range.1D']);
    press(tree, '6M');
    expect(selected()).toEqual(['market.range.6M']);
  });

  it('reports the selected range\'s own change, derived from its series', () => {
    const tree = render(stored);
    press(tree, '1M');
    // 130 down to 104: 26 lost, a fifth of where it started.
    expect(texts(tree)).toContain('-$26.00 (-20.00%)');
    expect(texts(tree)).toContain('market.since.1M');
  });

  it('colours the delta and the curve by direction, in both directions', () => {
    const tree = render(stored);
    expect(deltaColor(tree)).toBe(UP);
    expect(curve(tree).props.stroke).toBe(UP);

    press(tree, '1M');
    expect(deltaColor(tree)).toBe(DOWN);
    expect(curve(tree).props.stroke).toBe(DOWN);
  });

  it('labels the Y axis with the extremes of the range on screen', () => {
    const tree = render(stored);
    const shown = texts(tree);
    // The intraday series runs 96 to 108, and four grid lines divide it.
    expect(shown).toContain('96');
    expect(shown).toContain('108');

    const gridY = hosts(tree, (p) => typeof p.y1 === 'number').map((n) => n.props.y1 as number);
    expect(gridY).toHaveLength(4);
    // Top line for the high, bottom line for the low, inside the 140 box.
    expect(Math.min(...gridY)).toBeCloseTo(8, 5);
    expect(Math.max(...gridY)).toBeCloseTo(132, 5);
  });

  it('reads the day open, high and low off the intraday series', () => {
    const t = texts(render(stored));
    expect(t).toContain('market.open');
    expect(t).toContain('$100.00');
    expect(t).toContain('market.dayHigh');
    expect(t).toContain('$108.00');
    expect(t).toContain('market.dayLow');
    expect(t).toContain('$96.00');
  });

  it('shortens the big numbers through a translation, not a hardcoded suffix', () => {
    const t = texts(render(stored));
    expect(t).toContain('market.scale.trillion[1.23] USD');
    expect(t).toContain('market.scale.billion[4.5] USD');

    // Spanish "billón" is 10¹², not 10⁹, so every rung of the ladder has to be
    // a string somebody can translate rather than a letter appended here.
    const small = texts(render({ ...stored, marketCap: 5.5e6, volume24h: 9.9e3 }));
    expect(small).toContain('market.scale.million[5.5] USD');
    expect(small).toContain('market.scale.thousand[9.9] USD');
  });

  it('leaves out the stats the quote did not carry', () => {
    const { marketCap, volume24h, ...rest } = stored;
    const t = texts(render(rest));
    expect(t).not.toContain('market.marketCap');
    expect(t).not.toContain('market.volume');
    // The ones read off the series it does have are still there.
    expect(t).toContain('market.dayHigh');
  });

  it('drops the whole stats grid when there is no intraday series either', () => {
    const { marketCap, volume24h, ...rest } = stored;
    const { '1D': intraday, ...series } = rest.series;
    const t = texts(render({ ...rest, series }));
    expect(t).not.toContain('market.open');
    expect(t).not.toContain('market.dayHigh');
    expect(t).not.toContain('market.dayLow');
    // And it still draws, from whatever range is left.
    expect(t).not.toContain('market.noChart');
  });

  it('says so instead of inventing a price when the quote failed', () => {
    const t = texts(render({ ...stored, price: undefined, changePct: undefined, changeAbs: undefined }));
    expect(t).toContain('market.noPrice');
    // Without the quote's own change the card falls back to the series ends,
    // which for the intraday run is 100 to 104.
    expect(t).toContain('+$4.00 (+4.00%)');
  });

  it('does not round a sub-cent coin down to nothing', () => {
    // Most coins trade well under a dollar, and two decimals turns every one of
    // them into "$0.00" — price, open, high and low alike.
    const t = texts(render({
      ...stored,
      price: 0.000023,
      changePct: 9.5,
      changeAbs: 0.000002,
      series: {
        '1D': [[Date.UTC(2026, 8, 9, 0), 0.000021], [Date.UTC(2026, 8, 9, 12), 0.000023]],
      },
    }));
    expect(t).toContain('$0.000023');
    expect(t).toContain('$0.000021');
    // And the axis, which drops the currency symbol but not the digits.
    expect(t).toContain('0.000023');
    expect(t).toContain('0.000021');
  });

  it('does not fall over on a currency code that is not one', () => {
    // `currency` is whatever the reader typed at the tool, and `Intl` throws a
    // RangeError on anything that is not three letters — which would take the
    // whole card down rather than just the symbol in front of the price.
    const t = texts(render({ ...stored, currency: 'sats' }));
    expect(t).toContain('104.00 SATS');
    expect(t).toContain('market.scale.trillion[1.23] SATS');
  });

  it('does not offer a range it cannot draw', () => {
    const sparse: MarketCardData = {
      ...stored,
      series: {
        '1D': stored.series['1D'],
        '5D': stored.series['5D'],
        // One point is a dot, not a line. YTD in the first days of January.
        YTD: [[Date.UTC(2026, 0, 1), 99]],
      },
    };
    const offered = rangeButtons(render(sparse)).map((n) => n.props.accessibilityLabel);
    expect(offered).toEqual(['market.range.1D', 'market.range.5D']);
  });

  it('draws a flat range in the middle instead of dividing by its own zero span', () => {
    const flat: MarketCardData = {
      ...stored,
      series: { '1D': [[Date.UTC(2026, 8, 9, 0), 20], [Date.UTC(2026, 8, 9, 12), 20]] },
    };
    const tree = render(flat);
    const d = curvePath(tree);
    expect(d).not.toContain('NaN');
    // Centred in the 140-unit box, not pinned to an edge.
    expect(d).toBe('M0.0,70.0 L274.0,70.0');
    // And one label for the one price it has, not four reading the same number.
    expect(hosts(tree, (p) => typeof p.y1 === 'number')).toHaveLength(1);
  });

  it('has nothing to draw and no ranges to offer when every series is a dot', () => {
    const dots: MarketCardData = {
      ...stored,
      series: { '1D': [[Date.UTC(2026, 8, 9), 104]] },
    };
    const tree = render(dots);
    expect(texts(tree)).toContain('market.noChart');
    expect(rangeButtons(tree)).toHaveLength(0);
    expect(hosts(tree, (p) => typeof p.d === 'string')).toHaveLength(0);
  });

  it('thins a five-year history down to what the box can show', () => {
    const long: MarketCardData = {
      ...stored,
      series: { ...stored.series, MAX: ramp(1000, 104, 0.1) },
    };
    const tree = render(long);
    press(tree, 'MAX');
    expect(drawnPoints(tree)).toBe(180);
    // The last sample has to be the last point, not one past the end.
    expect(curvePath(tree)).not.toContain('NaN');
    expect(curvePath(tree)).toContain('M0.0,132.0');
  });

  it('gives each card its own gradient, because SVG ids are document-global', () => {
    let rendered: ReactTestRenderer | undefined;
    act(() => {
      rendered = create(<><MarketCard data={stored} /><MarketCard data={stored} /></>);
    });
    if (!rendered) throw new Error('act() returned without rendering');
    const tree = rendered;

    const ids = hosts(tree, (p) => typeof p.id === 'string').map((n) => n.props.id as string);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // And each area is filled from its own definition rather than from whichever
    // card happened to define that name last.
    const fills = hosts(tree, (p) => typeof p.d === 'string' && p.fill !== 'none')
      .map((n) => n.props.fill as string);
    expect(fills).toEqual(ids.map((id) => `url(#${id})`));
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
    // range rather than from a list here that would drift from the card.
    let tree = render(stored);
    const asked = new Set<string>();
    const collect = () => {
      for (const shown of texts(tree)) {
        const key = /^market\.[\w.-]+/.exec(shown);
        if (key) asked.add(key[0]);
      }
    };
    collect();
    for (const range of ['5D', '1M', '6M', 'YTD', '1Y', '5Y', 'MAX']) {
      press(tree, range);
      collect();
    }
    // The two smaller rungs of the scale ladder, which this coin is past.
    tree = render({ ...stored, marketCap: 5.5e6, volume24h: 9.9e3 });
    collect();
    for (const extra of ['market.noPrice', 'market.noChart']) asked.add(extra);

    // 8 ranges + 8 since + 5 stat labels + 4 scales + 2 empties.
    expect(asked.size).toBe(27);
    for (const key of asked) {
      expect(typeof resolve(en, key), `en is missing ${key}`).toBe('string');
      expect(typeof resolve(es, key), `es is missing ${key}`).toBe('string');
    }
  });
});
