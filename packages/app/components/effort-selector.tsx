import { ChevronDown } from "lucide-react-native";
import { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { BottomSheet } from "@oxyhq/bloom/bottom-sheet";
import { useHaptics } from "@oxyhq/bloom/hooks";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { useIsLargeScreen } from "@/lib/hooks/use-is-large-screen";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  EFFORT_LEVELS,
  resolveSelection,
  useCatalogue,
  type EffortLevel,
} from "@/lib/hooks/use-catalogue";
import { effortFor, useModelStore } from "@/lib/stores/model-store";
import { cn } from "@/lib/utils";

/** Where each level's name lives, so both controls say the same words. */
const EFFORT_LABEL_KEY: Record<EffortLevel, string> = {
  instant: "effort.levels.instant",
  medium: "effort.levels.medium",
  high: "effort.levels.high",
  max: "effort.levels.max",
};

/** The last position on the slider, which is the last level the catalogue offers. */
const LAST_INDEX = EFFORT_LEVELS.length - 1;

/**
 * The index that stands for "no level chosen": the request omits the parameter
 * and the model decides for itself. Distinct from every real position, so a tap
 * on the position the knob is already resting at still commits a level.
 */
const NO_LEVEL = -1;

/**
 * Where the knob rests while the model decides for itself: the second position,
 * dimmed. `null` is not a level — it is the absence of one — so the control
 * marks it rather than pretending the person chose `medium`.
 */
const DEFAULT_INDEX = 1;

/** The pill's own height. The knob is larger and overhangs it top and bottom. */
const TRACK_HEIGHT = 40;
const KNOB_SIZE = 44;
const DOT_SIZE = 7;
/** Hairline gap between the pill's edge and the filled region inside it. */
const FILL_INSET = 3;
/** How far a finger travels sideways before the drag is the slider's, not the sheet's. */
const PAN_SLOP = 8;
/** The knob's snap. */
const SNAP_SPRING = { damping: 20, stiffness: 240, mass: 0.7 };

/** The two things a screen reader can do to a slider it cannot drag. */
const ADJUST_ACTIONS = [{ name: "increment" }, { name: "decrement" }];

/** The name of a level, or of the model's own default. */
function labelFor(t: (key: string) => string, level: EffortLevel | null): string {
  return t(level === null ? "effort.levels.default" : EFFORT_LABEL_KEY[level]);
}

/**
 * The offered levels as one bit per position.
 *
 * The gesture asks "is this level on offer?" on the UI thread, and a number
 * crosses that boundary as itself — where the array it came from is rebuilt on
 * every render and would drag a fresh closure across with it.
 */
function bitsFor(offered: readonly EffortLevel[]): number {
  return EFFORT_LEVELS.reduce(
    (bits, level, index) => (offered.includes(level) ? bits | (1 << index) : bits),
    0,
  );
}

/** Where the knob sits for a level index, including the one that is no level. */
function visualIndexOf(index: number): number {
  "worklet";
  return index === NO_LEVEL ? DEFAULT_INDEX : index;
}

/** The x of the knob's centre at `index`, for a control of this width. */
function centreFor(index: number, width: number): number {
  "worklet";
  const travel = Math.max(0, width - KNOB_SIZE);
  return KNOB_SIZE / 2 + (travel * index) / LAST_INDEX;
}

/** The position an x falls nearest to, before asking whether it is on offer. */
function indexAt(x: number, width: number): number {
  "worklet";
  const travel = Math.max(1, width - KNOB_SIZE);
  const raw = Math.round(((x - KNOB_SIZE / 2) / travel) * LAST_INDEX);
  return Math.min(LAST_INDEX, Math.max(0, raw));
}

/**
 * The nearest position the chosen model actually offers, cheaper side first on
 * a tie: a snap may never round somebody UP into a costlier level.
 */
function nearestOffered(index: number, bits: number): number {
  "worklet";
  for (let step = 0; step <= LAST_INDEX; step += 1) {
    const below = index - step;
    if (below >= 0 && (bits & (1 << below)) !== 0) return below;
    const above = index + step;
    if (above <= LAST_INDEX && (bits & (1 << above)) !== 0) return above;
  }
  return index;
}

/** Keep the knob inside the pill. */
function clampX(x: number, width: number): number {
  "worklet";
  const last = Math.max(KNOB_SIZE / 2, width - KNOB_SIZE / 2);
  return Math.min(Math.max(x, KNOB_SIZE / 2), last);
}

export function EffortSelector({ selectedModel }: { selectedModel: string }) {
  const { t } = useTranslation();
  const { data: entries } = useCatalogue();
  const isLargeScreen = useIsLargeScreen();
  const storedEffort = useModelStore((state) => state.reasoningEffort);
  const setReasoningEffort = useModelStore((state) => state.setReasoningEffort);
  const supported = resolveSelection(selectedModel, entries).entry?.capabilities.reasoningLevels ?? [];
  const active = effortFor(storedEffort, supported);
  const triggerLabel = active === null ? t("effort.select") : t(EFFORT_LABEL_KEY[active]);

  /**
   * A phone gets the slider; everything else keeps the menu.
   *
   * Web is excluded because its composer owns the effort control itself (a
   * slider inside the model picker), and a large screen because the pill wants
   * a sheet's width — the menu is the better control where there is room for a
   * popover and a pointer to open it with.
   */
  if (Platform.OS !== "web" && !isLargeScreen) {
    return (
      <EffortSheet
        active={active}
        offered={supported}
        triggerLabel={triggerLabel}
        onSelect={setReasoningEffort}
      />
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Pressable
          accessibilityLabel={t("effort.select")}
          accessibilityRole="button"
          className="h-9 flex-row items-center gap-1.5 rounded-full px-2.5 active:opacity-70"
        >
          <Text className="text-sm font-medium text-foreground">{triggerLabel}</Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="end" className="w-44 rounded-2xl py-1.5">
        {EFFORT_LEVELS.map((level) => (
          <DropdownMenu.CheckboxItem
            key={level}
            value={active === level ? "on" : "off"}
            disabled={!supported.includes(level)}
            onValueChange={() => setReasoningEffort(level)}
            className="rounded-xl px-2 py-2"
          >
            <DropdownMenu.ItemTitle>{t(EFFORT_LABEL_KEY[level])}</DropdownMenu.ItemTitle>
          </DropdownMenu.CheckboxItem>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/** The composer's effort button, and the sheet the slider lives in. */
function EffortSheet({
  active,
  offered,
  triggerLabel,
  onSelect,
}: {
  active: EffortLevel | null;
  offered: readonly EffortLevel[];
  triggerLabel: string;
  onSelect: (level: EffortLevel) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityLabel={t("effort.select")}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        className="h-9 flex-row items-center gap-1.5 rounded-full px-2.5 active:opacity-70"
      >
        <Text className="text-sm font-medium text-foreground">{triggerLabel}</Text>
        <ChevronDown size={14} className="text-muted-foreground" />
      </Pressable>

      {open && (
        <BottomSheet open onDismiss={() => setOpen(false)}>
          <View className="gap-6 px-5 pb-10 pt-2">
            <Text className="text-center text-lg font-medium text-foreground">
              {t("effort.headlinePrefix")}
              <Text className="text-lg font-medium text-primary">{labelFor(t, active)}</Text>
              {t("effort.headlineSuffix")}
            </Text>
            <EffortSlider active={active} offered={offered} onSelect={onSelect} />
          </View>
        </BottomSheet>
      )}
    </>
  );
}

function EffortSlider({
  active,
  offered,
  onSelect,
}: {
  active: EffortLevel | null;
  offered: readonly EffortLevel[];
  onSelect: (level: EffortLevel) => void;
}) {
  const { t } = useTranslation();
  const haptics = useHaptics();
  const disabled = offered.length === 0;
  /** The level the store holds, which is no level at all until one is picked. */
  const storedIndex = active === null ? NO_LEVEL : EFFORT_LEVELS.indexOf(active);
  const activeIndex = visualIndexOf(storedIndex);
  const offeredBits = bitsFor(offered);

  const width = useSharedValue(0);
  const knobX = useSharedValue(KNOB_SIZE / 2);
  const dragging = useSharedValue(false);
  /**
   * The level the gesture last committed.
   *
   * Both the "has the level changed" guard and the decision to fire live on the
   * UI thread, in one synchronous worklet step: read, write, schedule. Worklets
   * on that thread do not interleave, so a boundary crossed once schedules
   * exactly one hop to JS — one store write and one tick. Comparing on the JS
   * side instead would let a second frame's comparison run before the first
   * frame's write landed, and double-tick the same dot.
   */
  const settled = useSharedValue(storedIndex);
  const bits = useDerivedValue(() => offeredBits);
  const restingX = useDerivedValue(() => centreFor(activeIndex, width.value));

  // Follow the chosen level whenever it moves for any reason other than this
  // finger — a model swap, the a11y actions below, another screen's picker.
  useAnimatedReaction(
    () => restingX.value,
    (next) => {
      if (dragging.value) return;
      knobX.value = withSpring(next, SNAP_SPRING);
    },
  );

  /**
   * One level change: the store write and the tick that reports it.
   *
   * They are one function so that no caller can perform half of it, and it runs
   * on JS because `useHaptics` is a React callback a worklet cannot call.
   */
  const selectLevel = (level: EffortLevel) => {
    onSelect(level);
    haptics("light");
  };

  const commit = (index: number) => {
    "worklet";
    if (index === settled.value) return;
    settled.value = index;
    runOnJS(selectLevel)(EFFORT_LEVELS[index]);
  };

  /**
   * Re-read the store as the finger lands, so the guard starts each gesture
   * from what is true rather than from wherever the last one left it.
   */
  const syncSettled = () => {
    "worklet";
    settled.value = storedIndex;
  };

  const pan = Gesture.Pan()
    .enabled(!disabled)
    .activeOffsetX([-PAN_SLOP, PAN_SLOP])
    .failOffsetY([-PAN_SLOP * 2, PAN_SLOP * 2])
    .onBegin(syncSettled)
    .onStart((event) => {
      dragging.value = true;
      knobX.value = clampX(event.x, width.value);
      commit(nearestOffered(indexAt(event.x, width.value), bits.value));
    })
    .onUpdate((event) => {
      knobX.value = clampX(event.x, width.value);
      commit(nearestOffered(indexAt(event.x, width.value), bits.value));
    })
    .onFinalize(() => {
      if (!dragging.value) return;
      dragging.value = false;
      knobX.value = withSpring(
        centreFor(visualIndexOf(settled.value), width.value),
        SNAP_SPRING,
      );
    });

  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onBegin(syncSettled)
    .onEnd((event) => {
      const index = nearestOffered(indexAt(event.x, width.value), bits.value);
      commit(index);
      knobX.value = withSpring(centreFor(index, width.value), SNAP_SPRING);
    });

  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: knobX.value - KNOB_SIZE / 2 }],
  }));
  const fillStyle = useAnimatedStyle(() => ({
    width: Math.max(0, knobX.value - FILL_INSET),
  }));

  const handleLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    const isFirstMeasure = width.value === 0;
    width.value = measured;
    // Place the knob on the first measure rather than animating it in from the
    // left edge; every later move is the reaction's.
    if (isFirstMeasure) knobX.value = centreFor(activeIndex, measured);
  };

  /** Walk to the next level on offer, which is all a screen reader can ask for. */
  const stepBy = (direction: 1 | -1) => {
    for (let index = activeIndex + direction; index >= 0 && index <= LAST_INDEX; index += direction) {
      const level = EFFORT_LEVELS[index];
      if (offered.includes(level)) {
        selectLevel(level);
        return;
      }
    }
  };

  return (
    <GestureDetector gesture={Gesture.Race(pan, tap)}>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel={t("effort.select")}
        accessibilityValue={{ min: 0, max: LAST_INDEX, now: activeIndex, text: labelFor(t, active) }}
        accessibilityActions={ADJUST_ACTIONS}
        accessibilityState={{ disabled }}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "increment") stepBy(1);
          if (event.nativeEvent.actionName === "decrement") stepBy(-1);
        }}
        onLayout={handleLayout}
        className={cn(disabled && "opacity-40")}
        style={styles.control}
      >
        <View className="rounded-full border border-border bg-muted" style={styles.track}>
          <Animated.View
            className={cn("rounded-full bg-primary", active === null && "opacity-60")}
            style={[styles.fill, fillStyle]}
          />
          <View style={styles.dots}>
            {EFFORT_LEVELS.map((level, index) => (
              <View
                key={level}
                className={cn(
                  "rounded-full",
                  index <= activeIndex ? "bg-primary-foreground/40" : "bg-muted-foreground/60",
                )}
                style={styles.dot}
              />
            ))}
          </View>
        </View>
        <Animated.View
          className="rounded-full border border-border bg-primary-foreground"
          style={[styles.knob, knobStyle]}
        />
      </View>
    </GestureDetector>
  );
}

// Geometry only: everything with a colour in it is a NativeWind class above.
const styles = StyleSheet.create({
  control: {
    height: KNOB_SIZE,
    justifyContent: "center",
  },
  track: {
    height: TRACK_HEIGHT,
  },
  fill: {
    position: "absolute",
    top: FILL_INSET,
    bottom: FILL_INSET,
    left: FILL_INSET,
  },
  dots: {
    position: "absolute",
    top: 0,
    bottom: 0,
    // Inset so the first and last dot sit under the knob's two resting centres.
    left: (KNOB_SIZE - DOT_SIZE) / 2,
    right: (KNOB_SIZE - DOT_SIZE) / 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
  },
  knob: {
    position: "absolute",
    top: 0,
    left: 0,
    width: KNOB_SIZE,
    height: KNOB_SIZE,
  },
});
