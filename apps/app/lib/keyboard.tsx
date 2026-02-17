// Web: re-export React Native built-in components as keyboard-controller substitutes
import React from 'react';

export { ScrollView as KeyboardAwareScrollView } from 'react-native';
export { KeyboardAvoidingView } from 'react-native';

// No-op provider on web — keyboard-controller is native-only
export function KeyboardProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
