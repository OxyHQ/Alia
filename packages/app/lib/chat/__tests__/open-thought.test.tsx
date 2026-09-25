import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The thought panel for a PAST turn, not only the one in flight.
 *
 * After the template adoption the panel opened only by itself, on the turn
 * that was working. A finished turn's "Worked for …" line, or its reasoning,
 * is the way back into it now — and the selection names the conversation the
 * turn belongs to (#608 §5), which for a thread's history is an earlier
 * stretch, not the one being streamed into.
 */

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { Text: host('RNText'), Platform: { OS: 'ios' } };
});
vi.mock('@oxy.so/bloom/ai-chat', async () => {
  const ReactModule = await import('react');
  return {
    AiChatMessageLine: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Line', props, children),
  };
});

import { TurnStatusLine } from '@/components/chat/turn-status-line';
import { thoughtScopeFor, useOpenThought } from '@/lib/chat/use-open-thought';
import { useUIStore, type ThoughtScope } from '@/lib/stores/ui-store';
import type { ThreadMessage } from '@/lib/thread-history';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A host element by name (the stubs render named host elements). */
const is = (name: string) => (node: ReactTestInstance) => node.type === name;

const live: ThoughtScope = {
  conversationId: 'c-live',
  messages: [
    { id: 'm1', role: 'user', content: 'hi' },
    { id: 'm2', role: 'assistant', content: 'hello' },
  ] as ThoughtScope['messages'],
  status: 'ready',
  isLoading: true,
  failedTurn: null,
};
const history = [
  { id: 'h1', role: 'user', content: 'old', conversationId: 'c-old', cursor: '1' },
  { id: 'h2', role: 'assistant', content: 'answer', thinking: 'why', conversationId: 'c-old', cursor: '2' },
  { id: 'h3', role: 'assistant', content: 'older', conversationId: 'c-older', cursor: '0' },
] as unknown as ThreadMessage[];

describe('thoughtScopeFor', () => {
  it('scopes a live turn to the conversation on screen', () => {
    expect(thoughtScopeFor('m2', live, history)).toBe(live);
  });

  it('scopes a past turn to ITS stretch, complete and not streaming', () => {
    const scope = thoughtScopeFor('h2', live, history);
    expect(scope).toMatchObject({ conversationId: 'c-old', status: 'ready', isLoading: false, failedTurn: null });
    expect(scope.messages.map((m) => m.id)).toEqual(['h1', 'h2']);
  });
});

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});
beforeEach(() => {
  useUIStore.setState({ rightPanel: null, thoughtMessageId: null, thoughtScope: null, thoughtTab: 'steps' });
});

describe('opening a past turn', () => {
  it('opens the panel on that turn, keyed by its conversation, from its status line', async () => {
    function Row() {
      const open = useOpenThought(live, history);
      return <TurnStatusLine label="Worked for 3s" hint="thought.viewDetails" onPress={() => open('h2', 'steps')} />;
    }
    await act(async () => {
      renderer = create(<Row />);
    });
    const control = renderer!.root.find(is('RNText'));
    expect(control.props.accessibilityRole).toBe('button');
    await act(async () => control.props.onPress());

    const state = useUIStore.getState();
    expect(state.rightPanel).toBe('thought');
    expect(state.thoughtMessageId).toBe('h2');
    expect(state.thoughtScope?.conversationId).toBe('c-old');
  });

  it('is plain text where nothing can be opened', async () => {
    await act(async () => {
      renderer = create(<TurnStatusLine label="Worked" />);
    });
    expect(renderer!.root.findAll(is('RNText'))).toHaveLength(0);
    expect(renderer!.root.find(is('Line')).props.children).toBe('Worked');
  });
});
