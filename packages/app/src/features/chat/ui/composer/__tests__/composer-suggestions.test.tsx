import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The suggestions over the composer: which rows a draft gets, how the
 * keyboard moves through them through the composer's `onKeyPress`, and the
 * typed part drawn highlighted inside each match.
 */

const data = vi.hoisted(() => ({
  welcome: [] as unknown[],
  matches: [] as unknown[],
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View') };
});
vi.mock('@/features/chat/runtime/use-suggestions', () => ({
  useWelcomeSuggestions: () => ({ data: data.welcome }),
  useSearchSuggestions: () => ({ data: data.matches }),
}));
vi.mock('@oxy.so/bloom/item', async () => {
  const ReactModule = await import('react');
  return {
    Item: ({ title, ...props }: Record<string, React.ReactNode>) =>
      ReactModule.createElement('Item', props, title),
  };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

const { composerCompletions, useComposerSuggestions, ComposerSuggestions } = await import(
  '@/features/chat/ui/composer/composer-suggestions'
);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const suggestion = (id: string, text: string) =>
  ({ suggestionId: id, title: text, text, isTemplate: false }) as never;

const WELCOME = [suggestion('w1', 'Plan a trip'), suggestion('w2', 'Write a poem')];

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  data.welcome = [];
  data.matches = [];
});

/** A key event shaped the way react-native-web forwards one. */
function key(name: string) {
  const event = {
    nativeEvent: { key: name },
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event as typeof event & Parameters<ReturnType<typeof useComposerSuggestions>['onKeyPress']>[0];
}

describe('composerCompletions', () => {
  it('offers the welcome suggestions while the draft is short', () => {
    expect(composerCompletions(' a ', WELCOME, []).map((row) => row.suggestion)).toEqual(WELCOME);
  });

  it('switches to the matches from two characters, with the typed range', () => {
    const rows = composerCompletions('lis', WELCOME, [suggestion('m1', 'Trip to Lisbon')]);
    expect(rows).toEqual([{ suggestion: suggestion('m1', 'Trip to Lisbon'), matchStart: 8, matchEnd: 11 }]);
  });

  it('drops repeated texts and stops at six rows', () => {
    const matches = [
      suggestion('a', 'Same'),
      suggestion('b', 'same'),
      ...Array.from({ length: 8 }, (_, i) => suggestion(`m${i}`, `Match ${i}`)),
    ];
    const rows = composerCompletions('ma', [], matches);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.suggestion.text.toLowerCase() === 'same')).toHaveLength(1);
  });

  it('keeps a match whose text does not contain the draft, unhighlighted', () => {
    const [row] = composerCompletions('xyz', [], [suggestion('m', 'Other')]);
    expect([row.matchStart, row.matchEnd]).toEqual([0, 0]);
  });
});

describe('useComposerSuggestions', () => {
  function mount(draft: string, onPick = vi.fn(), enabled = true) {
    let result!: ReturnType<typeof useComposerSuggestions>;
    function Probe() {
      result = useComposerSuggestions({ draft, enabled, onPick });
      return null;
    }
    act(() => {
      renderer = create(<Probe />);
    });
    return { current: () => result, onPick };
  }

  it('offers nothing where suggestions are not wanted', () => {
    data.welcome = WELCOME;
    expect(mount('', vi.fn(), false).current().completions).toEqual([]);
  });

  it('moves with the arrows, wraps around, and picks on Enter', () => {
    data.welcome = WELCOME;
    const { current, onPick } = mount('');
    const down = key('ArrowDown');
    act(() => current().onKeyPress(down));
    expect(down.defaultPrevented).toBe(true);
    expect(current().selected).toBe(0);
    act(() => current().onKeyPress(key('ArrowUp')));
    expect(current().selected).toBe(1);

    const enter = key('Enter');
    act(() => current().onKeyPress(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(onPick).toHaveBeenCalledWith(WELCOME[1]);
  });

  it('leaves Enter to the composer while no row is selected', () => {
    data.welcome = WELCOME;
    const { current, onPick } = mount('');
    const enter = key('Enter');
    act(() => current().onKeyPress(enter));
    expect(enter.defaultPrevented).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    data.welcome = WELCOME;
    const { current } = mount('');
    act(() => current().onKeyPress(key('Escape')));
    expect(current().completions).toEqual([]);
  });
});

describe('ComposerSuggestions', () => {
  const all = (r: ReactTestRenderer, name: string): ReactTestInstance[] =>
    r.root.findAll((node) => node.type === name);

  it('draws one row per completion, the typed part highlighted, the keyboard row highlighted', () => {
    const onPick = vi.fn();
    const rows = composerCompletions('lis', [], [suggestion('m1', 'Trip to Lisbon')]);
    act(() => {
      renderer = create(<ComposerSuggestions completions={rows} selected={0} onPick={onPick} />);
    });
    const r = renderer as ReactTestRenderer;
    const [item] = all(r, 'Item');
    expect(item.props.highlighted).toBe(true);
    const highlight = all(r, 'Text').find((node) => node.props.className === 'font-medium text-primary');
    expect(highlight?.props.children).toBe('Lis');
    act(() => item.props.onPress());
    expect(onPick).toHaveBeenCalledWith(rows[0].suggestion);
  });

  it('draws nothing without completions', () => {
    act(() => {
      renderer = create(<ComposerSuggestions completions={[]} selected={-1} onPick={vi.fn()} />);
    });
    expect((renderer as ReactTestRenderer).toJSON()).toBeNull();
  });
});
