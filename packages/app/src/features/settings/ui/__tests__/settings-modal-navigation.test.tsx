import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  authenticated: true,
  props: null as any,
  committed: null as any,
  opens: [] as any[],
  close: vi.fn(),
}));
vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({ isAuthenticated: state.authenticated }),
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/settings/ui/sections', () => ({
  SETTINGS_GROUPS: [
    {
      titleKey: 'settings',
      sections: [
        { id: 'general', labelKey: 'General', icon: () => null },
        { id: 'accounts', labelKey: 'Accounts', icon: () => null },
      ],
    },
  ],
}));
vi.mock('@oxy.so/bloom/dialog', () => {
  const control = {
    open: () =>
      state.opens.push({
        page: state.committed.page,
        initialView: state.committed.initialView,
      }),
    close: state.close,
  };
  return { useDialogControl: () => control };
});
vi.mock('@oxy.so/bloom/settings-modal', async () => {
  const { useLayoutEffect } = await import('react');
  return {
    SettingsModal: (props: any) => {
      state.props = props;
      useLayoutEffect(() => {
        state.committed = props;
      });
      return null;
    },
  };
});
vi.mock('@/features/settings/ui/general-section', () => ({
  GeneralSection: () => null,
}));
vi.mock('@/features/settings/ui/profile-section', () => ({
  ProfileSection: () => null,
}));
vi.mock('@/features/settings/ui/storage-section', () => ({
  StorageSection: () => null,
}));
vi.mock('@/features/settings/ui/personalization-section', () => ({
  PersonalizationSection: () => null,
}));
vi.mock('@/features/settings/ui/accounts-section', () => ({
  AccountsSection: () => null,
}));
vi.mock('@/features/settings/ui/bots-section', () => ({
  BotsSection: () => null,
}));
vi.mock('@/features/settings/ui/connectors-section', () => ({
  ConnectorsSection: () => null,
}));
vi.mock('@/features/settings/ui/integrations-section', () => ({
  IntegrationsSection: () => null,
}));
vi.mock('@/features/settings/ui/local-models-section', () => ({
  LocalModelsSection: () => null,
}));
vi.mock('@/features/settings/ui/billing-section', () => ({
  BillingSection: () => null,
}));
vi.mock('@/features/settings/ui/usage-section', () => ({
  UsageSection: () => null,
}));
vi.mock('@/features/settings/ui/security-section', () => ({
  SecuritySection: () => null,
}));
vi.mock('@/features/settings/ui/memory-section', () => ({
  MemorySection: () => null,
}));
vi.mock('@/features/settings/ui/writing-style-section', () => ({
  WritingStyleSection: () => null,
}));
vi.mock('@/features/settings/ui/connector-detail-section', () => ({
  ConnectorDetailSection: () => null,
}));

import { AliaSettingsProvider } from '@/features/settings/ui/alia-settings';
import {
  useAliaSettings,
  type AliaSettingsActions,
} from '@/features/settings/ui/settings-context';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
let actions: AliaSettingsActions;
function Harness() {
  actions = useAliaSettings();
  return null;
}
beforeEach(() => {
  state.authenticated = true;
  state.opens = [];
  state.close.mockClear();
});
afterEach(() => act(() => renderer?.unmount()));
function mount() {
  act(() => {
    renderer = create(
      <AliaSettingsProvider>
        <Harness />
      </AliaSettingsProvider>,
    );
  });
}
it('commits compact page mode before first deep link and every reopen', () => {
  mount();
  act(() => actions.open());
  expect(state.opens.at(-1)).toEqual({
    page: 'general',
    initialView: 'navigation',
  });
  act(() => actions.open('accounts'));
  expect(state.opens.at(-1)).toEqual({ page: 'accounts', initialView: 'page' });
  act(() => actions.close());
  act(() => actions.open());
  act(() => actions.open('accounts'));
  expect(state.opens.at(-1)).toEqual({ page: 'accounts', initialView: 'page' });
});
it('does not expose private sections or deep links to a signed-out account', () => {
  state.authenticated = false;
  mount();
  act(() => actions.open('accounts'));
  expect(state.props.pages.accounts).toBeUndefined();
  expect(state.props.pages['connector-detail']).toBeUndefined();
  expect(state.opens.at(-1).page).toBe('general');
});
it('retains OAuth callback parameters after returning to the workspace', () => {
  mount();
  act(() =>
    actions.open('connector-detail', {
      id: 'calendar',
      mcp_oauth_code: 'fixture',
      mcp_oauth_state: 'state',
    }),
  );
  expect(actions.params).toEqual({
    id: 'calendar',
    mcp_oauth_code: 'fixture',
    mcp_oauth_state: 'state',
  });
});
it('hands off SDK surfaces only after modal exit completes', () => {
  mount();
  const account = vi.fn();
  act(() => actions.afterClose(account));
  expect(state.close).toHaveBeenCalledOnce();
  expect(account).not.toHaveBeenCalled();
  act(() => state.props.onClose());
  expect(account).toHaveBeenCalledOnce();
  act(() => state.props.onClose());
  expect(account).toHaveBeenCalledOnce();
});
