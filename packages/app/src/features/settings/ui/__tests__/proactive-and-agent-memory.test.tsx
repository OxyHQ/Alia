import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two settings pages of Fase 3: "Avisos" (Alia and each owned agent may tell
 * the person about important email) and what ONE agent remembers about the
 * person — its own memory, editable and forgettable.
 *
 * Bloom is stubbed at its boundary as host elements carrying their props; the
 * words come from the real catalog.
 */

const { hosts } = vi.hoisted(() => ({
  hosts: async (...names: string[]) => {
    const ReactModule = await import('react');
    return Object.fromEntries(names.map((name) => [
      name,
      ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        ReactModule.createElement(name, props, children as React.ReactNode),
    ]));
  },
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const params = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/settings-modal', async () => hosts('SettingsCard', 'SettingsRow', 'SettingsSection'));
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/button', async () => hosts('Button'));
vi.mock('@oxy.so/bloom/button-group', async () => hosts('ButtonGroup', 'ButtonGroupItem'));
vi.mock('@oxy.so/bloom/textarea', async () => hosts('Textarea'));
vi.mock('@oxy.so/bloom/skeleton', async () => hosts('Box'));
vi.mock('@oxy.so/bloom/icons/RiArrowLeftLine', () => ({ RiArrowLeftLine: 'RiArrowLeftLine' }));
vi.mock('@oxy.so/bloom/icons/RiDeleteBinLine', () => ({ RiDeleteBinLine: 'RiDeleteBinLine' }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@/shared/api/client', () => ({ default: { get: api.get, put: api.put, delete: api.delete, post: vi.fn(), patch: vi.fn() } }));
vi.mock('@/features/settings/ui/settings-context', () => ({
  useAliaSettings: () => ({ open, close: vi.fn(), afterClose: vi.fn(), params: params.value }),
}));

const { ProactiveSection } = await import('@/features/settings/ui/proactive-section');
const { AgentMemorySection, RememberingAgentsSection } = await import('@/features/settings/ui/agent-memory-section');

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

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset().mockResolvedValue({ data: {} });
  api.delete.mockReset().mockResolvedValue({ data: { removed: 1 } });
  confirm.mockReset().mockResolvedValue(true);
  open.mockReset();
  params.value = {};
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('Avisos: important email', () => {
  it('shows Alia\'s switch and one per owned agent, on by default, and saves a flip', async () => {
    api.get.mockResolvedValue({ data: {
      alia: { enabled: true },
      agents: [{ agentId: 'agent-1', name: 'Scout', handle: 'scout', color: null, enabled: false }],
    } });
    const tree = await render(<ProactiveSection />);
    expect(api.get).toHaveBeenCalledWith('/notifications/email-alerts');

    const [alia, scout] = all(tree, 'Switch');
    expect(alia?.props.accessibilityLabel).toBe('Tell me about important emails');
    expect(alia?.props.checked).toBe(true);
    expect(scout?.props.checked).toBe(false);

    await act(async () => alia?.props.onCheckedChange(false));
    await settle();
    expect(api.put).toHaveBeenCalledWith('/notifications/email-alerts', { agentId: null, enabled: false });
    expect(all(tree, 'Switch')[0]?.props.checked).toBe(false);

    await act(async () => all(tree, 'Switch')[1]?.props.onCheckedChange(true));
    await settle();
    expect(api.put).toHaveBeenLastCalledWith('/notifications/email-alerts', { agentId: 'agent-1', enabled: true });
  });
});

describe('what each agent remembers', () => {
  it('lists the agents that remember the person and opens one', async () => {
    api.get.mockResolvedValue({ data: { agents: [{ agentId: 'agent-1', name: 'Scout', handle: 'scout', color: null, files: 2, updatedAt: null }] } });
    const tree = await render(<RememberingAgentsSection />);
    expect(api.get).toHaveBeenCalledWith('/memory/agents');
    const row = all(tree, 'SettingsRow').find((node) => node.props.label === 'Scout');
    expect(row?.props.description).toBe('2 notes');
    await act(async () => all(tree, 'Button')[0]?.props.onPress());
    expect(open).toHaveBeenCalledWith('agent-memory', { agentId: 'agent-1', name: 'Scout' });
  });

  it('edits a file with the hash it read, and forgets it after confirming', async () => {
    params.value = { agentId: 'agent-1', name: 'Scout' };
    api.get.mockImplementation(async (_url: string, config?: { params?: { path?: string } }) => (config?.params?.path
      ? { data: { path: 'MEMORY.md', content: '- likes tea\n', hash: 'h1', exists: true } }
      : { data: { documents: [{ path: 'MEMORY.md', byteLength: 12, updatedAt: '2026-10-06T00:00:00.000Z' }] } }));
    const tree = await render(<AgentMemorySection />);

    const textarea = all(tree, 'Textarea')[0]!;
    expect(textarea.props.value).toBe('- likes tea\n');
    await act(async () => textarea.props.onChangeText('- likes coffee\n'));
    const [save] = all(tree, 'ButtonGroupItem');
    await act(async () => save?.props.onPress());
    await settle();
    expect(api.put).toHaveBeenCalledWith('/agents/agent-1/memory', { path: 'MEMORY.md', content: '- likes coffee\n', expectedHash: 'h1' });

    const forget = all(tree, 'ButtonGroupItem')[1]!;
    expect(forget.props.accessibilityLabel).toBe('Forget MEMORY.md');
    await act(async () => forget.props.onPress());
    await settle();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true, title: 'Forget MEMORY.md' }));
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/memory', { params: { path: 'MEMORY.md' } });
  });

  it('forgets everything only after the person confirms', async () => {
    params.value = { agentId: 'agent-1', name: 'Scout' };
    api.get.mockImplementation(async (_url: string, config?: { params?: { path?: string } }) => (config?.params?.path
      ? { data: { path: 'MEMORY.md', content: 'x', hash: 'h', exists: true } }
      : { data: { documents: [{ path: 'MEMORY.md', byteLength: 1, updatedAt: '2026-10-06T00:00:00.000Z' }] } }));
    const tree = await render(<AgentMemorySection />);
    const forgetAll = all(tree, 'Button').find((node) => node.props.tone === 'danger')!;

    confirm.mockResolvedValueOnce(false);
    await act(async () => forgetAll.props.onPress());
    await settle();
    expect(api.delete).not.toHaveBeenCalled();

    await act(async () => forgetAll.props.onPress());
    await settle();
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/memory', { params: {} });
    expect(open).toHaveBeenCalledWith('memory');
  });
});
