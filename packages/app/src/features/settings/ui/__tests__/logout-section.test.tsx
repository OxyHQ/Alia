import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Settings → General offers Log out: this device's session only, after a confirm. */

const { oxy, confirmMock } = vi.hoisted(() => ({
  oxy: { logout: vi.fn(), logoutAll: vi.fn() },
  confirmMock: vi.fn(),
}));

vi.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
vi.mock('@oxy.so/bloom/icons/RiLogoutCircleLine', () => ({ RiLogoutCircleLine: () => null }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm: confirmMock }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => oxy }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/settings/ui/settings-context', () => ({
  useAliaSettings: () => ({ afterClose: (action: () => void) => action() }),
}));

const { useLogoutSection } = await import('@/features/settings/ui/logout-section');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
function section() {
  let value!: ReturnType<typeof useLogoutSection>;
  const Probe = () => {
    value = useLogoutSection();
    return null;
  };
  act(() => {
    renderer = create(<Probe />);
  });
  return value;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.clearAllMocks();
});

describe('Log out', () => {
  it('ends this device only, never every device, and only after the confirm', async () => {
    const press = (
      section().rows[0]!.control as React.ReactElement<{ onPress: () => Promise<void> }>
    ).props.onPress;
    confirmMock.mockResolvedValueOnce(false);
    await act(async () => press());
    expect(oxy.logout).not.toHaveBeenCalled();
    confirmMock.mockResolvedValueOnce(true);
    await act(async () => press());
    expect(oxy.logout).toHaveBeenCalledTimes(1);
    expect(oxy.logoutAll).not.toHaveBeenCalled();
    expect(confirmMock.mock.calls[1]![0].description).toBe('settings.general.logoutConfirm');
  });
});
