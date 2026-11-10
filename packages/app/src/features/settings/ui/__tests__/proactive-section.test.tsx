import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings page "Avisos": Alia may tell the person about important email. Each agent's own
 * mailbox alert is a switch in that agent's editor.
 *
 * Bloom is stubbed at its boundary as host elements carrying their props; the
 * words come from the real catalog.
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

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/settings-modal', async () =>
  hosts('SettingsCard', 'SettingsRow', 'SettingsSection'),
);
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/skeleton', async () => hosts('Box', 'Region'));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, user: { id: 'A' }, activeSessionId: 'session-A' }),
}));
vi.mock('@/shared/api/client', () => ({
  default: { get: api.get, put: api.put, delete: api.delete, post: vi.fn(), patch: vi.fn() },
  getApiSessionSnapshot: () => JSON.stringify({ userId: 'A', bindingRevision: 1, sessionEpoch: 0 }),
  isCurrentApiSession: () => true,
  onApiSessionContextChange: () => () => {},
}));

const { commitAccountProjection } = await import('@/shared/state/account-epoch');
const { ProactiveSection } = await import('@/features/settings/ui/proactive-section');

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
  commitAccountProjection('A', 'session-A');
  api.get.mockReset();
  api.put.mockReset().mockResolvedValue({ data: {} });
  api.delete.mockReset().mockResolvedValue({ data: { removed: 1 } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('Avisos: important email', () => {
  it("shows Alia's switch, on by default, and saves a flip", async () => {
    let server = {
      alia: { enabled: true },
      agents: [{ agentId: 'agent-1', name: 'Scout', handle: 'scout', color: null, enabled: false }],
    };
    api.get.mockImplementation(async () => ({ data: server }));
    api.put.mockImplementation(
      async (_path, input: { agentId: string | null; enabled: boolean }) => {
        server =
          input.agentId === null
            ? { ...server, alia: { enabled: input.enabled } }
            : {
                ...server,
                agents: server.agents.map((agent) =>
                  agent.agentId === input.agentId ? { ...agent, enabled: input.enabled } : agent,
                ),
              };
        return { data: {} };
      },
    );
    const tree = await render(<ProactiveSection />);
    expect(api.get).toHaveBeenCalledWith('/notifications/email-alerts', {
      signal: expect.any(AbortSignal),
    });

    const [alia] = all(tree, 'Switch');
    expect(all(tree, 'Switch')).toHaveLength(1);
    expect(alia?.props.accessibilityLabel).toBe('Tell me about important emails');
    expect(alia?.props.checked).toBe(true);

    await act(async () => alia?.props.onCheckedChange(false));
    await settle();
    expect(api.put).toHaveBeenCalledWith(
      '/notifications/email-alerts',
      {
        agentId: null,
        enabled: false,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(all(tree, 'Switch')[0]?.props.checked).toBe(false);
  });
});
