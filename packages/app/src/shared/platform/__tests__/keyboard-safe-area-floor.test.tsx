import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { APP_ROOT } from '@/shared/testing/app-root';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/**
 * The room left under the chat's composer for the gesture bar gives way to the
 * keyboard, which covers the gesture bar. It stayed, and on a Pixel 8a the
 * composer floated a gesture bar's height above the keyboard with the
 * transcript showing through the gap (`docs/native-validation.mdx`).
 *
 * The keyboard's progress is a shared value; the stub's `useAnimatedStyle`
 * runs the worklet once per render, which is all a test can see of it.
 */

const keyboard = vi.hoisted(() => ({ progress: { value: 0 } }));

vi.mock('react-native-keyboard-controller', () => ({
  useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: keyboard.progress }),
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: (props: Record<string, unknown>) => ReactModule.createElement('AnimatedView', props),
    },
    useAnimatedStyle: (worklet: () => Record<string, unknown>) => worklet(),
  };
});

import { KeyboardSafeAreaFloor } from '../keyboard.native';

function heightAt(progress: number): unknown {
  keyboard.progress.value = progress;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<KeyboardSafeAreaFloor inset={63} />);
  });
  const height = (renderer.root.findByType('AnimatedView' as any).props.style as { height: number }).height;
  act(() => renderer.unmount());
  return height;
}

describe('KeyboardSafeAreaFloor (native)', () => {
  it('keeps the whole inset while the keyboard is down', () => {
    expect(heightAt(0)).toBe(63);
  });

  it('gives all of it up once the keyboard is up, which covers the gesture bar', () => {
    expect(heightAt(1)).toBe(0);
  });

  it('follows the keyboard in between', () => {
    expect(heightAt(0.5)).toBeCloseTo(31.5);
  });

  it("is what the chat's composer stands on, not a fixed spacer", () => {
    const page = readFileSync(join(APP_ROOT, 'src/features/chat/ui/chat-page-content.tsx'), 'utf8');
    expect(page).toMatch(/<KeyboardSafeAreaFloor inset=\{insets\.bottom\} \/>/);
    expect(page).not.toMatch(/<View style=\{\{ height: insets\.bottom \}\} \/>/);
  });
});
