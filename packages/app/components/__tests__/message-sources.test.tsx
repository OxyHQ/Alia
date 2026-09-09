import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * Whether an answer that used the web says so, and whether it still says so
 * after the thread is reopened.
 *
 * The second half is the one worth writing down. Nothing about these sources is
 * stored separately — they are read back out of `toolInvocations`, the same
 * jsonb column the message itself is saved with. So the fixtures here are not
 * "what the stream emitted"; they are what a row in `messages` holds a month
 * later, which is exactly what a reader reopening the thread gets.
 *
 * A row that rendered from live stream state instead would look identical in a
 * screenshot and be empty on reload, so the assertion is on a PERSISTED shape.
 */

// Each factory builds its own host helper: `vi.mock` is hoisted above every
// top-level binding, so a shared one is not initialised yet when it runs.
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: h('View'),
    Pressable: h('Pressable'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web },
  };
});

/**
 * `expo-image` reaches `expo-modules-core`, which needs the Expo runtime only a
 * device build has. The favicon itself is the subject of
 * `message-sources-favicon.test.tsx`; here the host element only has to exist,
 * so that the marks these tests count are counted with it present.
 */
vi.mock('expo-image', async () => {
  const ReactModule = await import('react');
  return { Image: (props: Record<string, unknown>) => ReactModule.createElement('Image', props) };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return { Globe: h('Globe') };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  const h = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return { Text: h('Text') };
});

// `thought-utils` reaches the SDK barrel for `getToolLabel`, which drags the
// whole React Native component library in. `extractSources` — the part under
// test — never touches it.
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (n: string) => n }));

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MessageSources } from '@/components/message-sources';

/** A finished `webSearch` exactly as `messages.tool_invocations` stores one. */
const persistedSearch = (urls: string[]) => [
  {
    toolCallId: 'call_1',
    toolName: 'webSearch',
    state: 'result' as const,
    args: { query: 'anything' },
    result: {
      results: urls.map((url, i) => ({ title: `Result ${i}`, url, snippet: 's' })),
      count: urls.length,
    },
  },
];

function render(node: React.ReactElement) {
  let tree: ReactTestRenderer;
  act(() => { tree = create(node); });
  return tree!;
}

/** Every string rendered in the tree, which is what a reader actually sees. */
function labels(tree: ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out;
}

describe('MessageSources', () => {
  it('says nothing when the answer used no tools at all', () => {
    const tree = render(<MessageSources onPress={vi.fn()} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('says nothing when a tool ran but produced no sources', () => {
    const tree = render(
      <MessageSources
        onPress={vi.fn()}
        toolInvocations={[
          { toolCallId: 'c', toolName: 'getCurrentDate', state: 'result', args: {}, result: { date: 'today' } },
        ]}
      />,
    );
    expect(tree.toJSON()).toBeNull();
  });

  it('shows the row for a message reloaded out of the database', () => {
    const tree = render(
      <MessageSources onPress={vi.fn()} toolInvocations={persistedSearch(['https://a.test/x'])} />,
    );
    expect(tree.toJSON()).not.toBeNull();
    expect(labels(tree)).toContain('chat.sources');
  });

  it('opens the panel when pressed', () => {
    const onPress = vi.fn();
    const tree = render(
      <MessageSources onPress={onPress} toolInvocations={persistedSearch(['https://a.test/x'])} />,
    );
    act(() => { tree.root.findByProps({ accessibilityRole: 'button' }).props.onPress(); });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('caps the stack of marks but counts every source', () => {
    const five = ['https://a.test/1', 'https://b.test/2', 'https://c.test/3', 'https://d.test/4', 'https://e.test/5'];
    const tree = render(<MessageSources onPress={vi.fn()} toolInvocations={persistedSearch(five)} />);

    const button = tree.root.findByProps({ accessibilityRole: 'button' });
    // Five sources, three marks: the stack is a hint, the label carries the count.
    // Host elements only — `findAll` also returns the component that rendered
    // each one, which would double every count.
    const marks = button.findAll(
      (n) => typeof n.type === 'string' && typeof n.props.className === 'string' && n.props.className.includes('-ms-1.5'),
    );
    expect(marks).toHaveLength(3);
    expect(button.props.accessibilityLabel).toBe('chat.sourcesCount');
  });
});
