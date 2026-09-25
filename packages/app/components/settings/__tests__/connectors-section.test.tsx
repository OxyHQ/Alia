import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Connectors page: installed servers as Bloom's `SettingsServerList`
 * (letter tile, status, tools, "…" menu), the registry as settings rows. Bloom's
 * pieces are stubbed into hosts so the cases read what the list is handed and
 * drive its callbacks; what is asserted is the behaviour behind them.
 */

const mocks = vi.hoisted(() => ({
  hook: {
    registry: [] as unknown[],
    installed: [] as unknown[],
    loading: false,
    install: vi.fn(),
    installCustom: vi.fn(),
    uninstall: vi.fn(),
    startOAuth: vi.fn(),
    completeOAuth: vi.fn(),
  },
  settings: { open: vi.fn(), close: vi.fn(), afterClose: vi.fn(), params: {} as Record<string, string> },
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  openURL: vi.fn(),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Linking: { openURL: mocks.openURL },
    Platform: { OS: 'ios' },
    StyleSheet: { create: <T,>(s: T) => s },
    View: ({ children }: React.PropsWithChildren) => ReactModule.createElement('View', null, children),
  };
});
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/lib/hooks/use-mcp-servers', () => ({ useMcpServers: () => mocks.hook }));
vi.mock('@/lib/errors/error-utils', () => ({ errorStatus: () => undefined }));
vi.mock('../settings-context', () => ({ useAliaSettings: () => mocks.settings }));
vi.mock('../preference-select', () => ({ SettingsPreferenceSelect: () => null }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: mocks.toast }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm: mocks.confirm }));
vi.mock('@oxy.so/bloom/dialog', () => ({ Dialog: () => null }));
vi.mock('@oxy.so/bloom/search', () => ({ Search: () => null }));
vi.mock('@oxy.so/bloom/text-field', () => ({ TextFieldInput: () => null, TextFieldLabel: () => null }));
vi.mock('@oxy.so/bloom/accordion', () => ({
  Accordion: () => null,
  AccordionItem: () => null,
  AccordionTrigger: () => null,
  AccordionContent: () => null,
}));
vi.mock('@oxy.so/bloom/icons/RiArrowDownSLine', () => ({ RiArrowDownSLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiArrowRightSLine', () => ({ RiArrowRightSLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiCheckLine', () => ({ RiCheckLine: () => null }));
vi.mock('@oxy.so/bloom/skeleton', async () => {
  const ReactModule = await import('react');
  return { Box: () => ReactModule.createElement('Skeleton') };
});
vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});
vi.mock('@oxy.so/bloom/badge', async () => {
  const ReactModule = await import('react');
  return {
    Badge: (props: Record<string, unknown>) => ReactModule.createElement('Badge', props),
  };
});
vi.mock('@oxy.so/bloom/settings-modal', async () => {
  const ReactModule = await import('react');
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    SettingsCard: host('SettingsCard'),
    SettingsRow: host('SettingsRow'),
    SettingsSection: host('SettingsSection'),
    SettingsServerList: host('SettingsServerList'),
  };
});

import { ConnectorsSection } from '../connectors-section';

let renderer: ReactTestRenderer | null = null;
function mount() {
  act(() => {
    renderer = create(<ConnectorsSection />);
  });
  return renderer!;
}

const github = {
  _id: 's1',
  name: 'github',
  displayName: 'GitHub',
  source: 'registry',
  registryId: 'github',
  status: 'running',
  config: { requiresOAuth: true },
  tools: [{ name: 'create_issue' }, { name: 'list_repos' }],
};
const custom = {
  _id: 's2',
  name: 'mine',
  displayName: 'Mine',
  source: 'custom',
  status: 'error',
  statusMessage: 'ECONNREFUSED',
  config: { url: 'https://mine.example/mcp' },
  tools: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hook.registry = [];
  mocks.hook.installed = [];
  mocks.hook.loading = false;
  mocks.settings.params = {};
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const serverList = (r: ReactTestRenderer) => r.root.findAllByType('SettingsServerList' as never)[0]!;

describe('ConnectorsSection', () => {
  it('shows a skeleton row while loading', () => {
    mocks.hook.loading = true;
    const r = mount();
    expect(r.root.findAllByType('Skeleton' as never)).toHaveLength(1);
  });

  it('hands connected servers to the server list with status and tools', () => {
    mocks.hook.installed = [
      github,
      custom,
      // OAuth install whose flow never completed: not connected, not listed.
      { ...github, _id: 's3', registryId: 'linear', status: 'installed' },
    ];
    const r = mount();
    const servers = serverList(r).props.servers as { id: string; status: string; tools: string[]; summary: string }[];
    expect(servers.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(servers[0]).toMatchObject({ status: 'connected', tools: ['create_issue', 'list_repos'] });
    expect(servers[0]!.summary).toBe('settings.connections.toolCount {"count":2}');
    expect(servers[1]!.status).toBe('error');
  });

  it('routes the server actions: details, uninstall behind a confirm, and output', async () => {
    mocks.hook.installed = [github, custom];
    mocks.hook.uninstall.mockResolvedValue(undefined);
    const r = mount();
    const list = serverList(r);

    act(() => list.props.onServerAction('s1', 'details'));
    expect(mocks.settings.open).toHaveBeenCalledWith('connector-detail', { id: 'github' });

    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => {
      list.props.onServerAction('s1', 'uninstall');
    });
    expect(mocks.hook.uninstall).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce(true);
    await act(async () => {
      list.props.onLogout('s1');
    });
    expect(mocks.hook.uninstall).toHaveBeenCalledWith('s1');

    act(() => list.props.onShowOutput('s2'));
    expect(mocks.toast.error).toHaveBeenCalledWith('Mine: ECONNREFUSED');
  });

  it('connects a registry entry through OAuth from its row', async () => {
    mocks.hook.registry = [
      { id: 'linear', name: 'Linear', description: 'Issues', requiredEnv: [], requiresOAuth: true, featured: true, category: 'productivity' },
    ];
    mocks.hook.install.mockResolvedValue({ _id: 'new' });
    mocks.hook.startOAuth.mockResolvedValue('https://auth.example/linear');
    const r = mount();
    const row = r.root.findByProps({ label: 'Linear' });
    const connect = row.findAllByType('Button' as never)[1]!;
    await act(async () => {
      await connect.props.onPress();
    });
    expect(mocks.hook.install).toHaveBeenCalledWith('linear');
    expect(mocks.hook.startOAuth).toHaveBeenCalledWith('new');
    expect(mocks.openURL).toHaveBeenCalledWith('https://auth.example/linear');
  });

  it('says a connected entry is connected with a badge, not a button that cannot be pressed', () => {
    mocks.hook.registry = [
      { id: 'github', name: 'GitHub', description: 'Code', requiredEnv: [], requiresOAuth: true, featured: true, category: 'development' },
    ];
    mocks.hook.installed = [github];
    const r = mount();
    const row = r.root.findByProps({ label: 'GitHub' });
    // The one button left is "View details", which does something.
    const buttons = row.findAllByType('Button' as never);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.onPress).toBeTypeOf('function');
    expect(buttons.some((button) => button.props.disabled === true)).toBe(false);
    expect(row.findByType('Badge' as never).props.content).toBe('connectors.connected');
  });

  it('finishes the OAuth callback from the settings params once', async () => {
    mocks.settings.params = { mcp_oauth_state: 'st', mcp_oauth_code: 'cd' };
    mocks.hook.completeOAuth.mockResolvedValue(undefined);
    await act(async () => {
      mount();
    });
    expect(mocks.hook.completeOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.hook.completeOAuth).toHaveBeenCalledWith('st', 'cd');
    expect(mocks.toast.success).toHaveBeenCalledWith('connectors.connected');
    expect(mocks.settings.open).toHaveBeenCalledWith('connectors');
  });
});
