import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings › Connected accounts: the person's WhatsApp and Telegram accounts, connected once and
 * granted to their gemies (Gemies ADR 0035 as amended), drawn by the SDK's panel in this page's card.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});
vi.mock('@gemies/sdk/accounts', async () => {
  const ReactModule = await import('react');
  return {
    GemieConnectedAccounts: (props: Record<string, unknown>) =>
      ReactModule.createElement('GemieConnectedAccounts', props),
  };
});
vi.mock('@oxy.so/bloom/settings-modal', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { SettingsCard: host('SettingsCard'), SettingsSection: host('SettingsSection') };
});
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));

import { AccountsSection } from '../accounts-section';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('AccountsSection', () => {
  it('draws the SDK’s Settings panel, for the person and not for one gemie, in the app’s words', () => {
    act(() => {
      renderer = create(<AccountsSection />);
    });
    const panel = renderer!.root.findByType('GemieConnectedAccounts' as never);
    expect(panel.props.gemieId).toBeUndefined();
    expect(panel.props.t('gemie.accounts.connect')).toBe('t:gemie.accounts.connect');
    expect(renderer!.root.findByType('SettingsSection' as never).props.label).toBe(
      't:gemie.accounts.title',
    );
  });
});
