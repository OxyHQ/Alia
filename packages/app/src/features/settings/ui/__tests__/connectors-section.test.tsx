import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings › Connected draws only what the person connected — the SDK's list, the same one the
 * Gemies app draws — and finding more is the store's own page, so browsing closes the dialog first.
 */

const mocks = vi.hoisted(() => ({
  afterClose: vi.fn((action: () => void) => action()),
  push: vi.fn(),
}));

vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../settings-context', () => ({
  useAliaSettings: () => ({ afterClose: mocks.afterClose }),
}));
vi.mock('@gemies/sdk/connectors', async () => {
  const ReactModule = await import('react');
  return {
    GemieConnectedConnectors: (props: Record<string, unknown>) =>
      ReactModule.createElement('GemieConnectedConnectors', props),
  };
});

import { ConnectorsSection } from '../connectors-section';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.clearAllMocks();
});

function list() {
  act(() => {
    renderer = create(<ConnectorsSection />);
  });
  return renderer!.root.findByType('GemieConnectedConnectors' as never).props as {
    nativeScheme: string;
    onBrowse: () => void;
    t: (key: string) => string;
  };
}

describe('Settings › Connected', () => {
  it("draws the SDK's list of connected accounts, returning native sign-ins to this app", () => {
    const props = list();
    expect(props.nativeScheme).toBe('alia');
    expect(props.t('x')).toBe('x');
  });

  it('opens the store as its own page, after the dialog has closed', () => {
    list().onBrowse();
    expect(mocks.afterClose).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledWith('/(app)/connectors');
  });
});
