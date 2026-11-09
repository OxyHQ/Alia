import type React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * One agent in the catalogue is a row: mark, name with "by author", tagline, and Chat. The row
 * opens the agent's page; Chat opens its thread and must not also open the page.
 */

const { slotted, hosts } = vi.hoisted(() => ({
  slotted: async (name: string, slots: string[]) => {
    const ReactModule = await import('react');
    return ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(
        name,
        props,
        ...slots.map((slot) => (props[slot] ?? null) as React.ReactNode),
        children as React.ReactNode,
      );
  },
  hosts: async (...names: string[]) => {
    const ReactModule = await import('react');
    return Object.fromEntries(
      names.map((name) => [
        name,
        ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
          ReactModule.createElement(name, props, children as React.ReactNode),
      ]),
    );
  },
}));

vi.mock('@oxy.so/bloom/item', async () => ({
  Item: await slotted('Item', ['leading', 'title', 'subtitle', 'trailing']),
}));
vi.mock('@oxy.so/bloom/button', async () => hosts('Button'));
vi.mock('@oxy.so/bloom/agent-avatar', async () => hosts('AgentAvatar'));
vi.mock('@oxy.so/bloom/typography', async () => hosts('Text'));
vi.mock('@alia.onl/sdk', () => ({ readAgentCharacter: (value: unknown) => value }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

import { AgentListingRow } from '../agent-listing-row';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const agent = {
  _id: 'a1',
  name: 'Haggle Bot',
  handle: 'haggle',
  authorName: 'Daniel Gartshein',
  tagline: 'Finds savings in your SaaS spend.',
  character: null,
} as never;

function mount(overrides: Record<string, unknown> = {}) {
  const onPress = vi.fn();
  const onChat = vi.fn();
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AgentListingRow
        agent={{ ...(agent as object), ...overrides } as never}
        onPress={onPress}
        onChat={onChat}
      />,
    );
  });
  return { root: renderer.root, onPress, onChat };
}

describe('AgentListingRow', () => {
  it('shows the name, "by author", and the tagline under it', () => {
    const { root } = mount();
    const item = root.findByType('Item' as never);
    expect(item.props.subtitle).toBe('Finds savings in your SaaS spend.');
    expect(item.props.subtitleNumberOfLines).toBe(1);
    const labels = root
      .findAll((n) => (n.type as unknown) === 'Text')
      .map((n) => n.children.join(''));
    expect(labels.some((l) => l.includes('Haggle Bot'))).toBe(true);
    expect(labels.some((l) => l.includes('agents.byAuthor:Daniel Gartshein'))).toBe(true);
  });

  it('leaves out "by author" when Oxy resolved no author', () => {
    const { root } = mount({ authorName: null });
    const labels = root
      .findAll((n) => (n.type as unknown) === 'Text')
      .map((n) => n.children.join(''));
    expect(labels.some((l) => l.includes('agents.byAuthor'))).toBe(false);
  });

  it('opens the agent from the row, and its thread from Chat without opening the page', () => {
    const { root, onPress, onChat } = mount();
    act(() => root.findByType('Item' as never).props.onPress());
    expect(onPress).toHaveBeenCalledWith('a1');
    const chat = root.findByType('Button' as never);
    expect(chat.props.stopPropagation).toBe(true);
    act(() => chat.props.onPress());
    expect(onChat).toHaveBeenCalledWith('a1');
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
