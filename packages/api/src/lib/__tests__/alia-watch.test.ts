import { describe, expect, it, vi } from 'vitest';
import {
  decideWatch,
  normalizeWatchText,
  observeWatchSource,
  watchConfigOf,
  watchTriggerContext,
  watchTriggerId,
  WatchSourceError,
  type WatchSources,
} from '../alia-watch.js';
import { watchBackoffMs } from '../../db/automation/automationWatchRepository.js';

function sources(overrides: Partial<WatchSources> = {}): WatchSources {
  return {
    searchWeb: vi.fn(async () => ({ results: [], count: 0 })),
    readWebPage: vi.fn(async () => ({ error: 'unused' })) as unknown as WatchSources['readWebPage'],
    ...overrides,
  };
}

const result = (url: string, snippet = 's') => ({ title: `T ${url}`, url, snippet });

describe('a watch configuration', () => {
  it('takes exactly one source and a value for contains', () => {
    expect(watchConfigOf({ watch: { query: 'Meta announces' } })).toEqual({
      query: 'Meta announces',
      condition: 'change',
    });
    expect(
      watchConfigOf({
        watch: { url: 'https://example.com', condition: 'contains', value: 'Llama' },
      }),
    ).toMatchObject({ condition: 'contains', value: 'Llama' });
    expect(watchConfigOf({ watch: { query: 'x y', url: 'https://example.com' } })).toBeNull();
    expect(watchConfigOf({ watch: {} })).toBeNull();
    expect(
      watchConfigOf({ watch: { url: 'https://example.com', condition: 'contains' } }),
    ).toBeNull();
    expect(watchConfigOf({ instructions: 'no watch' })).toBeNull();
  });
});

describe('the cheap observation', () => {
  it('hashes a query by its result URLs only, so snippet churn is not a change', async () => {
    const first = await observeWatchSource(
      { query: 'meta', condition: 'change' },
      sources({
        searchWeb: vi.fn(async () => ({ results: [result('b', 'one'), result('a')], count: 2 })),
      }),
    );
    const second = await observeWatchSource(
      { query: 'meta', condition: 'change' },
      sources({
        searchWeb: vi.fn(async () => ({ results: [result('a'), result('b', 'two')], count: 2 })),
      }),
    );
    expect(first.items).toEqual(['a', 'b']);
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes a page by its normalised text', async () => {
    const read = (content: string) =>
      sources({
        readWebPage: vi.fn(async () => ({
          title: 'News',
          content,
        })) as unknown as WatchSources['readWebPage'],
      });
    const one = await observeWatchSource(
      { url: 'https://example.com', condition: 'change' },
      read('Hello   world\n'),
    );
    const two = await observeWatchSource(
      { url: 'https://example.com', condition: 'change' },
      read(' Hello world'),
    );
    const three = await observeWatchSource(
      { url: 'https://example.com', condition: 'change' },
      read('Hello there'),
    );
    expect(one.hash).toBe(two.hash);
    expect(one.hash).not.toBe(three.hash);
    expect(normalizeWatchText(' a \n\t b ')).toBe('a b');
  });

  it('turns a failed source into a WatchSourceError', async () => {
    await expect(
      observeWatchSource(
        { query: 'meta', condition: 'change' },
        sources({
          searchWeb: vi.fn(async () => ({ results: [], count: 0, error: 'clarity down' })),
        }),
      ),
    ).rejects.toBeInstanceOf(WatchSourceError);
    await expect(
      observeWatchSource({ url: 'https://example.com', condition: 'change' }, sources()),
    ).rejects.toBeInstanceOf(WatchSourceError);
  });
});

describe('deciding whether to wake Alia', () => {
  const observation = (items: string[], text = '', hash = items.join(',')) => ({
    hash,
    items,
    text,
    results: items.map((url) => result(url)),
  });

  it('treats the first good tick of a change watch as a baseline', () => {
    expect(decideWatch({ query: 'm', condition: 'change' }, null, observation(['a']))).toEqual({
      fire: false,
      changed: false,
      matched: false,
      newItems: [],
    });
  });

  it('fires on a new result but not on a reshuffle or a result dropping out', () => {
    const previous = { lastHash: 'a,b', lastItems: ['a', 'b'], matched: false };
    expect(
      decideWatch({ query: 'm', condition: 'change' }, previous, observation(['a', 'b', 'c'])),
    ).toMatchObject({ fire: true, changed: true, newItems: ['c'] });
    expect(
      decideWatch({ query: 'm', condition: 'change' }, previous, observation(['a'])),
    ).toMatchObject({ fire: false, changed: false });
  });

  it('fires a page watch when its hash moves', () => {
    const config = { url: 'https://example.com', condition: 'change' as const };
    expect(
      decideWatch(
        config,
        { lastHash: 'h1', lastItems: [], matched: false },
        observation([], 'x', 'h2'),
      ).fire,
    ).toBe(true);
    expect(
      decideWatch(
        config,
        { lastHash: 'h1', lastItems: [], matched: false },
        observation([], 'x', 'h1'),
      ).fire,
    ).toBe(false);
  });

  it('fires a contains watch on the rising edge, the first tick included', () => {
    const config = { url: 'https://example.com', condition: 'contains' as const, value: 'Llama 5' };
    expect(decideWatch(config, null, observation([], 'now: llama 5 is out')).fire).toBe(true);
    expect(
      decideWatch(
        config,
        { lastHash: 'h', lastItems: [], matched: true },
        observation([], 'llama 5 again', 'h2'),
      ).fire,
    ).toBe(false);
    expect(
      decideWatch(
        config,
        { lastHash: 'h', lastItems: [], matched: true },
        observation([], 'gone', 'h3'),
      ),
    ).toMatchObject({ fire: false, matched: false });
  });

  it('keys the run by observation and shows the model only what is new', () => {
    expect(watchTriggerId('auto-1', 'abc')).toBe('watch:auto-1:abc');
    const context = watchTriggerContext(
      { query: 'm', condition: 'change' },
      observation(['a', 'b']),
      { fire: true, changed: true, matched: false, newItems: ['b'] },
    );
    expect(context).toEqual({
      source: { query: 'm' },
      condition: 'change',
      newResults: [result('b')],
    });
  });
});

describe('the failure backoff', () => {
  it('is min(60, 2^n) minutes', () => {
    expect([1, 2, 3, 5, 6, 9].map((n) => watchBackoffMs(n) / 60_000)).toEqual([
      2, 4, 8, 32, 60, 60,
    ]);
  });
});
