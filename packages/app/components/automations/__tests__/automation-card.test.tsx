import React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The automation card is headed by the NAME its owner gave it (#534).
 *
 * Two automations created from the same suggestion share a prompt; before
 * this the card, the history heading and every accessibility label used the
 * prompt, so they were one card twice. Now the name is the heading and the
 * label, the objective reads underneath, and the objective stands in only
 * when there is no name at all.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
    View: host('View'),
    Pressable: host('Pressable'),
    ActivityIndicator: host('ActivityIndicator'),
  };
});
vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});
vi.mock('@/components/ui/switch', async () => {
  const ReactModule = await import('react');
  return { Switch: (props: Record<string, unknown>) => ReactModule.createElement('Switch', props) };
});
vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const glyph = (props: Record<string, unknown>) => ReactModule.createElement('Glyph', props);
  return { Clock: glyph, Play: glyph, ShieldCheck: glyph, Square: glyph, Users: glyph };
});
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { mutedForeground: 'grey', primary: 'blue' } }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { AutomationCard } = await import('../automation-card');
type AutomationDefinition = import('@/lib/automations/types').AutomationDefinition;

const PROMPT = 'Review PR comments every hour and share next steps';

function automation(id: string, name: string | null): AutomationDefinition {
  return {
    id,
    name,
    objective: PROMPT,
    trigger: { type: 'schedule', cron: '*/60 * * * *', timezone: 'UTC' },
    actorSelection: { mode: 'automatic', eligibleAgentIds: [] },
    executionMode: 'execute',
    actions: [],
    resources: [],
    dataFlow: { sources: [], destinations: [] },
    maximumAutonomy: 'autonomous',
    limits: [],
    enabled: true,
    legacyTriggerId: `trigger-${id}`,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));

function mount(definition: AutomationDefinition, variant: 'full' | 'compact' = 'full'): ReactTestInstance {
  act(() => {
    renderer = create(React.createElement(AutomationCard, {
      automation: definition,
      agentName: () => 'Writer',
      busy: false,
      controlsDisabled: false,
      onToggle: vi.fn(),
      onRun: vi.fn(),
      onStop: vi.fn(),
      onViewHistory: vi.fn(),
      variant,
    }));
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
  it('heads the card with the name, keeps the prompt underneath and names every control after it', () => {
    const root = mount(automation('1', 'Frontend PR watch'));
    const shown = texts(root);
    expect(shown[0]).toBe('Frontend PR watch');
    expect(shown[1]).toBe(PROMPT);
    expect(labels(root)).toEqual(expect.arrayContaining([
      'Automation Frontend PR watch',
      'Pause Frontend PR watch',
      'Run Frontend PR watch',
      'Stop Frontend PR watch',
      'View history for Frontend PR watch',
    ]));
    expect(labels(root).some((label) => label.includes(PROMPT))).toBe(false);
  });

  it('keeps two automations with the same prompt apart', () => {
    const first = texts(mount(automation('1', 'Frontend PR watch')));
    act(() => renderer.unmount());
    const second = texts(mount(automation('2', 'Backend PR watch')));
    expect(first[0]).not.toBe(second[0]);
    expect(first[1]).toBe(second[1]);
  });

  it('falls back to the objective only when there is no name, without repeating it', () => {
    const root = mount(automation('3', null));
    const shown = texts(root);
    expect(shown[0]).toBe(PROMPT);
    expect(shown.filter((text) => text === PROMPT)).toHaveLength(1);
    expect(labels(root)).toContain(`Run ${PROMPT}`);
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
