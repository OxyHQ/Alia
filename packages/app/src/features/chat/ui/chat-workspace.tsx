import { AiChatContainer } from '@oxy.so/bloom/ai-chat';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingView } from '@/shared/platform/keyboard';

/**
 * One native keyboard authority resizes the chat's frame, so the composer is never behind it.
 * Every chat screen stands in one — the conversation (the SDK's `AliaChatContent`) and the
 * welcome and loading states around it.
 */
export function KeyboardFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      // It measures itself against its parent, as if it began at the top of the screen, but the
      // app layout puts the shell below the status bar. Without that much offset the composer
      // stops a status bar short, behind the keyboard (seen on the Android emulator,
      // docs/native-validation.mdx). `automaticOffset` measures instead, but asynchronously, and
      // it lost the race to the first layout on a fresh launch.
      keyboardVerticalOffset={insets.top}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

/**
 * The chat's frame for a screen that is not a conversation: Bloom's container with the shell's
 * header, and a layer under the content (the welcome's field).
 */
export interface ChatWorkspaceProps {
  /** The shell's `AiChatMobileHeader`, above the breadcrumb. */
  header?: ReactNode;
  /** The content — a state, or the welcome's words. */
  children: ReactNode;
  /** A layer under the content, clipped to the container (the welcome's field). */
  background?: ReactNode;
}

export function ChatWorkspace({ header, children, background }: ChatWorkspaceProps) {
  return (
    <KeyboardFrame>
      <AiChatContainer
        header={header}
        background={background}
        // The chat fills the card and scrolls behind the header and the composer, which float
        // over it.
        floatingChrome
      >
        {children}
      </AiChatContainer>
    </KeyboardFrame>
  );
}
