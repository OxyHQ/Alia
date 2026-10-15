import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A failed turn is told with a toast. Pinned: which line it says (interrupted vs. couldn't
 * answer), that Retry is offered exactly when the server allowed one and calls back, that the
 * server's words go under the line, and that the toast leaves with the turn.
 */

const toastMock = vi.hoisted(() => ({ error: vi.fn(), dismiss: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: toastMock }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { FAILED_TURN_TOAST_ID, useFailedTurnToast } from '@/features/chat/ui/failed-turn-toast';
import type { FailedTurn } from '@alia.onl/sdk/runtime';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const turn = (patch: Partial<FailedTurn> = {}): FailedTurn =>
  ({ anchorMessageId: 'm1', partial: false, retryable: true, ...patch }) as FailedTurn;

let renderer: ReactTestRenderer | null = null;

function Probe({ failed, onRetry }: { failed: FailedTurn | null; onRetry?: () => void }) {
  useFailedTurnToast(failed, onRetry);
  return null;
}

function mount(failed: FailedTurn | null, onRetry?: () => void) {
  act(() => {
    renderer = create(<Probe failed={failed} onRetry={onRetry} />);
  });
  return renderer!;
}

beforeEach(() => {
  toastMock.error.mockClear();
  toastMock.dismiss.mockClear();
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
});

describe('useFailedTurnToast', () => {
  it('says Alia could not answer, with Retry as the action', () => {
    const onRetry = vi.fn();
    mount(turn(), onRetry);

    const [title, options] = toastMock.error.mock.calls[0]!;
    expect(title).toBe('chat.turnFailed chat.turnFailedRetryHint');
    expect(options).toMatchObject({ id: FAILED_TURN_TOAST_ID, action: { label: 'chat.retry' } });
    options.action.onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says the answer was interrupted when real output came first', () => {
    mount(turn({ partial: true }), () => {});
    expect(toastMock.error.mock.calls[0]![0]).toContain('chat.turnInterrupted');
  });

  it('offers no Retry when the server said not to, or no handler is given, and drops the hint', () => {
    mount(turn({ retryable: false }), () => {});
    expect(toastMock.error.mock.calls[0]![0]).toBe('chat.turnFailed');
    expect(toastMock.error.mock.calls[0]![1].action).toBeUndefined();
    act(() => renderer?.unmount());
    renderer = null;

    toastMock.error.mockClear();
    mount(turn());
    expect(toastMock.error.mock.calls[0]![1].action).toBeUndefined();
  });

  it('puts the server’s own words under the line', () => {
    mount(turn({ detail: 'Server error (503)' }), () => {});
    expect(toastMock.error.mock.calls[0]![1].description).toBe('Server error (503)');
  });

  it('shows nothing without a failure, and leaves with the turn', () => {
    const r = mount(null);
    expect(toastMock.error).not.toHaveBeenCalled();
    act(() => r.update(<Probe failed={turn()} onRetry={() => {}} />));
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    act(() => r.update(<Probe failed={null} />));
    expect(toastMock.dismiss).toHaveBeenCalledWith(FAILED_TURN_TOAST_ID);
  });
});
