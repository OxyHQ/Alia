import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The plan an agent shows (`alia.plan_preview`) is shown, never asked about: no agent waits for the
 * person's approval (ADR 0020), so the card lists the steps and offers nothing to press.
 */

const { hosts } = vi.hoisted(() => ({
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
vi.mock('react-native-reanimated', async () => ({ default: await hosts('View') }));
vi.mock('../../src/animations', () => ({ planPreviewEnter: undefined }));
vi.mock('../../src/lib/labels', () => ({ useLabels: () => ({ planTitle: "Here's my plan" }) }));
vi.mock('@oxy.so/bloom/card', async () => hosts('Card', 'CardBody', 'CardHeader', 'CardTitle'));
vi.mock('@oxy.so/bloom/item', async () => hosts('Item'));
vi.mock('@oxy.so/bloom/typography', async () => hosts('Text'));
vi.mock('@oxy.so/bloom/icons/RiListCheck3', () => ({ RiListCheck3: () => null }));
vi.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { icon: '#000' } }) }));
vi.mock('@oxy.so/bloom/button', () => ({
  Button: () => {
    throw new Error('the plan card has nothing to press');
  },
}));

import { PlanPreviewCard } from '../../src/components/PlanPreviewCard';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('PlanPreviewCard', () => {
  it('lists the steps and offers no approve or cancel', () => {
    act(() => {
      renderer = create(
        <PlanPreviewCard
          steps={[
            { action: 'Search listings', description: 'In Gràcia' },
            { action: 'Compare prices', description: '' },
          ]}
        />,
      );
    });
    if (renderer === undefined) throw new Error('not rendered');
    const { root } = renderer;
    const items = root.findAll((node) => (node.type as unknown) === 'Item');
    expect(items.map((item) => item.props.title)).toEqual(['Search listings', 'Compare prices']);
    expect(root.findAll((node) => typeof node.props.onPress === 'function')).toEqual([]);
    const words = root
      .findAll(
        (node) => (node.type as unknown) === 'Text' || (node.type as unknown) === 'CardTitle',
      )
      .flatMap((node) => node.props.children as unknown[]);
    expect(words.join(' ')).not.toMatch(/Approve|Cancel/);
  });
});
