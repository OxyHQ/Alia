import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/shared/i18n/locales/en.json';

/**
 * Settings → Memory. What Alia remembers lives in the person's Nilo workspace,
 * so the page explains that and opens it; it only keeps the recall switch.
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
const openURL = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => hosts('View', 'Text'));
vi.mock('expo-linking', () => ({ openURL }));
vi.mock('@oxy.so/bloom/settings-modal', async () => hosts('SettingsCard', 'SettingsRow'));
vi.mock('@oxy.so/bloom/switch', async () => hosts('Switch'));
vi.mock('@oxy.so/bloom/button', async () => hosts('Button'));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, user: { id: 'A' } }),
  useAuth: () => ({ isAuthenticated: true, signIn: vi.fn() }),
}));
vi.mock('@/shared/api/client', () => ({
  default: { get: api.get, put: api.put },
}));

const { MemorySection } = await import('@/features/settings/ui/memory-section');
const { useUserDataStore } = await import('@/features/memory/runtime/user-data-store');
const { commitAccountProjection } = await import('@/shared/state/account-epoch');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

async function render(): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <MemorySection />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)));
  if (!renderer) throw new Error('not rendered');
  return renderer;
}

const all = (tree: ReactTestRenderer, type: string): ReactTestInstance[] =>
  tree.root.findAll((node) => (node.type as unknown) === type);

beforeEach(() => {
  commitAccountProjection('A', 'session-A');
  const profile = { settings: { recallEnabled: true }, preferences: {} };
  useUserDataStore.setState({ memory: profile });
  api.get.mockReset().mockResolvedValue({ data: profile });
  api.put.mockReset().mockResolvedValue({ data: { recallEnabled: false } });
  openURL.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  useUserDataStore.setState({ memory: null });
});

describe('Settings → Memory', () => {
  it('says memories live in Nilo and opens nilo.so', async () => {
    const tree = await render();
    const row = all(tree, 'SettingsRow')[0]!;
    expect(row.props.label).toBe(en.settings.assistant.memory.niloTitle);
    expect(row.props.description).toBe(en.settings.assistant.memory.niloDescription);
    const button = all(tree, 'Button')[0]!;
    await act(async () => button.props.onPress());
    expect(openURL).toHaveBeenCalledWith('https://nilo.so');
  });

  it('keeps the recall switch, and nothing of the old entries or of a pause for everything', async () => {
    const tree = await render();
    await act(async () => all(tree, 'Switch')[0]!.props.onCheckedChange(false));
    expect(api.put).toHaveBeenCalledWith('/memory/settings', { recallEnabled: false });
    expect(useUserDataStore.getState().memory?.settings.recallEnabled).toBe(false);
    expect(all(tree, 'Search')).toHaveLength(0);
  });
});
