// Web: re-export React Native built-in components as keyboard-controller substitutes
import React from 'react';
import { View, type ViewProps, ScrollView, type ScrollViewProps, KeyboardAvoidingView } from 'react-native';

// Accept native-only props so shared components don't cause TS errors
type KeyboardAwareScrollViewProps = ScrollViewProps & {
  bottomOffset?: number;
  disableScrollOnKeyboardHide?: boolean;
  enabled?: boolean;
  extraKeyboardSpace?: number;
};

const KeyboardAwareScrollView = React.forwardRef<ScrollView, KeyboardAwareScrollViewProps>(
  ({ bottomOffset, disableScrollOnKeyboardHide, enabled, extraKeyboardSpace, ...props }, ref) => (
    <ScrollView ref={ref} {...props} />
  )
);
KeyboardAwareScrollView.displayName = 'KeyboardAwareScrollView';

// No-op on web — keyboard sticky behavior is native-only
type KeyboardStickyViewProps = ViewProps & {
  offset?: { closed?: number; opened?: number };
  enabled?: boolean;
};

const KeyboardStickyView = React.forwardRef<View, KeyboardStickyViewProps>(
  ({ offset, enabled, ...props }, ref) => <View ref={ref} {...props} />
);
KeyboardStickyView.displayName = 'KeyboardStickyView';

export { KeyboardAwareScrollView, KeyboardAvoidingView, KeyboardStickyView };

// No-op provider on web — keyboard-controller is native-only
export function KeyboardProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
