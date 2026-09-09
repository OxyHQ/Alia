import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * The weather card, drawn from a stored tool result.
 *
 * The fixture is deliberately shaped like a row in `tool_invocations` rather
 * than like live state, because the property worth defending is that the card
 * needs nothing but that row: pressing a day or flipping the unit must not
 * reach the network, or a thread reopened next month would show today's weather
 * under a month-old question — or nothing at all.
 *
 * Celsius is what the wire carries, so the Fahrenheit assertions are also
 * asserting that the STORED answer did not depend on the reader's preference.
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
  return { default: h('Svg'), Path: h('Path'), Defs: h('Defs'), LinearGradient: h('LinearGradient'), Stop: h('Stop') };
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
vi.mock('@/lib/useColorScheme', () => ({ useColorScheme: () => ({ colors: { primary: '#d269e6' } }) }));
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (k: string) => k, locale: 'en' }),
}));

import { WeatherCard, type WeatherCardData } from '@/components/cards/weather-card';

const stored: WeatherCardData = {
  place: 'Barcelona, Cataluña, España',
  timezone: 'Europe/Madrid',
  current: { temperature: 28, humidity: 61, windSpeed: 12, condition: 'partly-cloudy' },
  hourly: [
    { time: '2026-09-09T00:00', temperature: 24, precipitationChance: 10 },
    { time: '2026-09-09T06:00', temperature: 22, precipitationChance: 0 },
    { time: '2026-09-09T12:00', temperature: 29, precipitationChance: 5 },
    { time: '2026-09-10T00:00', temperature: 19, precipitationChance: 40 },
    { time: '2026-09-10T12:00', temperature: 26, precipitationChance: 60 },
  ],
  daily: [
    { date: '2026-09-09', condition: 'partly-cloudy', high: 29, low: 22 },
    { date: '2026-09-10', condition: 'thunderstorm', high: 27, low: 19 },
  ],
};

function render(data: WeatherCardData) {
  let tree: ReactTestRenderer;
  act(() => { tree = create(<WeatherCard data={data} />); });
  return tree!;
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

const dayButtons = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => n.props.accessibilityState !== undefined && typeof n.type !== 'string');

describe('WeatherCard', () => {
  it('shows the place and the current temperature in Celsius', () => {
    const t = texts(render(stored));
    expect(t).toContain('Barcelona, Cataluña, España');
    expect(t).toContain('28°');
  });

  it('converts to Fahrenheit without asking anyone', () => {
    const tree = render(stored);
    const toggle = tree.root.findByProps({ accessibilityLabel: 'weather.toggleUnit' });
    act(() => { toggle.props.onPress(); });
    // 28C is 82.4F, and the high of 29C is 84.2F.
    expect(texts(tree)).toContain('82°');
    expect(texts(tree)).toContain('84°');
  });

  it('opens on today and moves the selection when another day is pressed', () => {
    const tree = render(stored);
    expect(dayButtons(tree)[0].props.accessibilityState.selected).toBe(true);

    act(() => { dayButtons(tree)[1].props.onPress(); });

    expect(dayButtons(tree)[0].props.accessibilityState.selected).toBe(false);
    expect(dayButtons(tree)[1].props.accessibilityState.selected).toBe(true);
  });

  it('charts the hours of the day you selected, not the whole week', () => {
    const tree = render(stored);
    const pathOf = (t: ReactTestRenderer) =>
      t.root.findAll((n) => typeof n.props.d === 'string' && n.props.fill === 'none')[0].props.d;

    const firstDay = pathOf(tree);
    act(() => { dayButtons(tree)[1].props.onPress(); });
    const secondDay = pathOf(tree);

    // Three hours on the 9th, two on the 10th: different curves, and the second
    // has one fewer point.
    expect(secondDay).not.toBe(firstDay);
    expect(firstDay.split('L')).toHaveLength(3);
    expect(secondDay.split('L')).toHaveLength(2);
  });

  it('draws a flat day instead of dividing by its own zero span', () => {
    const flat: WeatherCardData = {
      ...stored,
      hourly: [
        { time: '2026-09-09T00:00', temperature: 20, precipitationChance: 0 },
        { time: '2026-09-09T12:00', temperature: 20, precipitationChance: 0 },
      ],
    };
    const tree = render(flat);
    const d = tree.root.findAll((n) => typeof n.props.d === 'string' && n.props.fill === 'none')[0].props.d as string;
    expect(d).not.toContain('NaN');
  });
});
