import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Herramientas principales" in the agent editor: the app tools active from
 * the agent's first step, chosen from the tools it reaches and saved on their
 * own as the whole list — never with the draft's autosave. Nothing at all for
 * somebody who does not operate the agent.
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
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@/shared/api/client', () => ({
  default: { get: api.get, put: vi.fn(), post: vi.fn(), patch: api.patch, delete: vi.fn() },
}));

const { AgentPrimaryToolsSection } = await import(
  '@/features/agents/ui/edit/agent-primary-tools-section'
);
const { useAgentPrimaryTools } = await import('@/features/agents/runtime/use-agent-primary-tools');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HOMIIO = {
  appId: 'homiio',
  name: 'Homiio',
  tools: [
    { key: 'homiio:resolvePlace', name: 'resolvePlace', description: 'Resolve a place' },
    { key: 'homiio:searchListings', name: 'searchListings', description: 'Search listings' },
    { key: 'homiio:saveHome', name: 'saveHome', description: 'Save a home' },
  ],
};

let renderer: ReactTestRenderer | null = null;

function Editor() {
  return <AgentPrimaryToolsSection primaryTools={useAgentPrimaryTools('agent-1')} />;
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

const rows = (tree: ReactTestRenderer): string[] =>
  tree.root
    .findAll((node) => (node.type as unknown) === 'SettingsListItem')
    .map((node) => String(node.props.title));
const switches = (tree: ReactTestRenderer): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === 'Switch');
const adder = (tree: ReactTestRenderer): ReactTestInstance | undefined =>
  tree.root.findAll((node) => (node.type as unknown) === 'Select')[0];
const offered = (select: ReactTestInstance): string[] =>
  (
    select.find((node) => (node.type as unknown) === 'SelectContent').props.items as Array<{
      label: string;
    }>
  ).map((item) => item.label);

function options(primaryTools: string[], max = 12) {
  return { data: { primaryTools, max, apps: [HOMIIO] } };
}

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('Primary tools', () => {
  it('lists the chosen tools and offers the rest of what the agent reaches', async () => {
    api.get.mockResolvedValue(options(['homiio:searchListings']));
    const tree = await render();
    expect(api.get).toHaveBeenCalledWith('/agents/agent-1/primary-tool-options');
    const group = tree.root.find((node) => (node.type as unknown) === 'SettingsListGroup');
    expect(group.props.title).toBe('Primary tools');
    expect(rows(tree)).toEqual(['Homiio · searchListings', 'Add a tool']);
    expect(offered(adder(tree) as ReactTestInstance)).toEqual([
      'Homiio · resolvePlace',
      'Homiio · saveHome',
    ]);
  });

  it('adds a tool by saving the whole list, and shows it at once', async () => {
    api.get.mockResolvedValue(options(['homiio:searchListings']));
    const saved = ['homiio:searchListings', 'homiio:resolvePlace'];
    api.patch.mockResolvedValue({ data: { agent: { _id: 'agent-1', primaryTools: saved } } });
    const tree = await render();
    await act(async () => adder(tree)?.props.onValueChange('homiio:resolvePlace'));
    await settle();
    expect(api.patch).toHaveBeenCalledWith('/agents/agent-1', { primaryTools: saved });
    expect(rows(tree)).toContain('Homiio · resolvePlace');
  });

  it('takes a tool away with its switch', async () => {
    api.get.mockResolvedValue(options(['homiio:searchListings', 'homiio:saveHome']));
    api.patch.mockResolvedValue({
      data: { agent: { _id: 'agent-1', primaryTools: ['homiio:saveHome'] } },
    });
    const tree = await render();
    await act(async () => switches(tree)[0]?.props.onCheckedChange(false));
    await settle();
    expect(api.patch).toHaveBeenCalledWith('/agents/agent-1', {
      primaryTools: ['homiio:saveHome'],
    });
  });

  it('puts the list back and says so when the save is refused', async () => {
    api.get.mockResolvedValue(options(['homiio:searchListings']));
    api.patch.mockRejectedValue(Object.assign(new Error('refused'), { response: { status: 400 } }));
    const tree = await render();
    await act(async () => switches(tree)[0]?.props.onCheckedChange(false));
    await settle();
    expect(rows(tree)).toContain('Homiio · searchListings');
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't save the primary tools. Nothing was changed.",
    );
  });

  it('still lists a chosen tool no level covers any more, as not available', async () => {
    api.get.mockResolvedValue(options(['mention:createPost']));
    const tree = await render();
    expect(rows(tree)[0]).toBe('mention:createPost (not available)');
  });

  it('offers nothing more once the limit is reached', async () => {
    api.get.mockResolvedValue(options(['homiio:searchListings'], 1));
    const tree = await render();
    expect(adder(tree)).toBeUndefined();
  });

  it('shows nothing to somebody who does not operate the agent', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('no'), { response: { status: 403 } }));
    const tree = await render();
    expect(tree.toJSON()).toBeNull();
  });
});
