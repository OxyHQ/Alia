import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * Whether a RESEARCH answer says what it stands on — and still says so after
 * the thread is reopened.
 *
 * `message-sources.test.tsx` covers a search answer. A research answer was
 * the gap (#540): its sources arrived only on the final progress event, were
 * never persisted, and reached neither the Sources row nor the panel. The
 * handler now saves them as a finished `deepResearch` invocation, so the
 * first fixture here is that persisted row; the second is the LIVE turn,
 * before it exists, when the row must read the progress event instead.
 */

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

vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (n: string) => n }));

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MessageSources } from '@/components/message-sources';

/** A finished research turn exactly as `messages.tool_invocations` stores one. */
const persistedResearch = (sources: Array<{ id: number; url: string; title: string }>) => [
  {
    toolCallId: 'research-req-1',
    toolName: 'deepResearch',
    state: 'result' as const,
    args: { query: 'resume en dos frases qué es React con una fuente' },
    result: { status: 'complete', sources, subQuestions: ['qué es React'], totalSearches: 4 },
  },
];

function render(node: React.ReactElement) {
  let tree: ReactTestRenderer;
  act(() => { tree = create(node); });
  return tree!;
}

function marks(tree: ReactTestRenderer) {
  return tree.root
    .findByProps({ accessibilityRole: 'button' })
    .findAll((n) => typeof n.type === 'string' && typeof n.props.className === 'string' && n.props.className.includes('-ms-1.5'));
}

describe('MessageSources — research answers', () => {
  it('shows the row for a research answer reloaded out of the database', () => {
    const tree = render(
      <MessageSources
        onPress={vi.fn()}
        toolInvocations={persistedResearch([
          { id: 1, url: 'https://es.react.dev/', title: 'React' },
          { id: 2, url: 'https://en.wikipedia.org/wiki/React_(software)', title: 'React (software)' },
        ])}
      />,
    );
    expect(tree.toJSON()).not.toBeNull();
    expect(marks(tree)).toHaveLength(2);
    expect(tree.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel).toBe('chat.sourcesCount');
  });

  it('shows the row for the live turn, from the final progress event', () => {
    const tree = render(
      <MessageSources
        onPress={vi.fn()}
        researchSources={[{ id: 1, url: 'https://es.react.dev/', title: 'React' }]}
      />,
    );
    expect(tree.toJSON()).not.toBeNull();
    expect(marks(tree)).toHaveLength(1);
  });

  it('counts a source once when it is both persisted and live', () => {
    const tree = render(
      <MessageSources
        onPress={vi.fn()}
        toolInvocations={persistedResearch([{ id: 1, url: 'https://es.react.dev/', title: 'React' }])}
        researchSources={[{ id: 1, url: 'https://es.react.dev/', title: 'React' }]}
      />,
    );
    expect(marks(tree)).toHaveLength(1);
  });

  it('says nothing for a research record that saved no sources', () => {
    const tree = render(<MessageSources onPress={vi.fn()} toolInvocations={persistedResearch([])} />);
    expect(tree.toJSON()).toBeNull();
  });
});
