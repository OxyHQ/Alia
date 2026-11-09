import type React from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'web' }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    Platform: platform,
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});

const { InertWhen } = await import('../../src/components/InertWhen');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function wrapper(inert: boolean) {
  let r: ReturnType<typeof create> | undefined;
  act(() => {
    r = create(<InertWhen inert={inert}>{null}</InertWhen>);
  });
  return (r as ReturnType<typeof create>).root.findByProps({ testID: 'inert-when' }).props;
}

it('on web is inert and aria-hidden only while something is drawn over it, with no box', () => {
  platform.OS = 'web';
  const open = wrapper(true);
  expect(open.inert).toBe(true);
  expect(open['aria-hidden']).toBe(true);
  expect(open.style).toEqual({ display: 'contents' });
  const closed = wrapper(false);
  expect('inert' in closed).toBe(false);
  expect(closed['aria-hidden']).toBeUndefined();
});

it('on native hides its descendants from the screen reader only while open', () => {
  platform.OS = 'android';
  const open = wrapper(true);
  expect(open.importantForAccessibility).toBe('no-hide-descendants');
  expect(open.accessibilityElementsHidden).toBe(true);
  const closed = wrapper(false);
  expect(closed.importantForAccessibility).toBe('auto');
  expect(closed.accessibilityElementsHidden).toBe(false);
});
