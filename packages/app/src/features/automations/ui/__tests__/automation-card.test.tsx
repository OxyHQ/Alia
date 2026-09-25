import React from 'react';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The automation card is headed by its objective: structured definitions have
 * no name column, and the legacy-trigger name the card once preferred (#534)
 * went with the `triggers` table. The objective reads once, as the heading, and
 * every control's accessibility label is named after it.
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
    Platform: {
      OS: 'web',
      select: (spec: Record<string, unknown>) => spec.web,
    },
    View: host('View'),
  };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
    Muted: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@oxy.so/bloom/switch', async () => {
  const ReactModule = await import('react');
  return {
    Switch: (props: Record<string, unknown>) =>
      ReactModule.createElement('Switch', props),
  };
});
/**
 * The Bloom parts the card is built from, as named hosts. Anything that draws
 * words renders a `Text` host, so the reading order below is the card's own.
 */
vi.mock('@oxy.so/bloom/card', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Card: host('Card'),
    CardFooter: host('CardFooter'),
    CardTitle: host('Text'),
    CardDescription: host('Text'),
  };
});
vi.mock('@oxy.so/bloom/item', async () => {
  const ReactModule = await import('react');
  return {
    Item: ({
      leading,
      title,
      subtitle,
      trailing,
      children,
    }: Record<string, React.ReactNode>) =>
      ReactModule.createElement(
        'Item',
        null,
        leading,
        children ?? title,
        subtitle,
        trailing,
      ),
  };
});
vi.mock('@oxy.so/bloom/badge', async () => {
  const ReactModule = await import('react');
  return {
    Badge: ({ content, ...props }: Record<string, unknown>) =>
      ReactModule.createElement('Text', props, content as React.ReactNode),
  };
});
vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      // Bloom's Button draws its label as text.
      ReactModule.createElement('Button', props, ReactModule.createElement('Text', null, children)),
  };
});
vi.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: 'grey' } }),
}));
vi.mock('@oxy.so/bloom/icons/RiPlayLine', () => ({ RiPlayLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiStopFill', () => ({ RiStopFill: () => null }));
vi.mock('@oxy.so/bloom/icons/RiTimeLine', () => ({ RiTimeLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiUserLine', () => ({ RiUserLine: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { AutomationCard } = await import('../automation-card');
type AutomationDefinition =
  import('@/shared/contracts/automations').AutomationDefinition;

const PROMPT = 'Review PR comments every hour and share next steps';

function automation(id: string, objective = PROMPT): AutomationDefinition {
  return {
    id,
    objective,
    trigger: { type: 'schedule', cron: '*/60 * * * *', timezone: 'UTC' },
    actorSelection: { mode: 'automatic', eligibleAgentIds: [] },
    executionMode: 'execute',
    actions: [],
    resources: [],
    dataFlow: { sources: [], destinations: [] },
    maximumAutonomy: 'autonomous',
    limits: [],
    enabled: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));

function mount(
  definition: AutomationDefinition,
  variant: 'full' | 'compact' = 'full',
): ReactTestInstance {
  act(() => {
    renderer = create(
      React.createElement(AutomationCard, {
        automation: definition,
        agentName: () => 'Writer',
        busy: false,
        controlsDisabled: false,
        onToggle: vi.fn(),
        onRun: vi.fn(),
        onStop: vi.fn(),
        onViewHistory: vi.fn(),
        variant,
      }),
    );
  });
  return renderer.root;
}

function texts(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => React.Children.toArray(node.props.children).join(''));
}

function labels(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string')
    .map((node) => node.props.accessibilityLabel as string);
}

describe('AutomationCard heading', () => {
  it('heads the card with the objective, once, and names every control after it', () => {
    const root = mount(automation('1'));
    const shown = texts(root);
    expect(shown[0]).toBe(PROMPT);
    expect(shown.filter((text) => text === PROMPT)).toHaveLength(1);
    expect(labels(root)).toEqual(expect.arrayContaining([
      `Automation ${PROMPT}`,
      `Pause ${PROMPT}`,
      `Run ${PROMPT}`,
      `Stop ${PROMPT}`,
      `View history for ${PROMPT}`,
    ]));
  });

  it('offers to stop and revoke, and shows no legacy pill', () => {
    const shown = texts(mount(automation('2')));
    expect(shown).toContain('Stop and revoke');
    expect(shown).not.toContain('Legacy transition');
  });

  it('reads the schedule as a sentence and the lifecycle as a pill, in both variants', () => {
    for (const variant of ['full', 'compact'] as const) {
      const shown = texts(mount(automation('4', 'Hourly'), variant));
      expect(shown).toContain('Every hour · UTC');
      expect(shown).toContain('Scheduled');
      act(() => renderer.unmount());
    }
  });
});
