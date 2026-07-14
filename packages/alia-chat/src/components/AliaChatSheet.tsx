import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback,
  useState,
  useEffect,
  useMemo,
} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Pressable,
  Dimensions,
  Platform,
  useColorScheme,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useKeyboardHandler } from 'react-native-keyboard-controller';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AliaChatContent } from './AliaChatContent';
import { AliaMark } from './AliaMark';
import type { WelcomeSuggestion } from './AliaWelcomeMessage';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const SPRING_CONFIG = {
  damping: 25,
  stiffness: 300,
  mass: 0.8,
};

export interface AliaChatSheetProps {
  /** App context injected into system prompt */
  clientContext?: string;
  /** Alia model (default: 'alia-v1') */
  model?: string;
  /** API URL override */
  apiUrl?: string;
  /** Welcome screen greeting */
  welcomeGreeting?: string;
  /** Welcome screen subtitle */
  welcomeSubtitle?: string;
  /** Welcome screen suggestions */
  welcomeSuggestions?: WelcomeSuggestion[];
}

export interface AliaChatSheetRef {
  present: () => void;
  dismiss: () => void;
}

export const AliaChatSheet = forwardRef<AliaChatSheetRef, AliaChatSheetProps>(
  ({ clientContext, model, apiUrl, welcomeGreeting, welcomeSubtitle, welcomeSuggestions }, ref) => {
    const scheme = useColorScheme();
    const isDark = scheme === 'dark';
    const insets = useSafeAreaInsets();

    // Sheet visibility
    const [rendered, setRendered] = useState(false);
    const hasClosedRef = useRef(false);
    const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Reanimated shared values
    const translateY = useSharedValue(SCREEN_HEIGHT);
    const backdropOpacity = useSharedValue(0);
    const scrollOffsetY = useSharedValue(0);
    const allowPanClose = useSharedValue(true);
    const keyboardHeight = useSharedValue(0);
    const panContext = useSharedValue({ y: 0 });

    useKeyboardHandler(
      {
        onMove: (e) => {
          'worklet';
          keyboardHeight.value = e.height;
        },
        onEnd: (e) => {
          'worklet';
          keyboardHeight.value = e.height;
        },
      },
      [],
    );

    // Dismiss helpers
    const finishDismiss = useCallback(() => {
      if (hasClosedRef.current) return;
      hasClosedRef.current = true;
      setRendered(false);
    }, []);

    const handlePresent = useCallback(() => {
      hasClosedRef.current = false;
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      setRendered(true);
      backdropOpacity.value = withTiming(1, { duration: 250 });
      translateY.value = withSpring(0, SPRING_CONFIG);
    }, []);

    const handleDismiss = useCallback(() => {
      backdropOpacity.value = withTiming(0, { duration: 250 }, (finished) => {
        if (finished) runOnJS(finishDismiss)();
      });
      translateY.value = withSpring(SCREEN_HEIGHT, {
        ...SPRING_CONFIG,
        stiffness: 250,
      });
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = setTimeout(() => {
        finishDismiss();
        closeTimeoutRef.current = null;
      }, 350);
    }, [finishDismiss]);

    useEffect(
      () => () => {
        if (closeTimeoutRef.current) {
          clearTimeout(closeTimeoutRef.current);
          closeTimeoutRef.current = null;
        }
      },
      [],
    );

    useImperativeHandle(
      ref,
      () => ({ present: handlePresent, dismiss: handleDismiss }),
      [handlePresent, handleDismiss],
    );

    // Pan gesture for swipe-to-dismiss
    const nativeGesture = useMemo(() => Gesture.Native(), []);

    const panGesture = useMemo(() => Gesture.Pan()
      .simultaneousWithExternalGesture(nativeGesture)
      .onStart(() => {
        'worklet';
        panContext.value = { y: translateY.value };
        allowPanClose.value = scrollOffsetY.value <= 8;
      })
      .onUpdate((event) => {
        'worklet';
        if (!allowPanClose.value) return;
        if (event.translationY > 0 && scrollOffsetY.value > 8) return;
        const newY = panContext.value.y + event.translationY;
        translateY.value = Math.max(0, newY);
      })
      .onEnd((event) => {
        'worklet';
        if (!allowPanClose.value) return;
        const velocity = event.velocityY;
        const distance = translateY.value;
        const closeThreshold = Math.max(140, SCREEN_HEIGHT * 0.25);
        const shouldClose =
          velocity > 900 || (distance > closeThreshold && velocity > -300);

        if (shouldClose) {
          translateY.value = withSpring(SCREEN_HEIGHT, {
            ...SPRING_CONFIG,
            velocity,
          });
          backdropOpacity.value = withTiming(0, { duration: 250 }, (finished) => {
            if (finished) runOnJS(finishDismiss)();
          });
        } else {
          translateY.value = withSpring(0, { ...SPRING_CONFIG, velocity });
        }
      }), [nativeGesture, finishDismiss]);

    // Animated styles
    const backdropAnimStyle = useAnimatedStyle(() => ({
      opacity: backdropOpacity.value,
    }));

    const sheetAnimStyle = useAnimatedStyle(() => ({
      transform: [{ translateY: translateY.value - keyboardHeight.value }],
    }));

    const sheetMaxHeightStyle = useAnimatedStyle(
      () => ({
        maxHeight: SCREEN_HEIGHT - keyboardHeight.value - insets.top,
      }),
      [insets.top],
    );

    if (!rendered) return null;

    return (
      <Modal
        visible={rendered}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={handleDismiss}
      >
        <GestureHandlerRootView style={StyleSheet.absoluteFill}>
          {/* Backdrop */}
          <Animated.View style={[styles.backdrop, backdropAnimStyle]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={handleDismiss} />
          </Animated.View>

          {/* Sheet */}
          <GestureDetector gesture={panGesture}>
            <Animated.View
              className="bg-background"
              style={[
                styles.sheet,
                sheetAnimStyle,
                sheetMaxHeightStyle,
              ]}
            >
              {/* Drag handle */}
              <View style={styles.dragHandle}>
                <View
                  style={[
                    styles.dragHandlePill,
                    { backgroundColor: isDark ? '#444' : '#C7C7CC' },
                  ]}
                />
              </View>

              {/* Chat content (header rendered inside via render prop) */}
              <GestureDetector gesture={nativeGesture}>
                <AliaChatContent
                  clientContext={clientContext}
                  model={model}
                  apiUrl={apiUrl}
                  scrollOffsetY={scrollOffsetY}
                  welcomeGreeting={welcomeGreeting}
                  welcomeSubtitle={welcomeSubtitle}
                  welcomeSuggestions={welcomeSuggestions}
                  header={({ markState, hasMessages, clear }) => (
                    <View style={styles.header}>
                      <View style={styles.headerLeft}>
                        <AliaMark size={28} state={markState} />
                        <Text className="text-lg font-semibold text-foreground">
                          Alia
                        </Text>
                      </View>
                      <View style={styles.headerRight}>
                        {hasMessages && (
                          <TouchableOpacity onPress={clear} style={styles.clearButton}>
                            <Text className="text-sm text-muted-foreground">
                              Clear
                            </Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity
                          onPress={handleDismiss}
                          style={styles.closeButton}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Text className="text-lg font-semibold text-muted-foreground">
                            {'\u2715'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                />
              </GestureDetector>
            </Animated.View>
          </GestureDetector>
        </GestureHandlerRootView>
      </Modal>
    );
  },
);

AliaChatSheet.displayName = 'AliaChatSheet';

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    maxWidth: 600,
    alignSelf: 'center',
    ...Platform.select({
      web: {
        marginHorizontal: 'auto',
        boxShadow: '0 -4px 24px rgba(0,0,0,0.15)',
      } as ViewStyle & { boxShadow?: string },
      default: { elevation: 16 },
    }),
  },
  dragHandle: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  dragHandlePill: {
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  closeButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
});
