import { Platform, View, type ViewProps } from 'react-native';
import Animated, { type AnimatedProps } from 'react-native-reanimated';
import * as React from 'react';

/**
 * A component that uses Animated.View on native platforms
 * and regular View on web to avoid worklet serialization issues
 */
export function NativeOnlyAnimatedView({
  children,
  ...props
}: AnimatedProps<ViewProps>) {
  if (Platform.OS === 'web') {
    // On web, use regular View to avoid reanimated overhead
    return <View {...(props as ViewProps)}>{children}</View>;
  }

  // On native, use Animated.View
  return <Animated.View {...props}>{children}</Animated.View>;
}
