import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Funciones con requisitos" in the agent editor (ADR 0020 §6): each of Alia's
 * gateable features is free or behind one feature of one app's live catalogue,
 * and a change is saved on its own as the whole gate map — never with the
 * draft's autosave. Nothing at all for somebody who does not operate the agent.
 *
 * Bloom is stubbed at its boundary as host elements carrying their props; the
 * words come from the real catalog.
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

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/select', async () => ({
  ...(await hosts(
    'SelectIcon',
    'SelectItem',
    'SelectItemIndicator',
    'SelectItemText',
    'SelectTrigger',
    'SelectValue',
  )),
  Select: await hosts('Select').then((made) => made.Select),
  SelectContent: ({ items }: { items: unknown[] }) =>
    React.createElement('SelectContent', { items }),
}));
vi.mock('@oxy.so/bloom/settings-list', async () => ({
  ...(await hosts('SettingsListGroup')),
  SettingsListItem: await slotted('SettingsListItem', ['rightElement']),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@/shared/api/client', () => ({
  default: { get: api.get, put: vi.fn(), post: vi.fn(), patch: api.patch, delete: vi.fn() },
}));

const { AgentFeatureGatesSection } = await import(
  '@/features/agents/ui/edit/agent-feature-gates-section'
);
const { useAgentFeatureGates } = await import('@/features/agents/runtime/use-agent-feature-gates');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const FEATURES = [
  'attachments.documents',
  'attachments.images',
  'deep_research',
  'power_level.pro',
  'power_level.ultra',
];
const HOMIIO = {
  appId: 'homiio',
  name: 'Homiio',
  features: [{ key: 'sindi.files', description: 'Homiio+ files' }],
};
const SINDI_GATES = { 'attachments.documents': { app: 'homiio', feature: 'sindi.files' } };

let renderer: ReactTestRenderer | null = null;

function Editor() {
  return <AgentFeatureGatesSection featureGates={useAgentFeatureGates('agent-1')} />;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Editor />
      </QueryClientProvider>,
    );
  });
  await settle();
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

const selects = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === 'Select');
const rows = (tree: ReactTestRenderer): string[] =>
  tree.root
    .findAll((node) => (node.type as unknown) === 'SettingsListItem')
    .map((node) => String(node.props.title));
const offered = (select: ReactTestInstance): string[] =>
  (
    select.find((node) => (node.type as unknown) === 'SelectContent').props.items as Array<{
      label: string;
    }>
  ).map((item) => item.label);

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('Features with requirements', () => {
  it('shows every gateable feature, free or behind the app feature it names', async () => {
    api.get.mockResolvedValue({ data: { features: FEATURES, gates: SINDI_GATES, apps: [HOMIIO] } });
    const tree = await render();
    expect(api.get).toHaveBeenCalledWith('/agents/agent-1/feature-gate-options');
    const group = tree.root.find((node) => (node.type as unknown) === 'SettingsListGroup');
    expect(group.props.title).toBe('Features with requirements');
    expect(rows(tree)).toEqual([
      'Attached documents',
      'Attached images',
      'Deep research',
      'Pro power level',
      'Ultra power level',
    ]);
    const [documents, images] = selects(tree);
    expect(documents?.props.value).toBe('homiio/sindi.files');
    expect(images?.props.value).toBe('none');
    expect(offered(images as ReactTestInstance)).toEqual(['None', 'Homiio · sindi.files']);
  });

  it('saves the whole gate map with the one feature changed, and shows it at once', async () => {
    api.get.mockResolvedValue({ data: { features: FEATURES, gates: SINDI_GATES, apps: [HOMIIO] } });
    const saved = {
      ...SINDI_GATES,
      'attachments.images': { app: 'homiio', feature: 'sindi.files' },
    };
    api.patch.mockResolvedValue({ data: { agent: { _id: 'agent-1', featureGates: saved } } });
    const tree = await render();
    await act(async () => selects(tree)[1]?.props.onValueChange('homiio/sindi.files'));
    await settle();
    expect(api.patch).toHaveBeenCalledWith('/agents/agent-1', { featureGates: saved });
    expect(selects(tree)[1]?.props.value).toBe('homiio/sindi.files');
  });

  it('takes a gate away with None', async () => {
    api.get.mockResolvedValue({ data: { features: FEATURES, gates: SINDI_GATES, apps: [HOMIIO] } });
    api.patch.mockResolvedValue({ data: { agent: { _id: 'agent-1', featureGates: {} } } });
    const tree = await render();
    await act(async () => selects(tree)[0]?.props.onValueChange('none'));
    await settle();
    expect(api.patch).toHaveBeenCalledWith('/agents/agent-1', { featureGates: {} });
  });

  it('puts the gate back and says so when the save is refused', async () => {
    api.get.mockResolvedValue({ data: { features: FEATURES, gates: SINDI_GATES, apps: [HOMIIO] } });
    api.patch.mockRejectedValue(Object.assign(new Error('refused'), { response: { status: 400 } }));
    const tree = await render();
    await act(async () => selects(tree)[0]?.props.onValueChange('none'));
    await settle();
    expect(selects(tree)[0]?.props.value).toBe('homiio/sindi.files');
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't save the feature requirements. Nothing was changed.",
    );
  });

  it('still shows a gate whose app no live catalogue offers, as not available', async () => {
    const clarity = { deep_research: { app: 'clarity', feature: 'deep_research' } };
    api.get.mockResolvedValue({ data: { features: FEATURES, gates: clarity, apps: [HOMIIO] } });
    const tree = await render();
    const deep = selects(tree)[2] as ReactTestInstance;
    expect(deep.props.value).toBe('clarity/deep_research');
    expect(offered(deep)).toContain('clarity · deep_research (not available)');
  });

  it('does not save a choice that did not change', async () => {
    api.get.mockResolvedValue({ data: { features: FEATURES, gates: SINDI_GATES, apps: [HOMIIO] } });
    const tree = await render();
    await act(async () => selects(tree)[0]?.props.onValueChange('homiio/sindi.files'));
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('shows nothing to somebody who does not operate the agent', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('no'), { response: { status: 403 } }));
    const tree = await render();
    expect(tree.toJSON()).toBeNull();
  });
});
