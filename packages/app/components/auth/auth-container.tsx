import * as React from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from '@/lib/keyboard';

export interface AuthContainerProps {
  children: React.ReactNode;
}

/**
 * The column an auth-style page (sign-in help, invites, app authorization)
 * stands in: centred, 384 wide at most, scrolling above the keyboard.
 *
 * It paints nothing. The app layout's `AiChatContainer` owns the page surface
 * (background and corners), so this is layout only: a keyboard-aware scroller
 * and the centred column inside it.
 */
export function AuthContainer({ children }: AuthContainerProps) {
  return (
    <KeyboardAwareScrollView
      bottomOffset={20}
      style={{ flex: 1 }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        paddingHorizontal: 24,
        paddingVertical: 24,
      }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 384,
          alignSelf: 'center',
          gap: 24,
        }}
      >
        {children}
      </View>
    </KeyboardAwareScrollView>
  );
}
