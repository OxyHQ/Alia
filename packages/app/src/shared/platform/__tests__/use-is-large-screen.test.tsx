import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/** `md` (768) is the line: logic branches on it, and only a crossing re-renders. */

vi.mock('react-native', async () =>
  (await import('@/shared/testing/native-module-stubs')).reactNativeModule({ OS: 'ios' }),
);

import { Dimensions } from 'react-native';
import { useIsLargeScreen } from '@/shared/platform/use-is-large-screen';

function read(width: number): boolean {
  vi.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 1, fontScale: 1 });
  let value: boolean | null = null;
  function Probe() {
    value = useIsLargeScreen();
    return null;
  }
  act(() => {
    create(React.createElement(Probe));
  });
  return value as unknown as boolean;
}

describe('useIsLargeScreen', () => {
  it('is false below md and true from md up', () => {
    expect(read(767)).toBe(false);
    expect(read(768)).toBe(true);
    expect(read(1440)).toBe(true);
  });
});
