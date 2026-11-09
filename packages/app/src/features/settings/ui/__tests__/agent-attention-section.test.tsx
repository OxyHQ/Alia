import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Attention page: the owner's heartbeat, what the agent hears about, and what waits in its
 * inbox (ADR 0026). Bloom is stubbed at its boundary as host elements carrying their props; the
 * words come from the real catalog; the hooks and the API routes they call are real.
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

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const open = vi.hoisted(() => vi.fn());
const params = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const mine = vi.hoisted(() => ({ agents: undefined as unknown, pending: false }));
const updateAgent = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/settings-modal', async () =>
  hosts('SettingsCard', 'SettingsRow', 'SettingsSection'),
);
vi.mock('@oxy.so/bloom/settings-modal/rows', async () => hosts('SettingsSelect'));
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/button', async () => hosts('Button'));
vi.mock('@oxy.so/bloom/skeleton', async () => hosts('Box', 'Region'));
vi.mock('@oxy.so/bloom/icons/RiArrowLeftLine', () => ({ RiArrowLeftLine: 'RiArrowLeftLine' }));
vi.mock('@oxy.so/bloom/icons/RiDeleteBinLine', () => ({ RiDeleteBinLine: 'RiDeleteBinLine' }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@/shared/api/client', () => ({ default: api }));
vi.mock('@/features/settings/ui/settings-context', () => ({
  useAliaSettings: () => ({ open, close: vi.fn(), afterClose: vi.fn(), params: params.value }),
}));
vi.mock('@/features/agents/runtime/use-my-agents', () => ({
  useMyAgents: () => ({ data: mine.agents, isPending: mine.pending }),
}));
vi.mock('@/features/agents/runtime/use-agents', () => ({
  useUpdateAgent: () => ({ mutateAsync: updateAgent, isPending: false }),
}));

const { AgentAttentionSection, AttentionAgentsSection } = await import(
  '@/features/settings/ui/agent-attention-section'
);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  await settle();
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

const all = (tree: ReactTestRenderer, type: string): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === type);

const switchLabelled = (tree: ReactTestRenderer, label: string) =>
  all(tree, 'Switch').find((node) => String(node.props.accessibilityLabel).includes(label));

const OWNER = 'owner-account';
const subscription = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  agentId: 'agent-1',
  ownerAccountId: OWNER,
  sourceAccountId: OWNER,
  appId: 'inbox',
  eventType: 'new_email',
  enabled: true,
  ...over,
});

let subscriptions: ReturnType<typeof subscription>[] = [];
let items: unknown[] = [];
let paused = false;

beforeEach(() => {
  subscriptions = [];
  items = [];
  paused = false;
  api.get.mockReset().mockImplementation(async (url: string) => {
    if (url.endsWith('/pause')) return { data: { paused } };
    return url.endsWith('/inbox') ? { data: { items } } : { data: { subscriptions } };
  });
  api.put.mockReset().mockResolvedValue({ data: {} });
  api.post.mockReset().mockResolvedValue({ data: { subscription: subscription() } });
  api.delete.mockReset().mockResolvedValue({ data: undefined });
  toast.error.mockReset();
  updateAgent.mockReset().mockResolvedValue({});
  open.mockReset();
  params.value = { agentId: 'agent-1', name: 'Scout' };
  mine.pending = false;
  mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: null }];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('the list of agents', () => {
  it('opens the Attention page for one agent', async () => {
    const tree = await render(<AttentionAgentsSection />);
    await act(async () => all(tree, 'Button')[0].props.onPress());
    expect(open).toHaveBeenCalledWith('agent-attention', { agentId: 'agent-1', name: 'Scout' });
  });

  it('draws a skeleton while the agents load, never a spinner', async () => {
    mine.pending = true;
    mine.agents = undefined;
    const tree = await render(<AttentionAgentsSection />);
    expect(all(tree, 'Region').length).toBeGreaterThan(0);
    expect(all(tree, 'Button')).toHaveLength(0);
  });
});

describe('pausing everything that starts on its own', () => {
  it('shows it off, and turning it on sends paused: true to the automations route', async () => {
    const tree = await render(<AttentionAgentsSection />);
    const toggle = switchLabelled(tree, 'Pause everything');
    expect(toggle?.props.checked).toBe(false);
    await act(async () => toggle?.props.onCheckedChange(true));
    expect(api.put).toHaveBeenCalledWith('/automations/pause', { paused: true });
  });

  it('shows it on when the person already paused, and turning it off sends paused: false', async () => {
    paused = true;
    const tree = await render(<AttentionAgentsSection />);
    const toggle = switchLabelled(tree, 'Pause everything');
    expect(toggle?.props.checked).toBe(true);
    await act(async () => toggle?.props.onCheckedChange(false));
    expect(api.put).toHaveBeenCalledWith('/automations/pause', { paused: false });
  });

  it('tells the person when the change fails', async () => {
    api.put.mockRejectedValueOnce(new Error('offline'));
    const tree = await render(<AttentionAgentsSection />);
    await act(async () => switchLabelled(tree, 'Pause everything')?.props.onCheckedChange(true));
    expect(toast.error).toHaveBeenCalledWith("Couldn't change the pause. Try again.");
  });
});

describe('the heartbeat', () => {
  it('is off with no frequency row when the agent has no interval; turning it on starts at an hour', async () => {
    const tree = await render(<AgentAttentionSection />);
    expect(all(tree, 'SettingsSelect')).toHaveLength(0);
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(true));
    expect(updateAgent).toHaveBeenCalledWith({ id: 'agent-1', updates: { scheduleInterval: 60 } });
  });

  it('turning it off sends null', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 240 }];
    const tree = await render(<AgentAttentionSection />);
    const select = all(tree, 'SettingsSelect')[0];
    expect(select.props.value).toBe('240');
    expect(select.props.items.map((item: { value: string }) => item.value)).toEqual([
      '15',
      '30',
      '60',
      '240',
      '1440',
    ]);
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(false));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { scheduleInterval: null },
    });
  });

  it('picking a frequency sends its minutes', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 60 }];
    const tree = await render(<AgentAttentionSection />);
    await act(async () => all(tree, 'SettingsSelect')[0].props.onChange('1440'));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { scheduleInterval: 1440 },
    });
  });

  it('keeps an interval set elsewhere visible as a choice', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 5 }];
    const tree = await render(<AgentAttentionSection />);
    expect(all(tree, 'SettingsSelect')[0].props.items[0].value).toBe('5');
  });

  it('tells the person when the save fails', async () => {
    updateAgent.mockRejectedValue(new Error('boom'));
    const tree = await render(<AgentAttentionSection />);
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(true));
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('what it hears about', () => {
  it('shows both ready-made toggles off and subscribes to the owner account', async () => {
    const tree = await render(<AgentAttentionSection />);
    expect(switchLabelled(tree, 'Tell')?.props.checked).toBe(false);
    await act(async () => switchLabelled(tree, 'Tell')?.props.onCheckedChange(true));
    expect(api.post).toHaveBeenCalledWith('/agents/agent-1/subscriptions', {
      appId: 'inbox',
      eventType: 'new_email',
      account: 'owner',
    });
  });

  it("subscribes to the agent's own mailbox with the second toggle", async () => {
    const tree = await render(<AgentAttentionSection />);
    await act(async () => switchLabelled(tree, 'own mailbox')?.props.onCheckedChange(true));
    expect(api.post).toHaveBeenCalledWith('/agents/agent-1/subscriptions', {
      appId: 'inbox',
      eventType: 'new_email',
      account: 'agent',
    });
  });

  it('reads each toggle from the subscription, and turning one off deletes it', async () => {
    subscriptions = [
      subscription({ id: 'mine' }),
      subscription({ id: 'its', sourceAccountId: 'bot' }),
    ];
    const tree = await render(<AgentAttentionSection />);
    expect(switchLabelled(tree, 'Tell')?.props.checked).toBe(true);
    expect(switchLabelled(tree, 'own mailbox')?.props.checked).toBe(true);
    await act(async () => switchLabelled(tree, 'own mailbox')?.props.onCheckedChange(false));
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/subscriptions/its');
    expect(api.delete).not.toHaveBeenCalledWith('/agents/agent-1/subscriptions/mine');
  });

  it('lists the others as rows with a remove button', async () => {
    subscriptions = [
      subscription({ id: 'api-made', appId: 'calendar', eventType: 'event_created' }),
    ];
    const tree = await render(<AgentAttentionSection />);
    const row = all(tree, 'SettingsRow').find(
      (node) => node.props.label === 'calendar · event_created',
    );
    expect(row).toBeDefined();
    await act(async () =>
      all(tree, 'Button')
        .find((b) => b.props.tone === 'danger')
        ?.props.onPress(),
    );
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/subscriptions/api-made');
  });

  it('says the limit was reached on a 409', async () => {
    api.post.mockRejectedValue({ response: { status: 409, data: { error: 'limit' } } });
    const tree = await render(<AgentAttentionSection />);
    await act(async () => switchLabelled(tree, 'Tell')?.props.onCheckedChange(true));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('25'));
  });
});

describe('the inbox', () => {
  it('asks for pending items and renders each as one plain line', async () => {
    items = [
      {
        id: 'i1',
        appId: 'inbox',
        eventType: 'new_email',
        summary: { subject: 'Hola', from: 'ana@x.com' },
      },
      { id: 'i2', appId: 'inbox', eventType: 'new_email', summary: 42 },
    ];
    const tree = await render(<AgentAttentionSection />);
    expect(api.get).toHaveBeenCalledWith('/agents/agent-1/inbox', {
      params: { status: 'pending' },
    });
    const labels = all(tree, 'SettingsRow').map((node) => node.props.label);
    expect(labels).toContain('Hola · ana@x.com');
    expect(labels).toContain('inbox · new_email');
  });

  it('says so when nothing is waiting', async () => {
    const tree = await render(<AgentAttentionSection />);
    expect(
      all(tree, 'SettingsRow').some((node) =>
        String(node.props.label).includes('Nothing is waiting'),
      ),
    ).toBe(true);
  });
});
