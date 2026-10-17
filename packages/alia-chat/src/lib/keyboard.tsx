// Web: re-export React Native built-in components as keyboard-controller substitutes
import React from 'react';
import {
  ScrollView,
  type ScrollViewProps,
  KeyboardAvoidingView as RNKeyboardAvoidingView,
  type KeyboardAvoidingViewProps as RNKeyboardAvoidingViewProps,
  View,
} from 'react-native';

// Accept native-only props so shared components don't cause TS errors
type KeyboardAwareScrollViewProps = ScrollViewProps & {
  bottomOffset?: number;
  disableScrollOnKeyboardHide?: boolean;
  enabled?: boolean;
  extraKeyboardSpace?: number;
};

// `ComponentRef`, not `ScrollView` itself: React Native 0.88 types `ScrollView` as a function
// component, so the class is no longer its instance type.
const KeyboardAwareScrollView = React.forwardRef<
  React.ComponentRef<typeof ScrollView>,
  KeyboardAwareScrollViewProps
>(({ bottomOffset, disableScrollOnKeyboardHide, enabled, extraKeyboardSpace, ...props }, ref) => (
  <ScrollView ref={ref} {...props} />
));
KeyboardAwareScrollView.displayName = 'KeyboardAwareScrollView';

// `automaticOffset` is keyboard-controller's: measure the view's position in
// the window instead of trusting its parent-relative layout. The browser moves
// its own viewport for the keyboard, so on web it has nothing to do.
type KeyboardAvoidingViewProps = RNKeyboardAvoidingViewProps & {
  automaticOffset?: boolean;
};

const KeyboardAvoidingView = React.forwardRef<
  React.ComponentRef<typeof RNKeyboardAvoidingView>,
  KeyboardAvoidingViewProps
>(({ automaticOffset, ...props }, ref) => <RNKeyboardAvoidingView ref={ref} {...props} />);
KeyboardAvoidingView.displayName = 'KeyboardAvoidingView';

export { KeyboardAwareScrollView, KeyboardAvoidingView };

// No-op provider on web — keyboard-controller is native-only
export function KeyboardProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * The room under a bottom-anchored control for the system's bottom bar. The web's keyboard resizes
 * the page rather than covering it, so that room never has to give way to it (see the native file).
 */
export function KeyboardSafeAreaFloor({ inset }: { inset: number }) {
  return <View style={{ height: inset }} />;
}
