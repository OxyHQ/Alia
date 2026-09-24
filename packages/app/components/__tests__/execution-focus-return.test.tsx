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
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Platform: {
      OS: 'web',
      select: (o: Record<string, unknown>) => o.web ?? o.default,
    },
  };
});



vi.mock('@oxy.so/bloom/loading', async () => {
  const ReactModule = await import('react');
  return {
    Loading: (props: Record<string, unknown>) =>
      ReactModule.createElement('Loading', props),
  };
});
vi.mock('@oxy.so/bloom/agent-log', async () => (await import('./panel-bloom-stubs')).agentLogModule());
vi.mock('@oxy.so/bloom/accordion', async () => (await import('./panel-bloom-stubs')).accordionModule());
vi.mock('@oxy.so/bloom/item', async () => (await import('./panel-bloom-stubs')).itemModule());
vi.mock('@oxy.so/bloom/empty-state', async () => (await import('./panel-bloom-stubs')).emptyStateModule());
vi.mock('@oxy.so/bloom/typography', async () => (await import('./panel-bloom-stubs')).typographyModule());
vi.mock('@oxy.so/bloom/theme', async () => (await import('./panel-bloom-stubs')).themeModule());
vi.mock('@oxy.so/bloom/chip', async () => ({ Chip: (await import('./panel-bloom-stubs')).host('Chip') }));
vi.mock('@oxy.so/bloom/code', async () => ({ CodeBlock: (await import('./panel-bloom-stubs')).host('CodeBlock') }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('@oxy.so/bloom/icons/RiArrowDownSLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiArrowDownSLine'));
vi.mock('@oxy.so/bloom/icons/RiArrowRightSLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiArrowRightSLine'));
vi.mock('@oxy.so/bloom/icons/RiCheckboxCircleLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiCheckboxCircleLine'));
vi.mock('@oxy.so/bloom/icons/RiCloseCircleLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiCloseCircleLine'));
vi.mock('@oxy.so/bloom/icons/RiCloseLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiCloseLine'));
vi.mock('@oxy.so/bloom/icons/RiFileTextLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiFileTextLine'));
vi.mock('@oxy.so/bloom/icons/RiForbidLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiForbidLine'));
vi.mock('@oxy.so/bloom/icons/RiGlobalLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiGlobalLine'));
vi.mock('@oxy.so/bloom/icons/RiTimeLine', async () => (await import('./panel-bloom-stubs')).iconModule('RiTimeLine'));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: async () => {} }));
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/tool-registry', async () => {
  const ReactModule = await import('react');
  return {
    getToolIcon: () => (props: Record<string, unknown>) =>
      ReactModule.createElement('ToolIcon', props),
  };
});
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (n: string) => n }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

import {
  rememberOpener,
  restoreOpenerFocus,
} from '@/components/execution/focus-return';
import { ThoughtPanel } from '@/components/thought-panel';
import { useUIStore, type ThoughtScope } from '@/lib/stores/ui-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Host names as `string`, the way the other suites spell them: a literal would not compare against `ElementType`. */
const HOST_PRESSABLE: string = 'Pressable';

const scope: ThoughtScope = {
  conversationId: 'c1',
  messages: [
    { id: 'u1', role: 'user', content: 'q' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'answer',
      turnOutcome: 'completed',
      toolInvocations: [
        {
          toolCallId: 't1',
          toolName: 'webSearch',
          state: 'result',
          args: { query: 'q' },
          result: { results: [] },
        },
      ],
    },
  ],
  status: 'ready',
  isLoading: false,
  failedTurn: null,
};

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  useUIStore.setState({
    rightPanel: null,
    thoughtMessageId: null,
    thoughtScope: null,
    thoughtTab: 'steps',
  });
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
    act(() => {
      useUIStore.getState().openThoughtPanel('a1', scope);
    });
    act(() => {
      renderer = create(<ThoughtPanel />);
    });

    const close = renderer!.root.findAll(
      (node) =>
        node.type === HOST_PRESSABLE &&
        node.props.accessibilityLabel === 'common.close',
    );
    expect(close).toHaveLength(1);
    act(() => {
      close[0].props.onPress();
    });

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
    rememberOpener({
      focus: () => {
        throw new Error('detached');
      },
    });
    expect(() => restoreOpenerFocus()).not.toThrow();
  });
});

describe('the panel is navigable by keyboard', () => {
  it('names controls and delegates tab selection to Bloom', () => {
    act(() => {
      useUIStore.getState().openThoughtPanel('a1', scope);
    });
    act(() => {
      renderer = create(<ThoughtPanel />);
    });
    const tabs = renderer!.root.find((node) => String(node.type) === 'Tabs');
    expect(tabs.props.value).toBe('steps');
    expect(tabs.props.variant).toBe('pill');
    const triggers = renderer!.root.findAll(
      (node) => String(node.type) === 'TabsTrigger',
    );
    expect(triggers.map((tab) => tab.props.value)).toEqual([
      'steps',
      'sources',
      'activity',
    ]);
    expect(triggers.map((tab) => tab.props.children)).toEqual([
      'thought.steps',
      'thought.sources',
      'thought.activity',
    ]);
    const controls = renderer!.root.findAll(
      (node) => node.type === HOST_PRESSABLE,
    );
    expect(
      controls.every(
        (node) =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.length > 0,
      ),
    ).toBe(true);
    // The tool row is expandable and says so.
    const row = controls.find(
      (node) => node.props.accessibilityLabel === 'webSearch',
    );
    expect(row?.props.accessibilityState).toMatchObject({ expanded: false });
  });
});

vi.mock('@oxy.so/bloom/ai-chat', () => ({
  useAiChatShell: () => ({ compact: false }),
}));
vi.mock('@oxy.so/bloom/button', async () => {
  const R = await import('react');
  return {
    Button: ({ children, icon, ...props }: any) =>
      R.createElement('Pressable', props, icon, children),
  };
});
vi.mock('@oxy.so/bloom/tabs', async () => {
  const R = await import('react');
  return {
    Tabs: ({ children, ...props }: any) =>
      R.createElement('Tabs', props, children),
    TabsTrigger: ({ label, ...props }: any) =>
      R.createElement('TabsTrigger', props, label),
  };
});
