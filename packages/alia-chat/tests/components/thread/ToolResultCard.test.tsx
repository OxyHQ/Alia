import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The cards a tool result draws in the thread are the thread's, whoever mounts it: the weather,
 * a market quote and the FairCoin price come from tools Alia offers on every surface, and their
 * numbers are in the message itself. A scheduled task is the one that points somewhere — at a
 * screen of the host's — so it is a link only where the host says where it goes.
 */

const { hosts, slotted } = vi.hoisted(() => ({
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

vi.mock('react-native', async () => hosts('View'));
vi.mock('../../../src/lib/labels', () => ({
  useLabels: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@oxy.so/bloom/ai-chat', async () => hosts('AiChatMessageLine'));
vi.mock('@oxy.so/bloom/badge', async () => hosts('Badge'));
vi.mock('@oxy.so/bloom/card', async () => hosts('Card', 'CardBody', 'CardHeader'));
vi.mock('@oxy.so/bloom/chart-cards', async () => hosts('LineChartCard'));
vi.mock('@oxy.so/bloom/icon-circle', async () => hosts('IconCircle'));
vi.mock('@oxy.so/bloom/item', async () => ({ Item: await slotted('Item', ['title', 'trailing']) }));
vi.mock('@oxy.so/bloom/segmented-control', async () =>
  hosts('SegmentedControl', 'SegmentedControlItem', 'SegmentedControlItemText'),
);
vi.mock('@oxy.so/bloom/typography', async () => hosts('Text', 'Muted'));
vi.mock('@oxy.so/bloom/icons/RiArrowRightSLine', () => ({ RiArrowRightSLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiCalendarScheduleLine', () => ({
  RiCalendarScheduleLine: () => null,
}));
vi.mock('@oxy.so/bloom/icons/RiCloudLine', () => ({ RiCloudLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiDropLine', () => ({ RiDropLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSnowflakeLine', () => ({ RiSnowflakeLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSunFoggyLine', () => ({ RiSunFoggyLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSunLine', () => ({ RiSunLine: () => null }));

import { ToolResultCard } from '../../../src/components/thread/ToolResultCard';
import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../../src/runtime/config';
import type { ToolCard } from '../../../src/runtime/model';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(card: ToolCard, host: AliaRuntimeHost = {}): ReactTestInstance {
  act(() => {
    renderer = create(
      <AliaRuntimeProvider host={host}>
        <ToolResultCard card={card} />
      </AliaRuntimeProvider>,
    );
  });
  return (renderer as unknown as ReactTestRenderer).root;
}

const scheduled: ToolCard = {
  type: 'scheduled-task',
  data: {
    id: 'task-7',
    objective: 'Send the digest',
    trigger: { type: 'manual' },
    enabled: true,
  } as never,
};

describe('a scheduled task', () => {
  it('is not a link where the host has no screen for it', () => {
    const item = render(scheduled).findByType('Item' as never);
    expect(item.props.onPress).toBeUndefined();
    expect(item.props.accessibilityRole).toBeUndefined();
  });

  it('opens the task on the host’s screen where it has one, named by what it does', () => {
    const openAutomation = vi.fn();
    const item = render(scheduled, { openAutomation }).findByType('Item' as never);

    expect(item.props.accessibilityRole).toBe('link');
    expect(item.props.accessibilityLabel).toBe('chat.toolCard.openTask');
    act(() => item.props.onPress());
    expect(openAutomation).toHaveBeenCalledWith('task-7');
  });

  it('says whether it is scheduled or paused', () => {
    const paused: ToolCard = {
      ...scheduled,
      data: { ...(scheduled.data as object), enabled: false } as never,
    };
    expect(render(paused).findByType('Badge' as never).props.content).toBe('chat.toolCard.paused');
  });
});

describe('a quote that has no chart to draw', () => {
  it('still says its price, in words', () => {
    const root = render({
      type: 'market',
      data: { name: 'Acme', symbol: 'ACM', currency: 'USD', price: 12.5 } as never,
    });
    expect(root.findAllByType('LineChartCard' as never)).toHaveLength(0);
    const words = root
      .findAll((node) => (node.type as unknown) === 'Text')
      .map((node) => node.props.children);
    expect(words.join(' ')).toContain('12.50');
  });
});
