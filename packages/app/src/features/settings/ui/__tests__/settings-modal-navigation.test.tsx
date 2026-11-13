import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  authenticated: true,
  props: null as any,
  committed: null as any,
  opens: [] as any[],
  close: vi.fn(),
}));
// The settings chunk is preloaded on web only; here, nothing is preloaded behind the test's back.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@oxy.so/services/ui/client', () => ({
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
vi.mock('@/features/settings/ui/storage-section', () => ({
  StorageSection: () => null,
}));
vi.mock('@/features/settings/ui/personalization-section', () => ({
  PersonalizationSection: () => null,
}));
vi.mock('@/features/settings/ui/accounts-section', () => ({
  AccountsSection: () => null,
}));
vi.mock('@/features/settings/ui/external-agents-section', () => ({
  ExternalAgentsSection: () => null,
}));
vi.mock('@/features/settings/ui/connectors-section', () => ({
  ConnectorsSection: () => null,
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
vi.mock('@/features/settings/ui/skills-section', () => ({ SkillsSection: () => null }));
vi.mock('@/features/settings/ui/writing-style-section', () => ({
  WritingStyleSection: () => null,
}));
vi.mock('@/features/settings/ui/connector-detail-section', () => ({
  ConnectorDetailSection: () => null,
}));
vi.mock('@/features/settings/ui/agent-attention-section', () => ({
  AgentAttentionSection: () => null,
}));
vi.mock('@/features/settings/ui/agent-memory-section', () => ({
  AgentMemorySection: () => null,
}));
vi.mock('@/features/settings/ui/proactive-section', () => ({
  ProactiveSection: () => null,
}));

import { AliaSettingsProvider } from '@/features/settings/ui/alia-settings';
import { useAliaSettings, type AliaSettingsActions } from '@/features/settings/ui/settings-context';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
let actions: AliaSettingsActions;
function Harness() {
  actions = useAliaSettings();
  return null;
}
beforeEach(() => {
  state.authenticated = true;
  state.props = null;
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
// The modal is a lazy chunk: loaded once here, so the first `open()` mounts it within its act().
beforeAll(async () => {
  await import('@/features/settings/ui/alia-settings-modal');
});
async function open(...args: Parameters<AliaSettingsActions['open']>) {
  await act(async () => actions.open(...args));
}
it('does not load the modal until settings are first opened', () => {
  mount();
  expect(state.props).toBeNull();
});
it('commits compact page mode before first deep link and every reopen', async () => {
  mount();
  await open();
  expect(state.opens.at(-1)).toEqual({
    page: 'general',
    initialView: 'navigation',
  });
  await open('accounts');
  expect(state.opens.at(-1)).toEqual({ page: 'accounts', initialView: 'page' });
  act(() => actions.close());
  await open();
  await open('accounts');
  expect(state.opens.at(-1)).toEqual({ page: 'accounts', initialView: 'page' });
});
it('does not expose private sections or deep links to a signed-out account', async () => {
  state.authenticated = false;
  mount();
  await open('accounts');
  expect(state.props.pages.accounts).toBeUndefined();
  expect(state.props.pages['connector-detail']).toBeUndefined();
  expect(state.opens.at(-1).page).toBe('general');
});
it('retains OAuth callback parameters after returning to the workspace', async () => {
  mount();
  await open('connector-detail', {
    id: 'calendar',
    mcp_oauth_code: 'fixture',
    mcp_oauth_state: 'state',
  });
  expect(actions.params).toEqual({
    id: 'calendar',
    mcp_oauth_code: 'fixture',
    mcp_oauth_state: 'state',
  });
});
it('hands off SDK surfaces only after modal exit completes', async () => {
  mount();
  await open();
  const account = vi.fn();
  act(() => actions.afterClose(account));
  expect(state.close).toHaveBeenCalledOnce();
  expect(account).not.toHaveBeenCalled();
  act(() => state.props.onClose());
  expect(account).toHaveBeenCalledOnce();
  act(() => state.props.onClose());
  expect(account).toHaveBeenCalledOnce();
});
