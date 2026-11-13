import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings › Connected accounts: the person's WhatsApp and Telegram accounts linked to Alia's gemie
 * (Gemies ADR 0035), drawn by the SDK's panel in this page's card.
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
    ALIA_GEMIE_ID: '01a1cf00-cecf-7a24-868b-42b452105a6f',
    GemieAccounts: (props: Record<string, unknown>) =>
      ReactModule.createElement('GemieAccounts', props),
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
  it('draws the SDK panel for Alia’s gemie, in the app’s words', () => {
    act(() => {
      renderer = create(<AccountsSection />);
    });
    const panel = renderer!.root.findByType('GemieAccounts' as never);
    expect(panel.props).toMatchObject({
      gemieId: '01a1cf00-cecf-7a24-868b-42b452105a6f',
      name: 'Alia',
    });
    expect(panel.props.t('gemie.accounts.link')).toBe('t:gemie.accounts.link');
    expect(renderer!.root.findByType('SettingsSection' as never).props.label).toBe(
      't:gemie.accounts.title',
    );
  });
});
