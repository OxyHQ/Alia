import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A malformed block spoils its own corner and nothing else.
 *
 * ## The exposure
 *
 * `cardOf` in `chat-interface.tsx` validates the card's NAME — that
 * `card.type` is one of four known strings and `card.data` is truthy — and then
 * hands the payload over with an unchecked cast:
 *
 *     <WeatherCard data={card.data as WeatherCardData} />
 *
 * `WeatherCard` reads `data.daily[selectedDay]`, `data.hourly.filter(...)` and
 * `data.current.temperature` with no guards, so a result shaped
 * `{ type: 'weather', data: { place: 'Madrid' } }` satisfies every check that
 * is made and then throws on the first read.
 *
 * A throw during render unwinds to the nearest boundary. Between a message row
 * and `AppErrorBoundary` in `app/(app)/_layout.tsx` there was none — so one bad
 * block replaced the whole app scene with the crash screen, and reopening the
 * conversation hit the same block again. That is not a broken card, it is an
 * unreadable conversation.
 *
 * ## What is tested
 *
 * Both halves, because either alone proves nothing:
 *
 * 1. The real `WeatherCard` genuinely throws on a payload that `cardOf` would
 *    let through. If it ever stops throwing — because it grew its own guards —
 *    this test fails and says so, which is the right moment to revisit whether
 *    the boundary is still earning its place.
 * 2. The boundary catches it, says so in words, and keeps rendering everything
 *    around it.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('RNText'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s },
  };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  return { AlertTriangle: (props: Record<string, unknown>) => ReactModule.createElement('AlertTriangle', props) };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { foreground: '#000', primary: '#000', muted: '#eee' }, isDarkColorScheme: false }),
}));

vi.mock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }));

vi.mock('@/components/cards/card-surface', async () => {
  const ReactModule = await import('react');
  return {
    CardSurface: ({ children }: React.PropsWithChildren) => ReactModule.createElement('CardSurface', null, children),
  };
});

vi.mock('@/components/cards/area-chart', async () => {
  const ReactModule = await import('react');
  return {
    AreaChart: () => ReactModule.createElement('AreaChart'),
    areaGeometry: () => null,
  };
});

import { MessageBlockBoundary } from '@/components/chat/message-block-boundary';
import { WeatherCard, type WeatherCardData } from '@/components/cards/weather-card';

/** What a tool could return that `cardOf` accepts and `WeatherCard` cannot read. */
const MALFORMED = { place: 'Madrid' } as unknown as WeatherCardData;

let consoleError: { mockRestore: () => void };

beforeEach(() => {
  // React logs a caught boundary error; the noise is not the subject.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('a malformed card', () => {
  it('really does throw — the exposure is not hypothetical', () => {
    expect(() => {
      act(() => { create(React.createElement(WeatherCard, { data: MALFORMED })); });
    }).toThrow();
  });
});

describe('MessageBlockBoundary', () => {
  it('contains the throw and says what happened', () => {
    let renderer: any;

    expect(() => {
      act(() => {
        renderer = create(
          React.createElement(
            MessageBlockBoundary,
            null,
            React.createElement(WeatherCard, { data: MALFORMED }),
          ),
        );
      });
    }).not.toThrow();

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('chat.blockFailed');
  });

  it('leaves the rest of the turn standing', () => {
    let renderer: any;

    act(() => {
      renderer = create(
        React.createElement(
          'Turn',
          null,
          React.createElement(
            MessageBlockBoundary,
            null,
            React.createElement(WeatherCard, { data: MALFORMED }),
          ),
          React.createElement('TheRestOfTheAnswer'),
        ),
      );
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('TheRestOfTheAnswer');
    expect(text).toContain('chat.blockFailed');
  });

  it('draws nothing of its own when the block is fine', () => {
    let renderer: any;

    act(() => {
      renderer = create(
        React.createElement(MessageBlockBoundary, null, React.createElement('AGoodBlock')),
      );
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('AGoodBlock');
    expect(text).not.toContain('chat.blockFailed');
  });

  it('reports the failure rather than swallowing it', () => {
    const seen: Error[] = [];

    act(() => {
      create(
        React.createElement(MessageBlockBoundary, {
          onError: (error: Error) => { seen.push(error); },
          children: React.createElement(WeatherCard, { data: MALFORMED }),
        }),
      );
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Error);
  });
});
