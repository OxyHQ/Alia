import type React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  asked: [] as unknown[],
  conversations: [] as Array<{ id: string; title: string; updatedAt: Date }>,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View') };
});
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
vi.mock('../../src/runtime/conversations', () => ({
  useConversations: (options: unknown) => {
    world.asked.push(options);
    return { data: { pages: [{ conversations: world.conversations }] } };
  },
}));

import { AliaRecentConversations } from '../../src/components/AliaRecentConversations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  world.asked = [];
  world.conversations = [];
});
const items = (r: TestRenderer.ReactTestRenderer): ReactTestInstance[] =>
  r.root.findAll((node) => (node.type as unknown) === 'Item');

const at = (day: number) => new Date(Date.UTC(2026, 9, day));

describe('AliaRecentConversations', () => {
  it("offers the lead's three latest conversations, and opens the one picked", () => {
    world.conversations = [
      { id: 'c1', title: 'Pisos en Gràcia', updatedAt: at(17) },
      { id: 'c2', title: '', updatedAt: at(16) },
      { id: 'c3', title: 'Mi contrato', updatedAt: at(15) },
      { id: 'c4', title: 'Older', updatedAt: at(14) },
    ];
    const onOpen = vi.fn();
    act(() => {
      renderer = TestRenderer.create(<AliaRecentConversations agentId="sindi" onOpen={onOpen} />);
    });
    const r = renderer as TestRenderer.ReactTestRenderer;

    expect(world.asked.at(-1)).toEqual({ agentId: 'sindi' });
    expect(items(r).map((item) => item.props.accessibilityLabel)).toEqual([
      'Pisos en Gràcia',
      'New chat',
      'Mi contrato',
    ]);
    act(() => items(r)[2]!.props.onPress());
    expect(onOpen).toHaveBeenCalledWith('c3');
  });

  it("lists the person's latest conversations of any kind on Alia's own sheet", () => {
    act(() => {
      renderer = TestRenderer.create(<AliaRecentConversations onOpen={vi.fn()} />);
    });
    expect(world.asked.at(-1)).toEqual({});
  });

  it('draws nothing when there is nothing to pick up', () => {
    act(() => {
      renderer = TestRenderer.create(<AliaRecentConversations agentId="sindi" onOpen={vi.fn()} />);
    });
    expect(renderer?.toJSON()).toBeNull();
  });
});
