import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Accounts, Bots and Integrations pages are Bloom settings rows (label,
 * description, control) inside `SettingsProfilePage` sections. The page is
 * stubbed into plain hosts so the cases can read what each row offers and press
 * its control; what is asserted is the behaviour behind the rows — the hook
 * calls, the confirm before a destructive action, and the toasts.
 */

const mocks = vi.hoisted(() => ({
  accounts: {
    accounts: [] as unknown[],
    loading: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    remove: vi.fn(),
  },
  bots: {
    bots: [] as unknown[],
    linkStatuses: {} as Record<string, unknown>,
    loading: false,
    unlink: vi.fn(),
    refresh: vi.fn(),
  },
  integrations: {
    available: [] as unknown[],
    connected: [] as unknown[],
    loading: false,
    getOAuthUrl: vi.fn(),
    completeOAuth: vi.fn(),
    disconnect: vi.fn(),
  },
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  openURL: vi.fn(),
  canOpenURL: vi.fn(),
  replace: vi.fn(),
  params: {} as Record<string, string>,
}));

vi.mock('react-native', () => ({
  Linking: { openURL: mocks.openURL, canOpenURL: mocks.canOpenURL },
}));
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/lib/hooks/use-connected-accounts', () => ({
  useConnectedAccounts: () => mocks.accounts,
}));
vi.mock('@/lib/hooks/use-bots', () => ({ useBots: () => mocks.bots }));
vi.mock('@/lib/hooks/use-integrations', () => ({
  useIntegrations: () => mocks.integrations,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useLocalSearchParams: () => mocks.params,
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: mocks.toast }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm: mocks.confirm }));
vi.mock('@oxy.so/bloom/icons/RiExternalLinkLine', () => ({
  RiExternalLinkLine: () => null,
}));
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
vi.mock('@oxy.so/bloom/settings-modal', async () => {
  const ReactModule = await import('react');
  type Row = { key: string; label: string; description?: string; control?: React.ReactNode };
  type Section = { key: string; label?: string; description?: string; rows: Row[] };
  return {
    SettingsProfilePage: ({ sections }: { sections: Section[] }) =>
      ReactModule.createElement(
        'Page',
        null,
        sections.map((section) =>
          ReactModule.createElement(
            'Section',
            { key: section.key, testID: section.key, label: section.label, description: section.description },
            section.rows.map((row) =>
              ReactModule.createElement(
                'Row',
                { key: row.key, testID: `${section.key}:${row.key}`, label: row.label, description: row.description },
                row.control,
              ),
            ),
          ),
        ),
      ),
  };
});

import { AccountsSection } from '../accounts-section';
import { BotsSection } from '../bots-section';
import { IntegrationsSection } from '../integrations-section';

let renderer: ReactTestRenderer | null = null;

function mount(element: React.ReactElement) {
  act(() => {
    renderer = create(element);
  });
  return renderer!;
}

const row = (r: ReactTestRenderer, id: string) => r.root.findByProps({ testID: id });
const button = (r: ReactTestRenderer, id: string) => row(r, id).findByType('Button' as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accounts.accounts = [];
  mocks.accounts.loading = false;
  mocks.bots.bots = [];
  mocks.bots.linkStatuses = {};
  mocks.integrations.available = [];
  mocks.integrations.connected = [];
  mocks.params = {};
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('AccountsSection', () => {
  it('shows a skeleton row while loading', () => {
    mocks.accounts.loading = true;
    const r = mount(<AccountsSection />);
    expect(r.root.findAllByType('Skeleton' as never)).toHaveLength(1);
  });

  it('lists accounts with their status and an empty row when there are none', () => {
    let r = mount(<AccountsSection />);
    expect(row(r, 'accounts:empty').props.label).toBe('settings.connections.accounts.empty');
    act(() => r.unmount());

    mocks.accounts.accounts = [
      { _id: 'a1', platform: 'whatsapp', accountId: 'x', phoneNumber: '+34 600', status: 'connected' },
    ];
    r = mount(<AccountsSection />);
    const account = row(r, 'accounts:a1');
    expect(account.props.label).toBe('WhatsApp');
    expect(account.props.description).toBe('+34 600 · settings.connections.accounts.status.connected');
  });

  it('connects a platform from its row', async () => {
    mocks.accounts.connect.mockResolvedValue(undefined);
    const r = mount(<AccountsSection />);
    await act(async () => {
      button(r, 'connect:telegram').props.onPress();
    });
    expect(mocks.accounts.connect).toHaveBeenCalledWith('telegram');
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'settings.connections.accounts.connectingToast {"name":"Telegram"}',
    );
  });

  it('removes an account only after the confirm', async () => {
    mocks.accounts.accounts = [{ _id: 'a1', platform: 'gmail', accountId: 'me@x', status: 'connected' }];
    mocks.accounts.remove.mockResolvedValue(undefined);
    const r = mount(<AccountsSection />);

    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => {
      await button(r, 'accounts:a1').props.onPress();
    });
    expect(mocks.accounts.remove).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce(true);
    await act(async () => {
      await button(r, 'accounts:a1').props.onPress();
    });
    expect(mocks.accounts.remove).toHaveBeenCalledWith('a1');
    expect(mocks.toast.success).toHaveBeenCalledWith('settings.connections.accounts.disconnectedToast');
  });
});

describe('BotsSection', () => {
  it('links through the platform deep link and unlinks a linked bot', async () => {
    mocks.bots.bots = [
      { _id: 'b1', platform: 'telegram', name: 'Alia', username: 'alia_bot', status: 'active' },
      { _id: 'b2', platform: 'telegram', name: 'Other', username: 'other', status: 'active' },
    ];
    mocks.bots.linkStatuses = { b2: { linked: true, username: 'nate' } };
    mocks.canOpenURL.mockResolvedValue(true);
    mocks.bots.unlink.mockResolvedValue(undefined);
    const r = mount(<BotsSection />);

    expect(row(r, 'bots:b2').props.description).toContain('settings.connections.bots.linkedAs');
    await act(async () => {
      await button(r, 'bots:b1').props.onPress();
    });
    expect(mocks.openURL).toHaveBeenCalledWith('https://t.me/alia_bot?start=link');

    await act(async () => {
      await button(r, 'bots:b2').props.onPress();
    });
    expect(mocks.bots.unlink).toHaveBeenCalledWith('b2');
  });

  it('reports a platform it cannot link', async () => {
    mocks.bots.bots = [{ _id: 'b1', platform: 'discord', name: 'D', status: 'inactive' }];
    const r = mount(<BotsSection />);
    await act(async () => {
      await button(r, 'bots:b1').props.onPress();
    });
    expect(mocks.openURL).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'settings.connections.bots.linkUnsupported {"platform":"discord"}',
    );
  });
});

describe('IntegrationsSection', () => {
  it('offers only services that are not connected, and starts their OAuth', async () => {
    mocks.integrations.available = [
      { service: 'github', name: 'GitHub', description: 'Code' },
      { service: 'notion', name: 'Notion', description: 'Docs' },
    ];
    mocks.integrations.connected = [
      { _id: 'i1', service: 'github', displayName: 'GitHub', accountName: 'nate', status: 'active' },
    ];
    mocks.integrations.getOAuthUrl.mockResolvedValue('https://auth.example/notion');
    const r = mount(<IntegrationsSection />);

    expect(r.root.findAllByProps({ testID: 'available:github' })).toHaveLength(0);
    expect(row(r, 'connected:i1').props.description).toBe(
      'nate · settings.connections.integrations.status.active',
    );
    await act(async () => {
      await button(r, 'available:notion').props.onPress();
    });
    expect(mocks.integrations.getOAuthUrl).toHaveBeenCalledWith('notion');
    expect(mocks.openURL).toHaveBeenCalledWith('https://auth.example/notion');
  });

  it('finishes an OAuth callback once and returns to the page', async () => {
    mocks.params = { service: 'notion', int_oauth_state: 's1', int_oauth_code: 'c1' };
    mocks.integrations.completeOAuth.mockResolvedValue(undefined);
    await act(async () => {
      mount(<IntegrationsSection />);
    });
    expect(mocks.integrations.completeOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.integrations.completeOAuth).toHaveBeenCalledWith('notion', 's1', 'c1');
    expect(mocks.replace).toHaveBeenCalledWith('/(app)/settings/integrations');
  });

  it('disconnects after the confirm', async () => {
    mocks.integrations.connected = [
      { _id: 'i1', service: 'github', displayName: 'GitHub', status: 'expired' },
    ];
    mocks.integrations.disconnect.mockResolvedValue(undefined);
    mocks.confirm.mockResolvedValue(true);
    const r = mount(<IntegrationsSection />);
    await act(async () => {
      await button(r, 'connected:i1').props.onPress();
    });
    expect(mocks.integrations.disconnect).toHaveBeenCalledWith('i1');
  });
});
