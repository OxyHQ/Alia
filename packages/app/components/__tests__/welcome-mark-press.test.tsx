import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tapping Alia's mark on the welcome greeting spins it.
 *
 * A small thing, and one that went missing without a single test going red: the
 * mark used to mount a `Pressable` unconditionally, that was narrowed to
 * "only when it has an `onPress`" so a mark drawn as an agent's face could stop
 * swallowing the tap meant for the row it sits in, and the welcome — which had
 * no `onPress`, because the spin WAS the whole of what its tap did — silently
 * stopped being pressable.
 *
 * So what is pinned here is the outcome, not the prop. The mark rendered is the
 * REAL one, and the assertion is that pressing what the welcome puts on screen
 * reaches its flourish: `spinOnPress` forwarded to a component that had stopped
 * honouring it would keep a prop-shaped assertion green.
 */

const mocks = vi.hoisted(() => ({
  impactAsync: vi.fn(() => Promise.resolve()),
}));

/**
 * Only the barrel is stood in for, and only to narrow it: `src/index.ts` reaches
 * the whole chat UI tree — every markdown, storage and native module it touches
 * would have to be mocked here, and none of them is what this test is about.
 * What it hands back is the REAL component, loaded from the real file.
 */
vi.mock('@alia.onl/sdk', async () => {
  const real = await import('../../../alia-chat/src/components/IdentityMark');
  return { IdentityMark: real.IdentityMark };
});

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Pressable: host('Pressable') };
});

vi.mock('expo-haptics', () => ({
  impactAsync: mocks.impactAsync,
  ImpactFeedbackStyle: { Light: 'light' },
}));

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { default: host('Svg'), Path: host('Path') };
});

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const Animated = {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('AnimatedView', props, children),
  };
  return {
    default: Animated,
    useAnimatedReaction: () => undefined,
    useAnimatedStyle: (factory: () => Record<string, unknown>) => factory(),
    useSharedValue: <T,>(initial: T) => ReactModule.useRef({ value: initial }).current,
    withTiming: <T,>(value: T) => value,
    withRepeat: <T,>(value: T) => value,
    withSequence: <T,>(value: T) => value,
    cancelAnimation: () => undefined,
    Easing: { linear: () => 0, bezier: () => () => 0 },
  };
});

vi.mock('@oxyhq/services', () => ({
  useAuth: () => ({ user: { name: { displayName: 'Nate' } }, isAuthenticated: true }),
}));

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { primary: 'rgb(210 105 230)' } }),
}));

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { IdentityMark } from '../../../alia-chat/src/components/IdentityMark';
import { WelcomeMessage } from '../welcome-message';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Typed as `string`, not as the literal, so `node.type ===` is a comparison
 *  rather than a type error against `ElementType`. */
const HOST_PRESSABLE: string = 'Pressable';

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(element);
  });
  if (next === undefined) throw new Error('nothing rendered');
  renderer = next;
  return next;
}

function pressables(r: ReactTestRenderer) {
  return r.root.findAll((node) => node.type === HOST_PRESSABLE);
}

beforeEach(() => {
  mocks.impactAsync.mockClear();
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the mark on the welcome greeting', () => {
  it('offers something to press', () => {
    // The greeting itself is not a control, so the only press target the
    // welcome puts on screen is the mark.
    expect(pressables(render(<WelcomeMessage />))).toHaveLength(1);
  });

  it('runs the flourish when it is pressed', () => {
    const r = render(<WelcomeMessage />);

    act(() => pressables(r)[0]?.props.onPress());

    // The haptic is the observable half of the flourish and it is fired by the
    // mark's own handler — so this is reached only if the press actually
    // arrived there, rather than a prop having been handed over.
    expect(mocks.impactAsync).toHaveBeenCalledOnce();
  });

  it('is not announced as a button, because the press promises no action', () => {
    // Pressable, but there is nowhere for it to take you. Same role it carried
    // before the press target was made opt-in.
    expect(pressables(render(<WelcomeMessage />))[0]?.props.accessibilityRole).toBe('image');
  });
});

describe('a mark that asked for nothing', () => {
  /**
   * The other half of the same decision, and the reason the welcome has to ask
   * out loud. An agent's face is drawn inside a row that is itself pressable;
   * a mark that took the touch on its own would stop that row from opening.
   */
  it('takes no touch at all', () => {
    const r = render(<IdentityMark size={28} color="rgb(255 0 0)" />);

    expect(pressables(r)).toHaveLength(0);
  });

  it('still spins on press once it asks', () => {
    const r = render(<IdentityMark size={28} color="rgb(255 0 0)" spinOnPress />);

    act(() => pressables(r)[0]?.props.onPress());

    expect(mocks.impactAsync).toHaveBeenCalledOnce();
  });
});
