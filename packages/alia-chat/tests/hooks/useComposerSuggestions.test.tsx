import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useComposerSuggestions, useSuggestionQuery } from '../../src/hooks/useComposerSuggestions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const suggestion = (id: string, text: string) => ({ id, text });
const WELCOME = [suggestion('w1', 'Plan a trip'), suggestion('w2', 'Write a poem')];

let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
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
  return event as typeof event &
    Parameters<ReturnType<typeof useComposerSuggestions>['onKeyPress']>[0];
}

describe('useComposerSuggestions', () => {
  function mount(draft: string, onPick = vi.fn(), enabled = true) {
    let result!: ReturnType<typeof useComposerSuggestions<(typeof WELCOME)[number]>>;
    function Probe() {
      result = useComposerSuggestions({ draft, enabled, welcome: WELCOME, matches: [], onPick });
      return null;
    }
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    return { current: () => result, onPick };
  }

  it('offers nothing where suggestions are not wanted', () => {
    expect(mount('', vi.fn(), false).current().completions).toEqual([]);
  });

  it('moves with the arrows, wraps around, and picks on Enter', () => {
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
    const { current, onPick } = mount('');
    const enter = key('Enter');
    act(() => current().onKeyPress(enter));
    expect(enter.defaultPrevented).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { current } = mount('');
    act(() => current().onKeyPress(key('Escape')));
    expect(current().completions).toEqual([]);
  });
});

describe('useSuggestionQuery', () => {
  function mount(draft: string, enabled = true) {
    let result = '';
    function Probe({ value }: { value: string }) {
      result = useSuggestionQuery(value, enabled);
      return null;
    }
    act(() => {
      renderer = TestRenderer.create(<Probe value={draft} />);
    });
    return {
      query: () => result,
      type: (value: string) =>
        act(() => {
          renderer?.update(<Probe value={value} />);
        }),
    };
  }

  it('is the draft once typing has settled, and empty while it is too short', () => {
    vi.useFakeTimers();
    const probe = mount('');
    probe.type('l');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(probe.query()).toBe('');
    probe.type('lis');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(probe.query()).toBe('');
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(probe.query()).toBe('lis');
    probe.type('l');
    expect(probe.query()).toBe('');
  });

  it('stays empty where suggestions are off', () => {
    vi.useFakeTimers();
    const probe = mount('lisbon', false);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(probe.query()).toBe('');
  });
});
