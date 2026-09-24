import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The four guarantees Alia moved onto Bloom, checked against the real panel.
 *
 * This file replaces three that went with the old composer —
 * `components/__tests__/prompt-input-stop.test.tsx`,
 * `prompt-input/__tests__/textarea-ime.test.tsx` and
 * `prompt-input/__tests__/working-light.test.tsx` — and it replaces them
 * rather than reproducing them, because what they pinned was Alia's own
 * implementation of behaviour that is now Bloom's. Re-asserting a
 * reimplementation nobody ships would measure nothing.
 *
 * What is still Alia's, and so still worth pinning, is which of Bloom's
 * contracts the composer RELIES ON. Each of these was a reason the first
 * attempt at this adoption stopped:
 *
 *  1. **Stop outlives `disabled`.** Every other control locks while a turn is
 *     in flight; the one whose job is to end that turn must not. The old
 *     composer had to fight its own DOM for this — a `disabled` on the wrapper
 *     put `aria-disabled` on the element around everything, so for the length
 *     of a stream the textbox, the add menu, the model chip AND the stop
 *     button all read as unusable. Bloom states it as a contract instead.
 *  2. **Shift+Enter breaks the line, and an input method's Enter is left
 *     alone.** The IME clause is why `lib/chat/composer-state.ts#imeOwnsEnter`
 *     existed; Bloom's own rule asks the same question of the same field
 *     (`native.isComposing`), so Alia's copy went and this is what proves the
 *     original is what runs.
 *  3. **`onKeyPress` runs BEFORE the Enter rule and a defaulted event stops
 *     there.** Without it the suggestion list is a list the keyboard cannot
 *     reach.
 *  4. **`emptyAction` stands where send would, and a stop beats it.** Alia's
 *     voice-call button lives in that slot, and a turn in flight is the one
 *     thing a person has to be able to reach.
 *
 * The panel is MOUNTED, not stubbed. `vitest.config.ts` inlines
 * `@oxy.so/bloom` for exactly this: an adoption proven against a stub is a
 * test of the stub.
 */

/**
 * react-native as host elements.
 *
 * Bloom's panel reaches for rather more of it than most components here do —
 * `useWindowDimensions` decides the placeholder, `TextInput` is the field, and
 * `Pressable` is every control — so the shim is wider than the usual two
 * entries and every one of them is something the panel actually calls.
 */
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  const Pressable = ReactModule.forwardRef(
    (
      { children, ...props }: React.PropsWithChildren<Record<string, unknown>>,
      ref: React.Ref<unknown>,
    ) => ReactModule.createElement('Pressable', { ...props, ref }, children),
  );
  const TextInput = ReactModule.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<unknown>) =>
      ReactModule.createElement('TextInput', { ...props, ref }),
  );
  return {
    View: host('View'),
    Text: host('RNText'),
    Pressable,
    TextInput,
    ScrollView: host('ScrollView'),
    ActivityIndicator: host('ActivityIndicator'),
    // Bloom's `styled-primitives` wraps this whole family, so every one of
    // them has to exist even though the panel draws none of them.
    Image: host('Image'),
    ImageBackground: host('ImageBackground'),
    FlatList: host('FlatList'),
    SectionList: host('SectionList'),
    Switch: host('Switch'),
    Modal: host('Modal'),
    SafeAreaView: host('SafeAreaView'),
    TouchableOpacity: host('TouchableOpacity'),
    TouchableHighlight: host('TouchableHighlight'),
    TouchableWithoutFeedback: host('TouchableWithoutFeedback'),
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    /*
     * react-native's OWN `Animated`, which is a different library from the
     * reanimated mocked below and is reached by a different Bloom component:
     * the model menu's `RadioIndicator` drives its tick from an
     * `Animated.Value` and reads `.interpolate` off it. A bare class was
     * enough to import and not enough to render, which is the failure mode a
     * stub has and a real component does not.
     */
    Animated: {
      View: host('View'),
      Text: host('RNText'),
      Value: function AnimatedValue(this: Record<string, unknown>, initial: number) {
        this.value = initial;
        this.interpolate = () => ({ value: initial, interpolate: () => ({}) });
        this.setValue = () => {};
        this.addListener = () => '0';
        this.removeAllListeners = () => {};
      } as unknown as new (value: number) => unknown,
      timing: () => ({ start: () => {} }),
      spring: () => ({ start: () => {} }),
    },
    Dimensions: { get: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }), addEventListener: () => ({ remove: () => {} }) },
    PixelRatio: { get: () => 1, getFontScale: () => 1, roundToNearestPixel: (n: number) => n },
    I18nManager: { isRTL: false },
    Appearance: { getColorScheme: () => 'light', addChangeListener: () => ({ remove: () => {} }) },
    useColorScheme: () => 'light',
    findNodeHandle: () => null,
    UIManager: { measure: () => {} },
    InteractionManager: { runAfterInteractions: (fn: () => void) => { fn(); return { cancel: () => {} }; } },
    Keyboard: { dismiss: () => {}, addListener: () => ({ remove: () => {} }) },
    AccessibilityInfo: { isReduceMotionEnabled: async () => true, addEventListener: () => ({ remove: () => {} }) },
    // The panel asks below 640 for a shorter placeholder. A desktop width keeps
    // the full one, which is the string this file names.
    useWindowDimensions: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      flatten: (style: unknown) => style,
      absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    },
  };
});

/**
 * Reanimated, as the identity it would be with motion turned off.
 *
 * The panel animates a chevron, a glass chip's fade and the effort thumb.
 * None of those is what this file is about, and the real library needs a
 * native module and a frame clock to say so.
 */
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const { View } = await import('react-native');
  return {
    default: { View },
    Easing: { bezier: () => () => 0, linear: () => 0 },
    /*
     * Stable across renders, via a ref, and that is not a detail.
     *
     * A shared value is an identity the real library keeps for the life of
     * the component, and Bloom's popover puts one in an effect's dependency
     * list. Returning a fresh object per render makes that effect run on
     * every render, and the effect calls `setAnchor` — so the menu re-renders
     * forever and the worker dies with no stack to point at. It cost a
     * 45-second timeout to find, which is the argument for mocking a library
     * by its CONTRACT rather than by its shape.
     */
    useSharedValue: (initial: unknown) => ReactModule.useRef({ value: initial }).current,
    useAnimatedStyle: () => ({}),
    useDerivedValue: (fn: () => unknown) => ReactModule.useRef({ value: fn() }).current,
    useReducedMotion: () => true,
    withTiming: (value: unknown) => value,
    withSpring: (value: unknown) => value,
    runOnJS: (fn: unknown) => fn,
    interpolate: () => 0,
    useAnimatedReaction: () => {},
    createAnimatedComponent: (Component: React.ComponentType) => Component,
    __esModule: true,
  };
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  const Svg = host('Svg');
  return {
    default: Svg,
    Svg,
    Path: host('Path'),
    G: host('G'),
    Rect: host('Rect'),
    Defs: host('Defs'),
    LinearGradient: host('SvgLinearGradient'),
    Stop: host('Stop'),
    ClipPath: host('ClipPath'),
    Circle: host('Circle'),
    __esModule: true,
  };
});

import { ComposerPanel } from '@oxy.so/bloom/composer-panel';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

/**
 * The provider is real too.
 *
 * `useTheme` throws outside one by design — a Bloom control with no theme has
 * no colours to be drawn in — so a stub here would be inventing the palette
 * the component under test reads. `awaitHydration={false}` is the one thing
 * asked of it: the real provider otherwise waits on persisted storage this
 * runner does not have, and renders nothing while it waits.
 */
function mount(props: Partial<React.ComponentProps<typeof ComposerPanel>>) {
  let next: ReactTestRenderer | undefined;
  act(() => {
    next = create(
      <BloomThemeProvider defaultMode="light" awaitHydration={false}>
        <ComposerPanel {...props} />
      </BloomThemeProvider>,
    );
  });
  if (next === undefined) throw new Error('the panel did not render');
  renderer = next;
  return next;
}

/** The field, which is the only `TextInput` the panel mounts. */
function field(r: ReactTestRenderer): ReactTestInstance {
  return r.root.findAllByType('TextInput' as never)[0];
}

/** A key event shaped the way react-native-web forwards one. */
function key(
  name: string,
  over: Record<string, unknown> = {},
): { nativeEvent: Record<string, unknown>; preventDefault: () => void; defaultPrevented: boolean } {
  const event = {
    nativeEvent: { key: name, shiftKey: false, isComposing: false, ...over },
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
}

describe('the panel Alia sends with', () => {
  it('sends on Enter', () => {
    const onSubmit = vi.fn();
    const r = mount({ value: 'hola', onSubmit });
    act(() => field(r).props.onKeyPress(key('Enter')));
    expect(onSubmit).toHaveBeenCalledWith('hola');
  });

  it('breaks the line on Shift+Enter instead of sending', () => {
    const onSubmit = vi.fn();
    const r = mount({ value: 'hola', onSubmit });
    const event = key('Enter', { shiftKey: true });
    act(() => field(r).props.onKeyPress(event));
    expect(onSubmit).not.toHaveBeenCalled();
    // And the key is NOT taken, so the field puts the newline in.
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves an input method’s Enter alone', () => {
    // The first Enter of a Japanese, Chinese or Korean sentence confirms the
    // candidate the IME is offering. Under a rule that asks only about shift,
    // the half-written message was sent and the confirmed word landed in the
    // empty composer behind it.
    const onSubmit = vi.fn();
    const r = mount({ value: 'にほんご', onSubmit });
    act(() => field(r).props.onKeyPress(key('Enter', { isComposing: true })));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('is a multiline field, so a draft can be a paragraph', () => {
    const r = mount({ value: 'hola' });
    expect(field(r).props.multiline).toBe(true);
  });
});

describe('the host sees the keys first', () => {
  it('offers every key to onKeyPress before deciding Enter', () => {
    const onKeyPress = vi.fn();
    const r = mount({ value: 'hola', onKeyPress });
    act(() => field(r).props.onKeyPress(key('ArrowDown')));
    expect(onKeyPress).toHaveBeenCalledTimes(1);
  });

  it('gives up Enter to a host that takes it', () => {
    // This is the suggestion list winning Enter: `preventDefault()` in the
    // host's handler stops the composer acting on the same key, which is the
    // only ordering under which a list over the composer is reachable by
    // keyboard at all.
    const onSubmit = vi.fn();
    const r = mount({
      value: 'hola',
      onSubmit,
      onKeyPress: (event: { preventDefault: () => void }) => event.preventDefault(),
    });
    act(() => field(r).props.onKeyPress(key('Enter')));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('stop, and what it outlives', () => {
  /** Every control the panel exposes a name for. */
  function named(r: ReactTestRenderer): Record<string, ReactTestInstance> {
    const byName: Record<string, ReactTestInstance> = {};
    for (const node of r.root.findAllByType('Pressable' as never)) {
      const label = node.props.accessibilityLabel;
      if (typeof label === 'string') byName[label] = node;
    }
    return byName;
  }

  it('offers stop instead of send while a turn is in flight', () => {
    const r = mount({ value: 'hola', busy: true, onStop: () => {} });
    expect(named(r)['Stop generating']).toBeDefined();
    expect(named(r)['Send message']).toBeUndefined();
  });

  it('keeps stop live while `disabled` locks the rest of the composer', () => {
    // The whole reason this adoption was possible. `disabled` is the usage
    // limit and the empty draft; it greys send and it must never reach the
    // control that ends the stream.
    const onStop = vi.fn();
    const r = mount({ value: '', busy: true, disabled: true, onStop });
    const stop = named(r)['Stop generating'];
    expect(stop).toBeDefined();
    expect(stop.props.disabled).not.toBe(true);
    act(() => stop.props.onPress());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('draws no stop at all without a handler, so the control is never inert', () => {
    const r = mount({ value: 'hola', busy: true });
    expect(named(r)['Stop generating']).toBeUndefined();
  });
});

describe('the empty slot, where the call button stands', () => {
  function hasHost(r: ReactTestRenderer, name: string): boolean {
    return r.root.findAllByType(name as never).length > 0;
  }

  it('draws the empty action where send would be, on an empty draft', () => {
    const r = mount({
      value: '',
      emptyAction: React.createElement('VoiceCall'),
    });
    expect(hasHost(r, 'VoiceCall')).toBe(true);
  });

  it('gives the slot back to send as soon as there is something to send', () => {
    const r = mount({
      value: 'hola',
      emptyAction: React.createElement('VoiceCall'),
    });
    expect(hasHost(r, 'VoiceCall')).toBe(false);
  });

  it('lets a stop beat it, because a turn in flight has to be reachable', () => {
    const r = mount({
      value: '',
      busy: true,
      onStop: () => {},
      emptyAction: React.createElement('VoiceCall'),
    });
    expect(hasHost(r, 'VoiceCall')).toBe(false);
  });
});

describe('the model menu keys by id, never by the name it draws', () => {
  it('reports the opaque id of the row that was pressed', () => {
    // `docs/chat-runtime.mdx` requires exact-id equality: a routing profile is
    // chosen by its identifier and by nothing else. The menu draws `name` and
    // reports `id`, and this is the difference being pinned — a lineup keyed
    // on display names would report the label instead.
    const onModelChange = vi.fn();
    const r = mount({
      value: 'hola',
      providers: [
        {
          id: 'publisher:acme',
          name: 'Acme',
          models: [
            { id: 'acme/fast', name: 'Automatic' },
            { id: 'acme/deep', name: 'Deep thinking' },
          ],
        },
      ],
      model: 'acme/fast',
      onModelChange,
      effortLevels: [],
    });
    // The chip names the CHOSEN model, which is the first thing the id
    // contract buys: an id with no row would show as itself.
    const chip = r.root
      .findAllByType('Pressable' as never)
      .find((node) => String(node.props.accessibilityLabel).endsWith(': Automatic'));
    expect(chip).toBeDefined();
    act(() => chip?.props.onPress());

    const rows = r.root
      .findAllByType('Pressable' as never)
      .filter((node) => node.props.accessibilityRole === 'radio');
    // Each row is named by its provider and its model, and reports the id.
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([
      'Acme Automatic',
      'Acme Deep thinking',
    ]);
    act(() => rows[1].props.onPress());
    expect(onModelChange).toHaveBeenCalledWith('acme/deep');
  });
});
