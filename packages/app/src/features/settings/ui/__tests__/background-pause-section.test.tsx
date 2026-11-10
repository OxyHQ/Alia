import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pausing everything that starts on its own: the one part of "what an agent notices" that is the
 * person's and not an agent's, so it stays in the settings (an agent's own heartbeat, inbox and
 * subscriptions are edited with the agent). Bloom is stubbed at its boundary as host elements.
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

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('@oxy.so/bloom/settings-modal', async () =>
  hosts('SettingsCard', 'SettingsRow', 'SettingsSection'),
);
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/skeleton', async () => hosts('Box', 'Region'));
vi.mock('@oxy.so/bloom/toast', () => ({ toast }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@/shared/api/client', () => ({ default: api }));

const { BackgroundPauseSection } = await import('@/features/settings/ui/background-pause-section');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
let paused = false;

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
        <BackgroundPauseSection />
      </QueryClientProvider>,
    );
  });
  await settle();
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

const all = (tree: ReactTestRenderer, type: string): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === type);

beforeEach(() => {
  paused = false;
  api.get.mockReset().mockImplementation(async () => ({ data: { paused } }));
  api.put.mockReset().mockResolvedValue({ data: {} });
  toast.error.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('pausing everything that starts on its own', () => {
  it('shows it off, and turning it on sends paused: true to the automations route', async () => {
    const tree = await render();
    const toggle = all(tree, 'Switch')[0];
    expect(toggle?.props.checked).toBe(false);
    await act(async () => toggle?.props.onCheckedChange(true));
    expect(api.put).toHaveBeenCalledWith('/automations/pause', { paused: true });
  });

  it('shows it on when the person already paused, and turning it off sends paused: false', async () => {
    paused = true;
    const tree = await render();
    const toggle = all(tree, 'Switch')[0];
    expect(toggle?.props.checked).toBe(true);
    await act(async () => toggle?.props.onCheckedChange(false));
    expect(api.put).toHaveBeenCalledWith('/automations/pause', { paused: false });
  });

  it('tells the person when the change fails', async () => {
    api.put.mockRejectedValueOnce(new Error('offline'));
    const tree = await render();
    await act(async () => all(tree, 'Switch')[0]?.props.onCheckedChange(true));
    expect(toast.error).toHaveBeenCalledWith("Couldn't change the pause. Try again.");
  });

  it('draws a skeleton while it loads, never a spinner', async () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const tree = await render();
    expect(all(tree, 'Region').length).toBeGreaterThan(0);
    expect(all(tree, 'Switch')).toHaveLength(0);
  });
});
