import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The app feeds the SDK's suggestions with its API's: the settled draft asks the search, and the
 * welcome list and the matches go in keyed by `id`. What a row looks like, which rows a draft gets
 * and how the keyboard moves are the SDK's, tested in `@alia.onl/sdk`.
 */

const seen = vi.hoisted(() => ({
  welcome: [] as unknown[],
  matches: [] as unknown[],
  searched: [] as string[],
  sdk: [] as Array<Record<string, unknown>>,
  query: 'settled',
}));

vi.mock('@/features/chat/runtime/use-suggestions', () => ({
  useWelcomeSuggestions: () => ({ data: seen.welcome }),
  useSearchSuggestions: (query: string) => {
    seen.searched.push(query);
    return { data: seen.matches };
  },
}));
vi.mock('@alia.onl/sdk', () => ({
  useSuggestionQuery: () => seen.query,
  useComposerSuggestions: (input: Record<string, unknown>) => {
    seen.sdk.push(input);
    return { completions: [], selected: -1, onKeyPress: vi.fn() };
  },
}));

const { useComposerSuggestions } = await import('@/features/chat/ui/composer/composer-suggestions');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const suggestion = (id: string, text: string) => ({ suggestionId: id, title: text, text });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  seen.welcome = [];
  seen.matches = [];
  seen.searched = [];
  seen.sdk = [];
});

function mount(draft: string, onPick = vi.fn(), enabled = true) {
  function Probe() {
    useComposerSuggestions({ draft, enabled, onPick });
    return null;
  }
  act(() => {
    renderer = create(<Probe />);
  });
  return { onPick, last: () => seen.sdk.at(-1)! };
}

describe('the app composer suggestions', () => {
  it('gives the SDK the API welcome list and matches, each row keyed by its suggestion id', () => {
    seen.welcome = [suggestion('w1', 'Plan a trip')];
    seen.matches = [suggestion('m1', 'Trip to Lisbon')];
    const { last } = mount('lis');
    expect(last().welcome).toEqual([{ ...suggestion('w1', 'Plan a trip'), id: 'w1' }]);
    expect(last().matches).toEqual([{ ...suggestion('m1', 'Trip to Lisbon'), id: 'm1' }]);
  });

  it('searches with the settled draft the SDK reports', () => {
    mount('lis');
    expect(seen.searched.at(-1)).toBe('settled');
  });

  it('passes the draft, whether suggestions are on and the pick straight through', () => {
    const { last, onPick } = mount('abc', vi.fn(), false);
    expect(last()).toMatchObject({ draft: 'abc', enabled: false, onPick });
  });

  it('keeps the list steady between renders when the API data has not changed', () => {
    seen.welcome = [suggestion('w1', 'Plan a trip')];
    const { last } = mount('');
    const first = last().welcome;
    act(() => {
      renderer?.update(<></>);
    });
    expect(first).toBe(seen.sdk[0]!.welcome);
  });
});
