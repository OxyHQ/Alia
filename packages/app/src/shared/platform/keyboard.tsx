// Web: re-export React Native built-in components as keyboard-controller substitutes
import React from 'react';
import { ScrollView, type ScrollViewProps, KeyboardAvoidingView, View } from 'react-native';

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

/**
 * The web's keyboard resizes the page rather than covering it, so the room for
 * the bottom inset never has to give way to it (see the native file).
 */
function KeyboardSafeAreaFloor({ inset }: { inset: number }) {
  return <View style={{ height: inset }} />;
}

export { KeyboardSafeAreaFloor };
