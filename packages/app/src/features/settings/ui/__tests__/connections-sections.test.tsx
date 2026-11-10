import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Accounts page is Bloom settings rows (label,
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
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  openURL: vi.fn(),
  canOpenURL: vi.fn(),
  replace: vi.fn(),
  params: {} as Record<string, string>,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Linking: { openURL: mocks.openURL, canOpenURL: mocks.canOpenURL },
    View: (props: object) => ReactModule.createElement('View', props),
  };
});
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('@/features/connections/runtime/use-connected-accounts', () => ({
  useConnectedAccounts: () => mocks.accounts,
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
  const host = (name: string) => () => ReactModule.createElement(name);
  return { Box: host('Skeleton'), Region: host('SkeletonRegion') };
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
    SettingsCard: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('Card', null, children),
    SettingsProfilePage: ({ sections }: { sections: Section[] }) =>
      ReactModule.createElement(
        'Page',
        null,
        sections.map((section) =>
          ReactModule.createElement(
            'Section',
            {
              key: section.key,
              testID: section.key,
              label: section.label,
              description: section.description,
            },
            section.rows.map((row) =>
              ReactModule.createElement(
                'Row',
                {
                  key: row.key,
                  testID: `${section.key}:${row.key}`,
                  label: row.label,
                  description: row.description,
                },
                row.control,
              ),
            ),
          ),
        ),
      ),
  };
});

import { AccountsSection } from '../accounts-section';

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
    // The rows hold their place as one region of placeholders, and say nothing about waiting.
    expect(r.root.findAllByType('SkeletonRegion' as never)).toHaveLength(1);
  });

  it('lists accounts with their status and an empty row when there are none', () => {
    let r = mount(<AccountsSection />);
    expect(row(r, 'accounts:empty').props.label).toBe('settings.connections.accounts.empty');
    act(() => r.unmount());

    mocks.accounts.accounts = [
      {
        _id: 'a1',
        platform: 'whatsapp',
        accountId: 'x',
        phoneNumber: '+34 600',
        status: 'connected',
      },
    ];
    r = mount(<AccountsSection />);
    const account = row(r, 'accounts:a1');
    expect(account.props.label).toBe('WhatsApp');
    expect(account.props.description).toBe(
      '+34 600 · settings.connections.accounts.status.connected',
    );
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
    mocks.accounts.accounts = [
      { _id: 'a1', platform: 'gmail', accountId: 'me@x', status: 'connected' },
    ];
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
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'settings.connections.accounts.disconnectedToast',
    );
  });
});
