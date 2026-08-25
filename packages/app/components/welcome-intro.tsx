import { useEffect, useState } from 'react';
import { Platform, View, type LayoutChangeEvent, type PointerEvent } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { IdentityMark } from '@alia.onl/sdk';
import { useAuth } from '@oxyhq/services';
import { AmbientField, PARALLAX_DURATION, PARALLAX_EASE } from '@/components/ambient-field';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useColorScheme } from '@/lib/useColorScheme';

/** Milliseconds between revealed characters of the headline. */
const TYPE_INTERVAL = 55;

/** The `ease-out` every entrance transition uses. */
const EASE_OUT = Easing.bezier(0, 0, 0.58, 1);
/** The body reveal curve. */
const EASE_REVEAL = Easing.bezier(0.22, 1, 0.36, 1);
/** The exit curve: everything falls upward and out, accelerating. */
const EASE_FALL = Easing.bezier(0.5, 0, 0.75, 0);

/**
 * The exit is staggered bottom-up — the call to action leaves first and the
 * mark last, so the eye is drawn up and off the screen.
 */
const FALL_CTA = { duration: 420, delay: 0 };
const FALL_SUB = { duration: 420, delay: 60 };
const FALL_HEADLINE = { duration: 460, delay: 120 };
const FALL_MARK = { duration: 460, delay: 180 };
/** How far each element travels as it goes. */
const FALL_DISTANCE = -22;

/** The blinking caret that trails the headline while it types itself out. */
function Caret({ done }: { done: boolean }) {
  const blink = useSharedValue(1);

  useEffect(() => {
    blink.value = withRepeat(withTiming(0, { duration: 520 }), -1, true);
  }, [blink]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: done ? withTiming(0, { duration: 200 }) : blink.value,
  }));

  return (
    <Animated.View
      className="ml-[1px] h-8 w-[2px] self-center bg-foreground md:h-10"
      style={animatedStyle}
    />
  );
}

/**
 * The first-run intro: the ambient field, the mark, a headline that types
 * itself, and the two ways out. It fills its parent and dismisses itself —
 * `onExitStart` fires the moment it begins leaving, so whatever sits behind it
 * can rise into view, and `onDismissed` once the exit has finished playing, so
 * the parent can unmount it.
 */
export function WelcomeIntro({
  onExitStart,
  onDismissed,
}: {
  onExitStart: () => void;
  onDismissed: () => void;
}) {
  const { t } = useTranslation();
  const { isDarkColorScheme } = useColorScheme();
  const { signIn } = useAuth();

  const headline = t('welcome.intro.headline');
  const [typed, setTyped] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  const pointerX = useSharedValue(0);
  const pointerY = useSharedValue(0);

  // Entrance drivers — each element has its own duration and delay.
  const headlineIn = useSharedValue(0);
  const reveal = useSharedValue(0);
  const subtitleIn = useSharedValue(0);
  const ctaIn = useSharedValue(0);
  // Exit drivers, 0 at rest and 1 once the element has fallen.
  const markFall = useSharedValue(0);
  const headlineFall = useSharedValue(0);
  const subtitleFall = useSharedValue(0);
  const ctaFall = useSharedValue(0);

  useEffect(() => {
    headlineIn.value = withTiming(1, { duration: 500, easing: EASE_OUT });
    reveal.value = withTiming(1, { duration: 800, easing: EASE_REVEAL });
    subtitleIn.value = withDelay(400, withTiming(1, { duration: 500, easing: EASE_OUT }));
    ctaIn.value = withDelay(700, withTiming(1, { duration: 400, easing: EASE_OUT }));
  }, [headlineIn, reveal, subtitleIn, ctaIn]);

  // Reveal the headline one character at a time; the interval clears itself
  // once the whole string is out.
  useEffect(() => {
    setTyped(0);
    const id = setInterval(() => {
      setTyped((n) => {
        if (n >= headline.length) {
          clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, TYPE_INTERVAL);
    return () => clearInterval(id);
  }, [headline]);

  const startExit = () => {
    if (exiting) return;
    // Recorded the moment the exit begins, so a reload mid-animation does not
    // replay the intro.
    setExiting(true);
    onExitStart();

    ctaFall.value = withDelay(
      FALL_CTA.delay,
      withTiming(1, { duration: FALL_CTA.duration, easing: EASE_FALL }),
    );
    subtitleFall.value = withDelay(
      FALL_SUB.delay,
      withTiming(1, { duration: FALL_SUB.duration, easing: EASE_FALL }),
    );
    headlineFall.value = withDelay(
      FALL_HEADLINE.delay,
      withTiming(1, { duration: FALL_HEADLINE.duration, easing: EASE_FALL }),
    );
    // The mark is last out, so its completion is the end of the whole exit.
    markFall.value = withDelay(
      FALL_MARK.delay,
      withTiming(1, { duration: FALL_MARK.duration, easing: EASE_FALL }, (finished) => {
        if (finished) runOnJS(onDismissed)();
      }),
    );
  };

  const handleGetStarted = () => {
    signIn()
      .then(startExit)
      .catch(() => {
        // Dialog dismissed without signing in — the intro stays put.
      });
  };

  const markStyle = useAnimatedStyle(() => ({
    opacity: headlineIn.value * (1 - markFall.value),
    transform: [
      { translateY: (1 - headlineIn.value) * 10 + markFall.value * FALL_DISTANCE },
      { scale: (0.97 + headlineIn.value * 0.03) * (1 - markFall.value * 0.03) },
    ],
  }));

  const headlineStyle = useAnimatedStyle(() => ({
    opacity: headlineIn.value * (1 - headlineFall.value),
    transform: [
      { translateY: (1 - headlineIn.value) * 10 + headlineFall.value * FALL_DISTANCE },
      { scale: (0.97 + headlineIn.value * 0.03) * (1 - headlineFall.value * 0.03) },
    ],
  }));

  // The body reveal: the measured height scaled by the driver, clipped by the
  // wrapper — the same shape as animating a row from zero to its content.
  const revealStyle = useAnimatedStyle(() => ({
    height: bodyHeight ? bodyHeight * reveal.value : undefined,
  }));

  const subtitleStyle = useAnimatedStyle(() => ({
    opacity: subtitleIn.value * (1 - subtitleFall.value),
    transform: [
      { translateY: (1 - subtitleIn.value) * 10 + subtitleFall.value * FALL_DISTANCE },
      { scale: 1 - subtitleFall.value * 0.03 },
    ],
  }));

  const ctaStyle = useAnimatedStyle(() => ({
    opacity: ctaIn.value * (1 - ctaFall.value),
    transform: [
      { translateY: (1 - ctaIn.value) * 10 + ctaFall.value * FALL_DISTANCE },
      { scale: 1 - ctaFall.value * 0.03 },
    ],
  }));

  const handleStageLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage({ width, height });
  };

  const handleBodyLayout = (event: LayoutChangeEvent) => {
    setBodyHeight(event.nativeEvent.layout.height);
  };

  // Web only: a mouse has a position, a finger tapping does not — wiring this
  // on native would jerk the field on every touch.
  const handlePointerMove =
    Platform.OS === 'web'
      ? (event: PointerEvent) => {
          if (!stage.width || !stage.height) return;
          const { offsetX, offsetY } = event.nativeEvent;
          pointerX.value = withTiming((offsetX / stage.width) * 2 - 1, {
            duration: PARALLAX_DURATION,
            easing: PARALLAX_EASE,
          });
          pointerY.value = withTiming((offsetY / stage.height) * 2 - 1, {
            duration: PARALLAX_DURATION,
            easing: PARALLAX_EASE,
          });
        }
      : undefined;

  return (
    <View
      className="flex-1 items-center justify-center overflow-hidden rounded-2xl bg-background px-7 py-6"
      onLayout={handleStageLayout}
      onPointerMove={handlePointerMove}
    >
      <AmbientField
        entrance
        exiting={exiting}
        isDarkMode={isDarkColorScheme}
        pointerX={pointerX}
        pointerY={pointerY}
      />

      <View className="w-full max-w-[640px] items-center gap-3">
        <Animated.View className="max-w-[560px] items-center gap-4">
          <Animated.View style={markStyle}>
            <IdentityMark size={40} spinOnPress />
          </Animated.View>
          <Animated.View
            className="flex-row items-center justify-center"
            accessibilityLabel={headline}
            style={headlineStyle}
          >
            {/* Typeface matches the chat greeting in
                components/welcome-message.tsx — Text's own font-sans, no
                display face. Editorial size stays. */}
            <Text className="text-center text-4xl font-light text-foreground md:text-5xl">
              {headline.slice(0, typed)}
            </Text>
            <Caret done={typed >= headline.length} />
          </Animated.View>
        </Animated.View>

        <Animated.View className="w-full overflow-hidden" style={revealStyle}>
          <View className="w-full items-center gap-6" onLayout={handleBodyLayout}>
            <Animated.View style={subtitleStyle}>
              <Text className="max-w-[520px] text-center text-muted-foreground">
                {t('welcome.intro.subtitle')}
              </Text>
            </Animated.View>

            <Animated.View className="items-center gap-2" style={ctaStyle}>
              <Button className="rounded-full px-5" onPress={handleGetStarted}>
                <Text className="text-base font-semibold">{t('welcome.intro.cta')}</Text>
              </Button>
              <Button variant="ghost" size="sm" className="rounded-full" onPress={startExit}>
                <Text className="text-sm text-muted-foreground">{t('welcome.intro.skip')}</Text>
              </Button>
            </Animated.View>
          </View>
        </Animated.View>
      </View>
    </View>
  );
}
