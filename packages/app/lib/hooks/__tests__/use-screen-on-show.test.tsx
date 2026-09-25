import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Native asks the route; web trusts that a mounted page is the focused one,
 * because the router's answer there reads `false` while the page is on show.
 */

const env = vi.hoisted(() => ({ os: 'ios', focused: false }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return env.os;
    },
  },
}));
vi.mock('expo-router', () => ({ useIsFocused: () => env.focused }));

import { useScreenOnShow } from '@/lib/hooks/use-screen-on-show';

function read(): boolean {
  let value: boolean | null = null;
  function Probe() {
    value = useScreenOnShow();
    return null;
  }
  act(() => {
    create(React.createElement(Probe));
  });
  return value!;
}

beforeEach(() => {
  env.os = 'ios';
  env.focused = false;
});

describe('useScreenOnShow', () => {
  it('follows the route\'s focus on native, where a covered screen stays mounted', () => {
    expect(read()).toBe(false);
    env.focused = true;
    expect(read()).toBe(true);
  });

  it('is true on web, where only the focused page is mounted', () => {
    env.os = 'web';
    expect(read()).toBe(true);
  });
});
