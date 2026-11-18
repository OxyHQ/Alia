import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A supervised account is told the assistant is off for it, instead of landing
 * in a chat that fails on the first message (oxy ADRs 0041 and 0067).
 *
 * Bloom's `EmptyState` is a probe that keeps its props, so what is asserted is
 * what Alia hands it: the words, and an action that opens Supervision.
 */

const state = vi.hoisted(() => ({
  status: undefined as string | undefined,
  hasData: true,
  showBottomSheet: vi.fn(),
  notice: null as null | Record<string, unknown>,
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ showBottomSheet: state.showBottomSheet }),
  useSupervision: () => ({
    data: state.hasData
      ? { self: state.status ? { status: state.status } : null, children: [], invitations: [] }
      : undefined,
  }),
}));
vi.mock('@oxy.so/bloom/empty-state', () => ({
  EmptyState: (props: Record<string, unknown>) => {
    state.notice = props;
    return null;
  },
}));
vi.mock('@oxy.so/bloom/icons/RiLockLine', () => ({ RiLockLine: () => null }));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { SupervisedAccountGate, isSupervisedStatus } from '@/shell/supervised-account-gate';

/** Stands for the whole app under the gate. */
const AppContent = () => null;

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <SupervisedAccountGate>
        <AppContent />
      </SupervisedAccountGate>,
    );
  });
  return tree;
}

const showsApp = (tree: ReactTestRenderer) => tree.root.findAllByType(AppContent).length === 1;

beforeEach(() => {
  state.status = undefined;
  state.hasData = true;
  state.notice = null;
  state.showBottomSheet.mockReset();
});

describe('SupervisedAccountGate', () => {
  it.each(['active', 'orphaned'])(
    'replaces the app with the notice when supervision is %s',
    (status) => {
      state.status = status;
      const tree = render();

      expect(showsApp(tree)).toBe(false);
      expect(tree.root.findByProps({ testID: 'supervised-account-notice' })).toBeTruthy();
      expect(state.notice).toMatchObject({
        title: 'supervised.title',
        description: 'supervised.description',
      });
    },
  );

  it('offers Supervision, where an account awaiting a guardian invites one', () => {
    state.status = 'orphaned';
    render();
    const action = state.notice?.action as { label: string; onPress: () => void };
    expect(action.label).toBe('supervised.openSupervision');
    action.onPress();
    expect(state.showBottomSheet).toHaveBeenCalledWith('Supervision');
  });

  it('shows the app to an account that is not supervised', () => {
    const tree = render();
    expect(showsApp(tree)).toBe(true);
    expect(state.notice).toBeNull();
  });

  it('shows the app once supervision has ended', () => {
    state.status = 'ended';
    expect(showsApp(render())).toBe(true);
  });

  it('shows the app while supervision has not loaded: the refusal is Oxy’s, not this screen’s', () => {
    state.hasData = false;
    expect(showsApp(render())).toBe(true);
  });
});

describe('isSupervisedStatus', () => {
  it('knows the two supervised states and nothing else', () => {
    expect(isSupervisedStatus('active')).toBe(true);
    expect(isSupervisedStatus('orphaned')).toBe(true);
    expect(isSupervisedStatus('ended')).toBe(false);
    expect(isSupervisedStatus('awaiting_review')).toBe(false);
    expect(isSupervisedStatus(undefined)).toBe(false);
    expect(isSupervisedStatus(null)).toBe(false);
  });
});
