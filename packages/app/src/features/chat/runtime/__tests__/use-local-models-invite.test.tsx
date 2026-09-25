import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The local-models invite, back as a Bloom toast after the template adoption
 * dropped it (#608 §10, "Notificaciones y modelos locales").
 *
 * What it owes, beyond appearing: it never covers "Meet Alia" (§3.2) — not
 * while the intro shows, not for a visitor, and not after a sign-out brings
 * the intro back — it asks once, and each of its two buttons records the
 * answer it names.
 */

const env = vi.hoisted(() => ({
  isAuthenticated: true,
  isLargeScreen: true,
}));

const toastFn = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { dismiss: ReturnType<typeof vi.fn> };
  fn.dismiss = vi.fn();
  return fn;
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: toastFn }));
vi.mock('@oxy.so/services', () => ({ useAuth: () => ({ isAuthenticated: env.isAuthenticated }) }));
vi.mock('@/shared/platform/use-is-large-screen', () => ({ useIsLargeScreen: () => env.isLargeScreen }));
vi.mock('@/shared/i18n/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { LOCAL_MODELS_INVITE_TOAST_ID, useLocalModelsInvite } from '@/features/chat/runtime/use-local-models-invite';
import { useLocalRuntimeStore } from '@/features/local-models/runtime/local-runtime-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ enabled }: { enabled: boolean }) {
  useLocalModelsInvite(enabled);
  return null;
}

const renderers: ReactTestRenderer[] = [];
async function mount(enabled: boolean): Promise<ReactTestRenderer> {
  let r: ReactTestRenderer | null = null;
  await act(async () => {
    r = create(<Probe enabled={enabled} />);
  });
  renderers.push(r!);
  return r!;
}

/** The options the invite was shown with. */
const shown = () => toastFn.mock.calls.map((call) => call[1] as Record<string, any>);

beforeEach(async () => {
  env.isAuthenticated = true;
  env.isLargeScreen = true;
  toastFn.mockClear();
  toastFn.dismiss.mockClear();
  await useLocalRuntimeStore.persist.rehydrate();
  useLocalRuntimeStore.setState({ consent: 'unasked', inviteSeen: false });
});

afterEach(async () => {
  for (const r of renderers.splice(0)) await act(async () => r.unmount());
});

describe('the local-models invite', () => {
  it('asks once, as a toast that waits for an answer', async () => {
    await mount(true);
    expect(toastFn).toHaveBeenCalledOnce();
    expect(toastFn.mock.calls[0][0]).toBe('models.localInvite.title');
    expect(shown()[0]).toMatchObject({
      id: LOCAL_MODELS_INVITE_TOAST_ID,
      description: 'models.localInvite.body',
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'models.localInvite.accept' },
      cancel: { label: 'models.localInvite.decline' },
    });
    // The asking is recorded; the answer is not invented.
    expect(useLocalRuntimeStore.getState()).toMatchObject({ inviteSeen: true, consent: 'unasked' });

    // A second mounted chat does not ask again.
    await mount(true);
    expect(toastFn).toHaveBeenCalledOnce();
  });

  it('never appears over the welcome, nor for a visitor, nor on a phone', async () => {
    await mount(false);
    env.isAuthenticated = false;
    await mount(true);
    env.isAuthenticated = true;
    env.isLargeScreen = false;
    await mount(true);
    expect(toastFn).not.toHaveBeenCalled();
    expect(useLocalRuntimeStore.getState().inviteSeen).toBe(false);
  });

  it('waits for the chat: shown once the welcome gives way to it', async () => {
    const r = await mount(false);
    expect(toastFn).not.toHaveBeenCalled();
    await act(async () => r.update(<Probe enabled />));
    expect(toastFn).toHaveBeenCalledOnce();
  });

  it('is taken back when the welcome returns over it', async () => {
    const r = await mount(true);
    expect(toastFn).toHaveBeenCalledOnce();
    await act(async () => r.update(<Probe enabled={false} />));
    expect(toastFn.dismiss).toHaveBeenCalledWith(LOCAL_MODELS_INVITE_TOAST_ID);
  });

  it('records exactly the answer each button names', async () => {
    await mount(true);
    act(() => shown()[0].action.onClick());
    expect(useLocalRuntimeStore.getState().consent).toBe('granted');
    expect(toastFn.dismiss).toHaveBeenCalledWith(LOCAL_MODELS_INVITE_TOAST_ID);

    act(() => shown()[0].cancel.onClick());
    expect(useLocalRuntimeStore.getState().consent).toBe('declined');
  });

  it('is not asked again once answered or already asked', async () => {
    useLocalRuntimeStore.setState({ inviteSeen: true });
    await mount(true);
    useLocalRuntimeStore.setState({ inviteSeen: false, consent: 'declined' });
    await mount(true);
    expect(toastFn).not.toHaveBeenCalled();
  });
});
