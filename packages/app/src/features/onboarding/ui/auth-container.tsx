import * as React from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from '@/shared/platform/keyboard';

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
      className="flex-1"
      contentContainerClassName="grow justify-center p-6"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View className="w-full max-w-[384px] self-center gap-6">
        {children}
      </View>
    </KeyboardAwareScrollView>
  );
}
