import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent row, read as a chat: who it is on top, the last thing said beneath.
 *
 * The second line is the whole point of the row existing, so what is pinned is
 * that there ARE two lines and that the lower one survives every state the data
 * can be in — including the ordinary one where an agent has just been made and
 * nobody has said anything to it yet.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Pressable: host('Pressable') };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@alia.onl/sdk', async () => {
  const ReactModule = await import('react');
  return {
    IdentityMark: (props: Record<string, unknown>) =>
      ReactModule.createElement('IdentityMark', props),
  };
});

/**
 * The colour the mark is painted in is resolved by `lib/agents/agent-color.ts`
 * and asserted in its own test, against Bloom's real registry. Reaching it from
 * here would pull in Bloom's `theme` barrel — which has no Node build — for a
 * value this file makes no claim about.
 */
vi.mock('@/lib/agents/agent-color', () => ({ agentTint: (color: string | null) => color }));
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'rgb(113 113 122)' } }),
}));

import { AgentRow } from '../agent-row';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HOST_TEXT: string = 'Text';
const HOST_PRESSABLE: string = 'Pressable';

let renderer: ReactTestRenderer | null = null;

const EMPTY = 'No messages yet';

function render(over: Partial<React.ComponentProps<typeof AgentRow>> = {}) {
  const onPress = vi.fn();
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <AgentRow
        name="Pepe"
        handle="pepe"
        color="#7c3aed"
        lastMessage="the last thing said"
        lastMessageAt={new Date().toISOString()}
        emptyLabel={EMPTY}
        onPress={onPress}
        {...over}
      />,
    );
  });
  if (next === undefined) throw new Error('the agent row did not render');
  renderer = next;
  return { r: next, onPress };
}

function lines(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((node) => node.type === HOST_TEXT)
    .map((node) => String(node.props.children));
}

function truncating(r: ReactTestRenderer): ReactTestInstance[] {
  return r.root.findAll(
    (node) => node.type === HOST_TEXT && node.props.numberOfLines === 1,
  );
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('an agent row', () => {
  it('says who it is, and what was last said', () => {
    const { r } = render();

    expect(lines(r)).toContain('Pepe');
    expect(lines(r)).toContain('the last thing said');
  });

  it('keeps its second line when nobody has spoken yet', () => {
    // The ordinary case one second after you make an agent. A blank here
    // collapses the row to one line and makes a new agent look broken beside
    // its neighbours.
    const { r } = render({ lastMessage: null, lastMessageAt: null });

    expect(lines(r)).toContain('Pepe');
    expect(lines(r)).toContain(EMPTY);
  });

  it('says nothing about when, when there is no when', () => {
    const { r } = render({ lastMessage: null, lastMessageAt: null });

    // No "just now" on a thread that has never happened.
    expect(lines(r).some((line) => line.includes('ago') || line === 'just now')).toBe(false);
  });

  it('truncates both lines rather than widening the sidebar', () => {
    const { r } = render({
      name: 'An agent with a preposterously long name that will not fit',
      lastMessage: 'and a last message very much longer than the sidebar is wide',
    });

    // Both lines, not just the message: a long NAME pushes exactly as hard.
    expect(truncating(r)).toHaveLength(2);
  });

  it('opens the thread when pressed', () => {
    const { r, onPress } = render();
    const pressable = r.root.findAll((node) => node.type === HOST_PRESSABLE)[0];

    act(() => pressable.props.onPress());

    expect(onPress).toHaveBeenCalledOnce();
  });

  it('is addressed by handle, so two agents sharing a name are still distinct', () => {
    const { r } = render();
    const pressable = r.root.findAll((node) => node.type === HOST_PRESSABLE)[0];

    expect(pressable.props.accessibilityLabel).toBe('@pepe');
  });
});
