import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The thought panel for a PAST turn, not only the one in flight.
 *
 * A finished turn's "Worked for …" line, or its reasoning, is the way into the panel; the
 * selection names the conversation the turn belongs to, which for a thread's history is an
 * earlier stretch, not the one being streamed into. And the host decides whether there is a panel
 * at all (`AliaRuntimeHost.showThought`): without one the line is plain text and nothing opens by
 * itself.
 */

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

import { thoughtScopeFor, useOpenThought } from '../../src/hooks/useOpenThought';
import { TurnStatusLine } from '../../src/components/thread/TurnStatusLine';
import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import { type ThoughtScope, useThoughtStore } from '../../src/runtime/thought-store';
import type { ThreadMessage } from '../../src/runtime/thread/thread-history';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A host element by name (the stubs render named host elements). */
const is = (name: string) => (node: ReactTestInstance) => node.type === name;

const live: ThoughtScope = {
  conversationId: 'c-live',
  messages: [
    { id: 'm1', role: 'user', content: 'hi' },
    { id: 'm2', role: 'assistant', content: 'hello' },
  ],
  status: 'ready',
  isLoading: true,
  failedTurn: null,
};
const history = [
  { id: 'h1', role: 'user', content: 'old', conversationId: 'c-old', cursor: '1' },
  {
    id: 'h2',
    role: 'assistant',
    content: 'answer',
    thinking: 'why',
    conversationId: 'c-old',
    cursor: '2',
  },
  { id: 'h3', role: 'assistant', content: 'older', conversationId: 'c-older', cursor: '0' },
] satisfies ThreadMessage[];

describe('thoughtScopeFor', () => {
  it('scopes a live turn to the conversation on screen', () => {
    expect(thoughtScopeFor('m2', live, history)).toBe(live);
  });

  it('scopes a past turn to ITS stretch, complete and not streaming', () => {
    const scope = thoughtScopeFor('h2', live, history);
    expect(scope).toMatchObject({
      conversationId: 'c-old',
      status: 'ready',
      isLoading: false,
      failedTurn: null,
    });
    expect(scope.messages.map((m) => m.id)).toEqual(['h1', 'h2']);
  });
});

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});
beforeEach(() => {
  useThoughtStore.setState({ selection: null });
});

function Row({ runningTurnId }: { runningTurnId: string | null }) {
  const open = useOpenThought(live, history, runningTurnId);
  return (
    <TurnStatusLine
      label="Worked for 3s"
      hint="View details"
      onPress={open && (() => open('h2', 'steps'))}
    />
  );
}

const tree = (host: AliaRuntimeHost, runningTurnId: string | null) => (
  <AliaRuntimeProvider host={host}>
    <Row runningTurnId={runningTurnId} />
  </AliaRuntimeProvider>
);

function mount(host: AliaRuntimeHost, runningTurnId: string | null = null) {
  return act(async () => {
    renderer = create(tree(host, runningTurnId));
  });
}

describe('opening a past turn', () => {
  it('selects that turn, keyed by its conversation, and tells the host to show the panel', async () => {
    const showThought = vi.fn(() => true);
    await mount({ showThought });
    const control = renderer!.root.find(is('RNText'));
    expect(control.props.accessibilityRole).toBe('button');
    await act(async () => control.props.onPress());

    expect(showThought).toHaveBeenCalledWith('pressed');
    const selection = useThoughtStore.getState().selection;
    expect(selection?.messageId).toBe('h2');
    expect(selection?.scope.conversationId).toBe('c-old');
  });

  it('is plain text where the host has no panel to show it in', async () => {
    await mount({});
    expect(renderer!.root.findAll(is('RNText'))).toHaveLength(0);
    expect(renderer!.root.find(is('Line')).props.children).toBe('Worked for 3s');
  });
});

describe('a turn that has begun using tools', () => {
  it('opens the panel on it by itself, once, when the host has room', async () => {
    const showThought = vi.fn(() => true);
    await mount({ showThought }, 'm2');
    expect(showThought).toHaveBeenCalledWith('automatic');
    expect(useThoughtStore.getState().selection?.messageId).toBe('m2');

    // The reader closes it: the same turn does not reopen it.
    act(() => useThoughtStore.getState().close());
    await act(async () => renderer?.update(tree({ showThought }, 'm2')));
    expect(useThoughtStore.getState().selection).toBeNull();
    expect(showThought).toHaveBeenCalledTimes(1);
  });

  it('leaves what the reader has open alone when the host declines', async () => {
    const showThought = vi.fn(() => false);
    await mount({ showThought }, 'm2');
    expect(showThought).toHaveBeenCalledWith('automatic');
    expect(useThoughtStore.getState().selection).toBeNull();
  });
});
