import { Image as ExpoImage, type ImageProps } from 'expo-image';
import type { ComponentType } from 'react';
import { styled } from 'react-native-css';

/**
 * `expo-image` with `className`. On web the class reaches the DOM either way;
 * on native react-native-css maps classes to styles only for react-native's own
 * primitives, so anything else drops them silently unless it is wrapped once,
 * here, at module scope.
 */
export const Image: ComponentType<ImageProps & { className?: string }> = styled(ExpoImage, {
  className: 'style',
});
