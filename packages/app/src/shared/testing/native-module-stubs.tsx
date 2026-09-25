import React from 'react';

/**
 * The native modules under Bloom, for a suite that mounts Bloom itself.
 *
 * `vitest.config.ts` inlines Bloom so its components can be mounted for real,
 * but what Bloom stands on cannot be: React Native, Reanimated, SVG, Gesture
 * Handler and Screens publish Flow or need their native halves, and die at
 * import. Each is replaced here by the smallest thing that renders — host
 * elements named after the component and carrying its props, animations that
 * land at once — so what a suite reads off the tree is what Bloom decided.
 *
 * Used from `vi.mock` factories via `await import('./native-module-stubs')`.
 */

type Props = React.PropsWithChildren<Record<string, unknown>>;

const host =
  (name: string) =>
  ({ children, ...props }: Props) =>
    React.createElement(name, props, children as React.ReactNode);

/** Just the children: a provider or a wrapper with nothing of its own to show. */
const through = ({ children }: Props) => React.createElement(React.Fragment, null, children as React.ReactNode);

const subscription = { remove() {} };

/** `react-native`, on the platform `platform.OS` names when a component asks. */
export function reactNativeModule(platform: { OS: string }) {
  return {
    View: host('View'),
    Text: host('RNText'),
    Image: host('Image'),
    Modal: ({ visible, children, ...props }: Props) =>
      visible === false ? null : React.createElement('Modal', props, children as React.ReactNode),
    TextInput: host('TextInput'),
    ScrollView: host('ScrollView'),
    // A render-prop child is called as React Native calls it, at rest.
    Pressable: ({ children, ...props }: Props) =>
      React.createElement(
        'Pressable',
        props,
        typeof children === 'function'
          ? (children as (state: object) => React.ReactNode)({ pressed: false, hovered: false, focused: false })
          : (children as React.ReactNode),
      ),
    Platform: {
      get OS() {
        return platform.OS;
      },
      select: (options: Record<string, unknown>) => options[platform.OS] ?? options.native ?? options.default,
    },
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      flatten: (style: unknown) =>
        Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : (style ?? {}),
      hairlineWidth: 1,
      absoluteFill: {},
      absoluteFillObject: {},
    },
    Dimensions: { get: () => ({ width: 1200, height: 800 }), addEventListener: () => subscription },
    useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
    useColorScheme: () => 'light',
    Appearance: { getColorScheme: () => 'light', setColorScheme: () => {}, addChangeListener: () => subscription },
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => true,
      addEventListener: () => subscription,
      announceForAccessibility: () => {},
    },
    I18nManager: { isRTL: false },
    Keyboard: { addListener: () => subscription, dismiss: () => {} },
    BackHandler: { addEventListener: () => subscription },
    Animated: {
      View: host('View'),
      Value: class {
        constructor(public value: number) {}
        setValue() {}
        interpolate() {
          return 0;
        }
      },
      timing: () => ({ start: (done?: () => void) => done?.() }),
    },
    Easing: new Proxy({}, { get: () => (x: unknown) => x }),
  };
}

/** Reanimated with every animation already at its end, as under reduced motion. */
export function reanimatedModule() {
  const animated = {
    View: host('View'),
    Text: host('RNText'),
    ScrollView: host('ScrollView'),
    createAnimatedComponent: <T,>(component: T) => component,
  };
  // `FadeIn.duration(120).delay(40)` and the like: any chain, to itself.
  const builder: object = new Proxy(function builder() {}, {
    get: () => () => builder,
    apply: () => builder,
  });
  return {
    default: animated,
    ...animated,
    useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
    useAnimatedStyle: (style: () => unknown) => style(),
    useAnimatedProps: (props: () => unknown) => props(),
    useDerivedValue: (value: () => unknown) => ({ value: value() }),
    useReducedMotion: () => true,
    useFrameCallback: () => ({ setActive() {} }),
    useAnimatedReaction: () => {},
    useAnimatedRef: () => React.useRef(null),
    useAnimatedScrollHandler: () => () => {},
    useScrollViewOffset: () => ({ value: 0 }),
    scrollTo: () => {},
    measure: () => null,
    withTiming: <T,>(value: T) => value,
    withSpring: <T,>(value: T) => value,
    withDelay: <T,>(_delay: number, value: T) => value,
    withSequence: (...values: unknown[]) => values[values.length - 1],
    withRepeat: <T,>(value: T) => value,
    cancelAnimation: () => {},
    runOnJS: <T,>(fn: T) => fn,
    runOnUI: <T,>(fn: T) => fn,
    makeMutable: <T,>(value: T) => ({ value }),
    interpolate: (value: number) => value,
    interpolateColor: () => 'transparent',
    Easing: new Proxy({}, { get: () => (x: unknown) => x }),
    Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    FadeIn: builder,
    FadeOut: builder,
    SlideInLeft: builder,
    SlideInRight: builder,
    LinearTransition: builder,
    Keyframe: class {
      duration() {
        return this;
      }
    },
  };
}

export function svgModule() {
  const Svg = host('Svg');
  return {
    default: Svg,
    Svg,
    Path: host('Path'),
    G: host('G'),
    Circle: host('Circle'),
    Rect: host('Rect'),
    Defs: host('Defs'),
    LinearGradient: host('LinearGradient'),
    Stop: host('Stop'),
  };
}

export function gestureHandlerModule() {
  const gesture: object = new Proxy({}, { get: () => () => gesture });
  return {
    GestureDetector: through,
    GestureHandlerRootView: through,
    Gesture: new Proxy({}, { get: () => () => gesture }),
    ScrollView: host('ScrollView'),
  };
}

export const screensModule = () => ({ FullWindowOverlay: through, enableScreens: () => {} });

export const safeAreaModule = () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: through,
  SafeAreaProvider: through,
});

export const blurModule = () => ({ BlurView: host('BlurView') });
