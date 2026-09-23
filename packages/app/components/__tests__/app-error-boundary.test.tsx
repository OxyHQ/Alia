import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The app's crash screen is Bloom's `ErrorBoundary` with Alia's reporting.
 *
 * What must survive the move off the hand-rolled class: the default screen says what happened in words from the
 * catalogue (never the error's own message), its button retries, and a caller's
 * `fallback` still receives `error` and `resetError`.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    StyleSheet: { create: <T,>(styles: T) => styles },
  };
});

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));

/** The screen and the empty state, reduced to what they say and do. */
vi.mock('@oxy.so/bloom/screen', async () => {
  const ReactModule = await import('react');
  return {
    Screen: ({ children }: React.PropsWithChildren) => ReactModule.createElement('Screen', null, children),
  };
});
vi.mock('@oxy.so/bloom/empty-state', async () => {
  const ReactModule = await import('react');
  return {
    EmptyState: (props: {
      title?: string;
      description?: string;
      action?: { label: string; onPress?: () => void };
    }) => ReactModule.createElement('EmptyState', props),
  };
});
vi.mock('@oxy.so/bloom/icons/RiErrorWarningLine', () => ({ RiErrorWarningLine: () => null }));

import { AppErrorBoundary } from '../error-boundary';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | undefined;
let shouldThrow = true;

function Flaky() {
  if (shouldThrow) throw new Error('internal: row 42 missing');
  return React.createElement('Recovered');
}

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  shouldThrow = true;
  vi.restoreAllMocks();
});

describe('AppErrorBoundary', () => {
  it('shows the catalogue\'s words, not the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderer = create(
        <AppErrorBoundary>
          <Flaky />
        </AppErrorBoundary>,
      );
    });
    const empty = renderer!.root.findByType('EmptyState' as unknown as React.ElementType);
    expect(empty.props.title).toBe('dialogs.errorBoundary.title');
    expect(empty.props.description).toBe('dialogs.errorBoundary.message');
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('row 42');
  });

  it('retries into the children once they render', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      renderer = create(
        <AppErrorBoundary>
          <Flaky />
        </AppErrorBoundary>,
      );
    });
    shouldThrow = false;
    const empty = renderer!.root.findByType('EmptyState' as unknown as React.ElementType);
    await act(async () => {
      empty.props.action.onPress();
    });
    expect(renderer!.root.findAllByType('Recovered' as unknown as React.ElementType)).toHaveLength(1);
  });

  it('hands a caller\'s fallback the error and a reset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: { error?: Error; resetError?: () => void } = {};
    function Fallback({ error, resetError }: { error: Error; resetError: () => void }) {
      seen.error = error;
      seen.resetError = resetError;
      return React.createElement('Custom');
    }
    await act(async () => {
      renderer = create(
        <AppErrorBoundary fallback={Fallback}>
          <Flaky />
        </AppErrorBoundary>,
      );
    });
    expect(renderer!.root.findAllByType('Custom' as unknown as React.ElementType)).toHaveLength(1);
    expect(seen.error?.message).toContain('row 42');
    shouldThrow = false;
    await act(async () => {
      seen.resetError?.();
    });
    expect(renderer!.root.findAllByType('Recovered' as unknown as React.ElementType)).toHaveLength(1);
  });
});
