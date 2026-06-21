// Web: re-export React Native built-in components as keyboard-controller substitutes
import React from 'react';
import { ScrollView, type ScrollViewProps, KeyboardAvoidingView } from 'react-native';

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

export { KeyboardAwareScrollView, KeyboardAvoidingView };

// No-op provider on web — keyboard-controller is native-only
export function KeyboardProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
