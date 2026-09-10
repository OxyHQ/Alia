import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where focus goes when the execution panel closes (#544).
 *
 * On the web the desktop rail is not a dialog, so nothing moves focus into it
 * and nothing moves it back; the row that opened it is remembered at open
 * time and focused again at close — from the panel's own close control here,
 * and from the surface's Escape / backdrop through the same helper.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
  };
});

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const Animated = {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('AnimatedView', props, children),
  };
  return {
    default: Animated,
    useAnimatedStyle: (factory: () => Record<string, unknown>) => factory(),
    useSharedValue: <T,>(initial: T) => ReactModule.useRef({ value: initial }).current,
    withTiming: <T,>(value: T) => value,
    withRepeat: <T,>(value: T) => value,
    withSequence: <T,>(value: T) => value,
  };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) => ReactModule.createElement(name, props);
  return {
    Brain: icon('Brain'), CheckCircle2: icon('CheckCircle2'), X: icon('X'), Globe: icon('Globe'),
    ChevronRight: icon('ChevronRight'), XCircle: icon('XCircle'), Ban: icon('Ban'), Clock: icon('Clock'),
    FileText: icon('FileText'),
  };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@/components/lottie-loader', async () => {
  const ReactModule = await import('react');
  return { LottieLoader: (props: Record<string, unknown>) => ReactModule.createElement('LottieLoader', props) };
});
vi.mock('expo-web-browser', () => ({ openBrowserAsync: async () => {} }));
vi.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { success: 'green', warning: 'orange', info: 'blue', error: 'red', primary: 'black' } }),
}));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/tool-registry', async () => {
  const ReactModule = await import('react');
  return { getToolIcon: () => (props: Record<string, unknown>) => ReactModule.createElement('ToolIcon', props) };
});
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (n: string) => n }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

import { ThoughtPanel } from '@/components/thought-panel';
import { rememberOpener, restoreOpenerFocus } from '@/components/execution/focus-return';
import { useUIStore, type ThoughtScope } from '@/lib/stores/ui-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Host names as `string`, the way the other suites spell them: a literal would not compare against `ElementType`. */
const HOST_PRESSABLE: string = 'Pressable';

const scope: ThoughtScope = {
  conversationId: 'c1',
  messages: [
    { id: 'u1', role: 'user', content: 'q' },
    { id: 'a1', role: 'assistant', content: 'answer', turnOutcome: 'completed', toolInvocations: [
      { toolCallId: 't1', toolName: 'webSearch', state: 'result', args: { query: 'q' }, result: { results: [] } },
    ] },
  ],
  status: 'ready',
  isLoading: false,
  failedTurn: null,
};

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  useUIStore.setState({ rightPanel: null, thoughtMessageId: null, thoughtScope: null, thoughtTab: 'steps' });
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  restoreOpenerFocus();
});

describe('closing the panel', () => {
  it('focuses the control that opened it, once', () => {
    const opener = { focus: vi.fn() };
    rememberOpener(opener);
    act(() => { useUIStore.getState().openThoughtPanel('a1', scope); });
    act(() => { renderer = create(<ThoughtPanel />); });

    const close = renderer!.root.findAll((node) => node.type === HOST_PRESSABLE && node.props.accessibilityLabel === 'common.close');
    expect(close).toHaveLength(1);
    act(() => { close[0].props.onPress(); });

    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(opener.focus).toHaveBeenCalledTimes(1);

    // A second close — the surface's own dismissal after the panel's — has nothing left to focus.
    restoreOpenerFocus();
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });

  it('remembers the newest opener, and nothing when there is no focusable one', () => {
    const first = { focus: vi.fn() };
    const second = { focus: vi.fn() };
    rememberOpener(first);
    rememberOpener(second);
    restoreOpenerFocus();
    expect(first.focus).not.toHaveBeenCalled();
    expect(second.focus).toHaveBeenCalledTimes(1);

    // No candidate and no `document` in this environment: nothing to return to, and no throw.
    rememberOpener(undefined);
    expect(() => restoreOpenerFocus()).not.toThrow();
    rememberOpener({ focus: () => { throw new Error('detached'); } });
    expect(() => restoreOpenerFocus()).not.toThrow();
  });
});

describe('the panel is navigable by keyboard', () => {
  it('names every control and marks the open tab', () => {
    act(() => { useUIStore.getState().openThoughtPanel('a1', scope); });
    act(() => { renderer = create(<ThoughtPanel />); });
    const tabs = renderer!.root.findAll((node) => node.type === HOST_PRESSABLE && node.props.accessibilityRole === 'tab');
    expect(tabs.map((tab) => tab.props.accessibilityState.selected)).toEqual([true, false, false]);
    const controls = renderer!.root.findAll((node) => node.type === HOST_PRESSABLE);
    expect(controls.every((node) => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.length > 0)).toBe(true);
    // The tool row is expandable and says so.
    const row = controls.find((node) => node.props.accessibilityLabel === 'webSearch');
    expect(row?.props.accessibilityState).toMatchObject({ expanded: false });
  });
});
