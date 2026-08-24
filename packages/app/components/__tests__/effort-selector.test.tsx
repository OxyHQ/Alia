import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: { OS: "web" },
  isLargeScreen: false,
  storedEffort: null as string | null,
  offered: ["instant", "medium", "high", "max"] as string[],
  setReasoningEffort: vi.fn(),
  haptics: vi.fn(),
  useCatalogue: vi.fn(),
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);

  return {
    Platform: mocks.platform,
    Pressable: host("Pressable"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: host("View"),
  };
});

vi.mock("lucide-react-native", async () => {
  const ReactModule = await import("react");
  return {
    ChevronDown: (props: Record<string, unknown>) =>
      ReactModule.createElement("ChevronDown", props),
  };
});

vi.mock("@/components/ui/dropdown-menu", async () => {
  const ReactModule = await import("react");
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);

  return {
    Root: host("DropdownRoot"),
    Trigger: host("DropdownTrigger"),
    Content: host("DropdownContent"),
    CheckboxItem: host("DropdownCheckboxItem"),
    ItemTitle: host("DropdownItemTitle"),
  };
});

vi.mock("@/components/ui/text", async () => {
  const ReactModule = await import("react");
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement("Text", props, children),
  };
});

vi.mock("@/lib/hooks/use-is-large-screen", () => ({
  useIsLargeScreen: () => mocks.isLargeScreen,
}));

const translations: Record<string, string> = {
  "effort.headlinePrefix": "",
  "effort.headlineSuffix": " effort",
  "effort.levels.default": "Default",
  "effort.levels.instant": "Instant",
  "effort.levels.medium": "Medium",
  "effort.levels.high": "High",
  "effort.levels.max": "Extra High",
  "effort.select": "Effort",
};

vi.mock("@/lib/hooks/use-translation", () => ({
  useTranslation: () => ({ t: (key: string) => translations[key] ?? key }),
}));

vi.mock("@/lib/hooks/use-catalogue", () => ({
  EFFORT_LEVELS: ["instant", "medium", "high", "max"],
  resolveSelection: () => ({
    entry: { capabilities: { reasoningLevels: mocks.offered } },
  }),
  useCatalogue: () => {
    mocks.useCatalogue();
    return { data: [{ id: "test/model" }] };
  },
}));

vi.mock("@/lib/stores/model-store", () => ({
  effortFor: (stored: string | null, supported: readonly string[]) =>
    stored !== null && supported.includes(stored) ? stored : null,
  useModelStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      reasoningEffort: mocks.storedEffort,
      setReasoningEffort: mocks.setReasoningEffort,
    }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
}));

vi.mock("@oxyhq/bloom/bottom-sheet", async () => {
  const ReactModule = await import("react");
  return {
    BottomSheet: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement("BottomSheet", props, children),
  };
});

vi.mock("@oxyhq/bloom/hooks", () => ({
  useHaptics: () => mocks.haptics,
}));

type GestureBuilder = {
  kind: "pan" | "tap";
  handlers: Record<string, (...args: Array<Record<string, number>>) => void>;
  enabled: (value: boolean) => GestureBuilder;
  activeOffsetX: (value: number[]) => GestureBuilder;
  failOffsetY: (value: number[]) => GestureBuilder;
  onBegin: (handler: GestureBuilder["handlers"][string]) => GestureBuilder;
  onStart: (handler: GestureBuilder["handlers"][string]) => GestureBuilder;
  onUpdate: (handler: GestureBuilder["handlers"][string]) => GestureBuilder;
  onFinalize: (handler: GestureBuilder["handlers"][string]) => GestureBuilder;
  onEnd: (handler: GestureBuilder["handlers"][string]) => GestureBuilder;
};

vi.mock("react-native-gesture-handler", async () => {
  const ReactModule = await import("react");
  const gesture = (kind: GestureBuilder["kind"]): GestureBuilder => {
    const builder = {} as GestureBuilder;
    Object.assign(builder, {
      kind,
      handlers: {},
      enabled: () => builder,
      activeOffsetX: () => builder,
      failOffsetY: () => builder,
      onBegin: (handler: GestureBuilder["handlers"][string]) => {
        builder.handlers.onBegin = handler;
        return builder;
      },
      onStart: (handler: GestureBuilder["handlers"][string]) => {
        builder.handlers.onStart = handler;
        return builder;
      },
      onUpdate: (handler: GestureBuilder["handlers"][string]) => {
        builder.handlers.onUpdate = handler;
        return builder;
      },
      onFinalize: (handler: GestureBuilder["handlers"][string]) => {
        builder.handlers.onFinalize = handler;
        return builder;
      },
      onEnd: (handler: GestureBuilder["handlers"][string]) => {
        builder.handlers.onEnd = handler;
        return builder;
      },
    } satisfies GestureBuilder);
    return builder;
  };

  return {
    Gesture: {
      Pan: () => gesture("pan"),
      Race: (...gestures: GestureBuilder[]) => ({ kind: "race", gestures }),
      Tap: () => gesture("tap"),
    },
    GestureDetector: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement("GestureDetector", props, children),
  };
});

vi.mock("react-native-reanimated", async () => {
  const ReactModule = await import("react");
  const Animated = {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement("AnimatedView", props, children),
  };

  return {
    default: Animated,
    runOnJS: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useAnimatedReaction: () => undefined,
    useAnimatedStyle: (factory: () => Record<string, unknown>) => factory(),
    useDerivedValue: <T,>(factory: () => T) => ({ get value() { return factory(); } }),
    useSharedValue: <T,>(initial: T) => ReactModule.useRef({ value: initial }).current,
    withSpring: <T,>(value: T) => value,
  };
});

import { EffortSelector } from "../effort-selector";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function renderSelector() {
  let nextRenderer: ReactTestRenderer | undefined;
  act(() => {
    nextRenderer = create(<EffortSelector selectedModel="test/model" />);
  });
  if (nextRenderer === undefined) throw new Error("EffortSelector did not render");
  renderer = nextRenderer;
  return nextRenderer.root;
}

const hosts = (root: ReturnType<typeof renderSelector>, name: string) =>
  root.findAll((node) => node.type === name);

function openNativeSheet() {
  const root = renderSelector();
  const trigger = hosts(root, "Pressable").find((node) => node.props.accessibilityRole === "button");
  expect(trigger).toBeDefined();
  act(() => trigger?.props.onPress());
  return root;
}

beforeEach(() => {
  mocks.platform.OS = "web";
  mocks.isLargeScreen = false;
  mocks.storedEffort = null;
  mocks.offered = ["instant", "medium", "high", "max"];
  mocks.setReasoningEffort.mockReset();
  mocks.haptics.mockReset();
  mocks.useCatalogue.mockReset();
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe("EffortSelector", () => {
  it("keeps the menu on web and on large native screens, sourced from catalogue and Zustand", () => {
    let root = renderSelector();
    expect(hosts(root, "DropdownRoot")).toHaveLength(1);
    expect(hosts(root, "BottomSheet")).toHaveLength(0);
    expect(mocks.useCatalogue).toHaveBeenCalledOnce();

    const webItems = hosts(root, "DropdownCheckboxItem");
    expect(webItems).toHaveLength(4);
    act(() => webItems[1].props.onValueChange());
    expect(mocks.setReasoningEffort).toHaveBeenCalledWith("medium");

    act(() => renderer?.unmount());
    renderer = null;
    mocks.platform.OS = "android";
    mocks.isLargeScreen = true;
    root = renderSelector();
    expect(hosts(root, "DropdownRoot")).toHaveLength(1);
    expect(hosts(root, "BottomSheet")).toHaveLength(0);
  });

  it("renders the sheet only on a small native screen and exposes offered a11y steps", () => {
    mocks.platform.OS = "android";
    mocks.offered = ["instant", "high"];
    const root = openNativeSheet();

    expect(hosts(root, "DropdownRoot")).toHaveLength(0);
    expect(hosts(root, "BottomSheet")).toHaveLength(1);

    const slider = root.find((node) => node.props.accessibilityRole === "adjustable");
    expect(slider.props.accessibilityValue).toEqual({
      min: 0,
      max: 3,
      now: 1,
      text: "Default",
    });
    expect(slider.props.accessibilityState).toEqual({ disabled: false });

    act(() => slider.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
    act(() => slider.props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } }));
    expect(mocks.setReasoningEffort.mock.calls).toEqual([["high"], ["instant"]]);
    expect(mocks.haptics).toHaveBeenCalledTimes(2);
  });

  it("disables a slider with no offered levels", () => {
    mocks.platform.OS = "ios";
    mocks.offered = [];
    const root = openNativeSheet();
    const slider = root.find((node) => node.props.accessibilityRole === "adjustable");

    expect(slider.props.accessibilityState).toEqual({ disabled: true });
    act(() => slider.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }));
    expect(mocks.setReasoningEffort).not.toHaveBeenCalled();
    expect(mocks.haptics).not.toHaveBeenCalled();
  });

  it("snaps gestures to offered levels, prefers the cheaper tie, and ticks once per boundary", () => {
    mocks.platform.OS = "android";
    mocks.offered = ["instant", "high"];
    const root = openNativeSheet();
    const slider = root.find((node) => node.props.accessibilityRole === "adjustable");
    const [detector] = hosts(root, "GestureDetector");
    expect(detector).toBeDefined();
    const race = detector.props.gesture as { gestures: GestureBuilder[] };
    const pan = race.gestures.find((candidate) => candidate.kind === "pan");
    expect(pan).toBeDefined();

    act(() => slider.props.onLayout({ nativeEvent: { layout: { width: 300 } } }));
    act(() => {
      pan?.handlers.onBegin({});
      // Position 1 is equidistant from offered positions 0 and 2: snap down.
      pan?.handlers.onStart({ x: 107 });
      // Position 3 is unsupported, so it snaps to offered position 2.
      pan?.handlers.onUpdate({ x: 278 });
      // The same boundary again must neither write nor tick twice.
      pan?.handlers.onUpdate({ x: 278 });
      pan?.handlers.onFinalize({});
    });

    expect(mocks.setReasoningEffort.mock.calls).toEqual([["instant"], ["high"]]);
    expect(mocks.haptics).toHaveBeenCalledTimes(2);
  });
});
