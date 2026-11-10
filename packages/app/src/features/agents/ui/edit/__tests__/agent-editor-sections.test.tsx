import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What an agent has beyond who it is, as the editor draws it: how it works on its own, what it
 * hears about, its inbox and what it remembers (ADR 0026). They are per agent, so they are the
 * agent editor's, not the settings'. Bloom is stubbed at its boundary as host elements carrying
 * their props; the words come from the real catalog; the hooks and the API routes are real.
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
const confirm = vi.hoisted(() => vi.fn());
const mine = vi.hoisted(() => ({ agents: undefined as unknown, pending: false }));
const updateAgent = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/agent-creator', async () => hosts('AgentCreatorField', 'AgentCreatorSection'));
vi.mock('@oxy.so/bloom/typography', async () => hosts('Text'));
vi.mock('@/features/agents/ui/edit/sections/editor-select', async () => hosts('EditorSelect'));
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/button', async () => hosts('Button'));
vi.mock('@oxy.so/bloom/button-group', async () => hosts('ButtonGroup', 'ButtonGroupItem'));
vi.mock('@oxy.so/bloom/textarea', async () => hosts('Textarea'));
vi.mock('@oxy.so/bloom/skeleton', async () => hosts('Box', 'Region'));
vi.mock('@oxy.so/bloom/settings-modal', async () => hosts('SettingsCard'));
vi.mock('@oxy.so/bloom/icons/RiDeleteBinLine', () => ({ RiDeleteBinLine: 'RiDeleteBinLine' }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, user: { id: 'A' }, activeSessionId: 'session-A' }),
}));
vi.mock('@/shared/api/client', () => ({
  default: api,
  getApiSessionSnapshot: () => JSON.stringify({ userId: 'A', bindingRevision: 1, sessionEpoch: 0 }),
  isCurrentApiSession: () => true,
  onApiSessionContextChange: () => () => {},
}));
vi.mock('@/features/agents/runtime/use-my-agents', () => ({
  useMyAgents: () => ({ data: mine.agents, isPending: mine.pending }),
}));
vi.mock('@/features/agents/runtime/use-agents', () => ({
  useUpdateAgent: () => ({ mutateAsync: updateAgent, isPending: false }),
}));

const { commitAccountProjection } = await import('@/shared/state/account-epoch');
const { AgentEditorSections } = await import(
  '@/features/agents/ui/edit/sections/agent-editor-sections'
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

async function render(): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AgentEditorSections agentId="agent-1" name="Scout" />
      </QueryClientProvider>,
    );
  });
  await settle();
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

const all = (tree: ReactTestRenderer, type: string): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === type);

/** The frequency select: the editor also has a computer select, so never index by position. */
const select = (tree: ReactTestRenderer, label: string) =>
  all(tree, 'EditorSelect').find((node) => String(node.props.label).startsWith(label));

const switchLabelled = (tree: ReactTestRenderer, label: string) =>
  all(tree, 'Switch').find((node) => String(node.props.accessibilityLabel).includes(label));

/** Every string the editor's rows and notes draw. */
const texts = (tree: ReactTestRenderer): string[] =>
  all(tree, 'Text').map((node) => [node.props.children].flat().join(''));

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
let lastHeartbeatAt: string | null = null;
let alerts = {
  alia: { enabled: true },
  agents: [{ agentId: 'agent-1', name: 'Scout', handle: 'scout', color: null, enabled: false }],
};
let documents: { path: string }[] = [];

beforeEach(() => {
  commitAccountProjection('A', 'session-A');
  subscriptions = [];
  items = [];
  lastHeartbeatAt = null;
  documents = [];
  alerts = {
    alia: { enabled: true },
    agents: [{ agentId: 'agent-1', name: 'Scout', handle: 'scout', color: null, enabled: false }],
  };
  api.get.mockReset().mockImplementation(async (url: string, config?: { params?: { path?: string } }) => {
    if (url === '/notifications/email-alerts') return { data: alerts };
    if (url.endsWith('/inbox'))
      return { data: { items, heartbeat: { intervalMinutes: 60, lastHeartbeatAt } } };
    if (url.endsWith('/subscriptions')) return { data: { subscriptions } };
    if (url.endsWith('/memory'))
      return config?.params?.path
        ? { data: { path: config.params.path, content: '- likes tea\n', hash: 'h1', exists: true } }
        : {
            data: {
              documents: documents.map((d) => ({
                ...d,
                byteLength: 12,
                updatedAt: '2026-10-06T00:00:00.000Z',
              })),
            },
          };
    throw new Error(`unexpected GET ${url}`);
  });
  api.put.mockReset().mockResolvedValue({ data: {} });
  api.post.mockReset().mockResolvedValue({ data: { subscription: subscription() } });
  api.delete.mockReset().mockResolvedValue({ data: undefined });
  toast.error.mockReset();
  confirm.mockReset().mockResolvedValue(true);
  updateAgent.mockReset().mockResolvedValue({});
  mine.pending = false;
  mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: null }];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('whose computer the agent works on', () => {
  it('shows the default as Alia’s and changes it to the agent’s own', async () => {
    const tree = await render();
    const computer = select(tree, 'Where Scout works');
    expect(computer?.props.value).toBe('alia');
    expect(computer?.props.items.map((item: { value: string }) => item.value)).toEqual([
      'alia',
      'own',
    ]);
    await act(async () => computer?.props.onChange('own'));
    expect(updateAgent).toHaveBeenCalledWith({ id: 'agent-1', updates: { computerSource: 'own' } });
  });

  it('shows an agent that keeps its own machine as such, and moves it back', async () => {
    mine.agents = [
      { _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: null, computerSource: 'own' },
    ];
    const tree = await render();
    const computer = select(tree, 'Where Scout works');
    expect(computer?.props.value).toBe('own');
    await act(async () => computer?.props.onChange('alia'));
    expect(updateAgent).toHaveBeenCalledWith({
      id: 'agent-1',
      updates: { computerSource: 'alia' },
    });
  });

  it('explains what the shared computer is, and tells the person when the change fails', async () => {
    updateAgent.mockRejectedValueOnce(new Error('offline'));
    const tree = await render();
    expect(texts(tree).some((text) => text.startsWith("Alia's is the shared workspace"))).toBe(true);
    await act(async () => select(tree, 'Where Scout works')?.props.onChange('own'));
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('the heartbeat', () => {
  it('is off with no frequency row when the agent has no interval; turning it on starts at an hour', async () => {
    const tree = await render();
    expect(select(tree, 'The longest')).toBeUndefined();
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(true));
    expect(updateAgent).toHaveBeenCalledWith({ id: 'agent-1', updates: { scheduleInterval: 60 } });
  });

  it('turning it off sends null', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 240 }];
    const tree = await render();
    const frequency = select(tree, 'The longest');
    expect(frequency?.props.value).toBe('240');
    expect(frequency?.props.items.map((item: { value: string }) => item.value)).toEqual([
      '15',
      '30',
      '60',
      '240',
      '1440',
    ]);
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(false));
    expect(updateAgent).toHaveBeenCalledWith({ id: 'agent-1', updates: { scheduleInterval: null } });
  });

  it('picking a frequency sends its minutes', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 60 }];
    const tree = await render();
    await act(async () => select(tree, 'The longest')?.props.onChange('1440'));
    expect(updateAgent).toHaveBeenCalledWith({ id: 'agent-1', updates: { scheduleInterval: 1440 } });
  });

  it('keeps an interval set elsewhere visible as a choice', async () => {
    mine.agents = [{ _id: 'agent-1', name: 'Scout', handle: 'scout', scheduleInterval: 5 }];
    const tree = await render();
    expect(select(tree, 'The longest')?.props.items[0].value).toBe('5');
  });

  it('tells the person when the save fails', async () => {
    updateAgent.mockRejectedValue(new Error('boom'));
    const tree = await render();
    await act(async () => switchLabelled(tree, 'Check on its own')?.props.onCheckedChange(true));
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('what it hears about', () => {
  it('shows both ready-made toggles off and subscribes to the owner account', async () => {
    const tree = await render();
    expect(switchLabelled(tree, 'in your Inbox')?.props.checked).toBe(false);
    await act(async () => switchLabelled(tree, 'in your Inbox')?.props.onCheckedChange(true));
    expect(api.post).toHaveBeenCalledWith('/agents/agent-1/subscriptions', {
      appId: 'inbox',
      eventType: 'new_email',
      account: 'owner',
    });
  });

  it("subscribes to the agent's own mailbox with the second toggle", async () => {
    const tree = await render();
    await act(async () => switchLabelled(tree, 'new emails in its own')?.props.onCheckedChange(true));
    expect(api.post).toHaveBeenCalledWith('/agents/agent-1/subscriptions', {
      appId: 'inbox',
      eventType: 'new_email',
      account: 'agent',
    });
  });

  it('reads each toggle from the subscription, and turning one off deletes it', async () => {
    subscriptions = [subscription({ id: 'mine' }), subscription({ id: 'its', sourceAccountId: 'bot' })];
    const tree = await render();
    expect(switchLabelled(tree, 'in your Inbox')?.props.checked).toBe(true);
    expect(switchLabelled(tree, 'new emails in its own')?.props.checked).toBe(true);
    await act(async () => switchLabelled(tree, 'new emails in its own')?.props.onCheckedChange(false));
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/subscriptions/its');
    expect(api.delete).not.toHaveBeenCalledWith('/agents/agent-1/subscriptions/mine');
  });

  it('lists the others with a remove button', async () => {
    subscriptions = [subscription({ id: 'api-made', appId: 'calendar', eventType: 'event_created' })];
    const tree = await render();
    expect(all(tree, 'AgentCreatorField').some((row) => row.props.label === 'calendar')).toBe(true);
    await act(async () =>
      all(tree, 'Button')
        .find((b) => b.props.tone === 'danger')
        ?.props.onPress(),
    );
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/subscriptions/api-made');
  });

  it('says the limit was reached on a 409', async () => {
    api.post.mockRejectedValue({ response: { status: 409, data: { error: 'limit' } } });
    const tree = await render();
    await act(async () => switchLabelled(tree, 'in your Inbox')?.props.onCheckedChange(true));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('25'));
  });

  it("lets the agent tell the person about important mail in its own mailbox, and saves a flip", async () => {
    const tree = await render();
    const important = switchLabelled(tree, 'important emails');
    expect(important?.props.checked).toBe(false);
    await act(async () => important?.props.onCheckedChange(true));
    await settle();
    expect(api.put).toHaveBeenCalledWith(
      '/notifications/email-alerts',
      { agentId: 'agent-1', enabled: true },
      { signal: expect.any(AbortSignal) },
    );
  });
});

describe('the inbox', () => {
  it('asks for pending items and renders each as one plain line', async () => {
    items = [
      { id: 'i1', appId: 'inbox', eventType: 'new_email', summary: { subject: 'Hola', from: 'ana@x.com' } },
      { id: 'i2', appId: 'inbox', eventType: 'new_email', summary: 42 },
    ];
    const tree = await render();
    expect(api.get).toHaveBeenCalledWith('/agents/agent-1/inbox', { params: { status: 'pending' } });
    expect(texts(tree)).toContain('Hola · ana@x.com');
    expect(texts(tree)).toContain('inbox · new_email');
  });

  it('says so when nothing is waiting', async () => {
    const tree = await render();
    expect(texts(tree).some((text) => text.includes('Nothing is waiting'))).toBe(true);
  });

  it('says when the agent last looked, so an empty inbox does not read as broken', async () => {
    lastHeartbeatAt = '2026-11-09T12:00:00.000Z';
    const tree = await render();
    expect(texts(tree).some((text) => text.startsWith('Last looked at its inbox: '))).toBe(true);
    expect(texts(tree).some((text) => text.includes('Nothing is waiting'))).toBe(true);
  });

  it('says so when it has never looked', async () => {
    const tree = await render();
    expect(texts(tree)).toContain("Scout hasn't looked at its inbox yet.");
  });
});

describe('what the agent remembers', () => {
  it('says so when it remembers nothing', async () => {
    const tree = await render();
    expect(texts(tree)).toContain('Scout does not remember anything about you.');
  });

  it('edits a file with the hash it read, and forgets it after confirming', async () => {
    documents = [{ path: 'MEMORY.md' }];
    const tree = await render();

    const textarea = all(tree, 'Textarea')[0]!;
    expect(textarea.props.value).toBe('- likes tea\n');
    await act(async () => textarea.props.onChangeText('- likes coffee\n'));
    const [save] = all(tree, 'ButtonGroupItem');
    await act(async () => save?.props.onPress());
    await settle();
    expect(api.put).toHaveBeenCalledWith('/agents/agent-1/memory', {
      path: 'MEMORY.md',
      content: '- likes coffee\n',
      expectedHash: 'h1',
    });

    const forget = all(tree, 'ButtonGroupItem')[1]!;
    expect(forget.props.accessibilityLabel).toBe('Forget MEMORY.md');
    await act(async () => forget.props.onPress());
    await settle();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true, title: 'Forget MEMORY.md' }),
    );
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/memory', { params: { path: 'MEMORY.md' } });
  });

  it('forgets everything only after the person confirms', async () => {
    documents = [{ path: 'MEMORY.md' }];
    const tree = await render();
    const forgetAll = all(tree, 'Button').find(
      (node) => node.props.tone === 'danger' && String(node.props.children).includes('forget everything'),
    )!;

    confirm.mockResolvedValueOnce(false);
    await act(async () => forgetAll.props.onPress());
    await settle();
    expect(api.delete).not.toHaveBeenCalled();

    await act(async () => forgetAll.props.onPress());
    await settle();
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/memory', { params: {} });
  });
});
