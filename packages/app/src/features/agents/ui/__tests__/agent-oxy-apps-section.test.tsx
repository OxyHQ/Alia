import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Apps de Oxy" in the agent editor: one row per Oxy app, three levels
 * (*Nada* · *Ver* · *Ver y actuar*), each change sent as exactly the level the
 * owner picked — and nothing at all for somebody who is not the owner.
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

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const toastError = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/segmented-control', async () =>
  hosts('SegmentedControl', 'SegmentedControlItem', 'SegmentedControlItemText'),
);
vi.mock('@oxy.so/bloom/settings-list', async () => ({
  ...(await hosts('SettingsListGroup')),
  SettingsListItem: await slotted('SettingsListItem', ['rightElement']),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@/shared/api/client', () => ({
  default: { get: api.get, put: api.put, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const { AgentOxyAppsSection } = await import('@/features/agents/ui/edit/agent-oxy-apps-section');
const { useAgentOxyApps } = await import('@/features/agents/runtime/use-agent-oxy-apps');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const INBOX = { appId: 'inbox', name: 'Inbox', level: 'none', levels: ['none', 'read', 'act'] };
const MENTION = { appId: 'mention', name: 'Mention', level: 'read', levels: ['none', 'read'] };

let renderer: ReactTestRenderer | null = null;

function Editor() {
  return <AgentOxyAppsSection oxyApps={useAgentOxyApps('agent-1')} />;
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

function controls(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll((node) => (node.type as unknown) === 'SegmentedControl');
}

function labels(control: ReactTestInstance): string[] {
  return control
    .findAll((node) => (node.type as unknown) === 'SegmentedControlItemText')
    .map((node) => String(node.props.children));
}

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('Apps de Oxy', () => {
  it('shows one row per app at its current level, offering only the levels the app has', async () => {
    api.get.mockResolvedValue({ data: { apps: [INBOX, MENTION] } });
    const tree = await render();
    expect(api.get).toHaveBeenCalledWith('/agents/agent-1/oxy-apps');
    const group = tree.root.find((node) => (node.type as unknown) === 'SettingsListGroup');
    expect(group.props.title).toBe('Oxy apps');
    const [inbox, mention] = controls(tree);
    expect(inbox?.props.value).toBe('none');
    expect(labels(inbox as ReactTestInstance)).toEqual(['None', 'View', 'View and act']);
    expect(mention?.props.value).toBe('read');
    expect(labels(mention as ReactTestInstance)).toEqual(['None', 'View']);
  });

  it('sends exactly the level picked, and shows it at once', async () => {
    api.get.mockResolvedValue({ data: { apps: [INBOX] } });
    api.put.mockResolvedValue({ data: { app: { ...INBOX, level: 'act' } } });
    const tree = await render();
    await act(async () => controls(tree)[0]?.props.onValueChange('act'));
    await settle();
    expect(api.put).toHaveBeenCalledWith('/agents/agent-1/oxy-apps/inbox', { level: 'act' });
    expect(controls(tree)[0]?.props.value).toBe('act');
  });

  it('puts the level back and says so when Oxy refuses the change', async () => {
    api.get.mockResolvedValue({ data: { apps: [INBOX] } });
    api.put.mockRejectedValue(Object.assign(new Error('refused'), { response: { status: 502 } }));
    const tree = await render();
    await act(async () => controls(tree)[0]?.props.onValueChange('read'));
    await settle();
    expect(controls(tree)[0]?.props.value).toBe('none');
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Inbox'));
  });

  it('does not send a level that did not change', async () => {
    api.get.mockResolvedValue({ data: { apps: [INBOX] } });
    const tree = await render();
    await act(async () => controls(tree)[0]?.props.onValueChange('none'));
    expect(api.put).not.toHaveBeenCalled();
  });

  it('shows nothing to somebody who is not the owner', async () => {
    api.get.mockRejectedValue(
      Object.assign(new Error('owner_only'), { response: { status: 403 } }),
    );
    const tree = await render();
    expect(tree.toJSON()).toBeNull();
  });

  it('says it could not load, rather than showing every app at Nada', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('down'), { response: { status: 502 } }));
    const tree = await render();
    const group = tree.root.find((node) => (node.type as unknown) === 'SettingsListGroup');
    expect(group.props.footer).toBe("Couldn't load your Oxy apps. Try again later.");
    expect(controls(tree)).toEqual([]);
  });
});
