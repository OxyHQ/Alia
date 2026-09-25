import { AiChatContainer } from '@oxy.so/bloom/ai-chat';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoidingView } from '@/shared/platform/keyboard';

/** Bloom owns the chat frame; one native keyboard authority resizes it. */
export interface ChatWorkspaceProps {
  /** The chat's crumb. */
  title?: string;
  /** The project it belongs to, or absent — Bloom draws the title alone. */
  project?: string;
  /** The shell's `AiChatMobileHeader`, above the breadcrumb. */
  header?: React.ReactNode;
  /** The composer and anything under it. */
  composer?: React.ReactNode;
  /** The turns — an `AiChatThread`. */
  children: React.ReactNode;
  /** Draws Bloom's working indicator above the composer. */
  working?: boolean;
  workingLabel?: string;
  onShare?: () => void;
  onMore?: () => void;
  onProjectPress?: () => void;
  actions?: React.ReactNode;
  /** A layer under the turns, clipped to the container (the welcome's field). */
  background?: React.ReactNode;
}

export function ChatWorkspace({
  title,
  project,
  header,
  composer,
  children,
  working,
  workingLabel,
  onShare,
  onMore,
  onProjectPress,
  actions,
  background,
}: ChatWorkspaceProps) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      // It measures itself against its parent, as if it began at the top of
      // the screen, but the app layout puts the shell below the status bar.
      // Without that much offset the composer stops a status bar short, behind
      // the keyboard (seen on the Android emulator, docs/native-validation.mdx).
      // `automaticOffset` measures instead, but asynchronously, and it lost
      // the race to the first layout on a fresh launch.
      keyboardVerticalOffset={insets.top}
    >
      <AiChatContainer
        title={title}
        project={project}
        header={header}
        composer={composer}
        working={working}
        workingLabel={workingLabel}
        onShare={onShare}
        onMore={onMore}
        onProjectPress={onProjectPress}
        actions={actions}
        background={background}
        // Alia's conversation fills the card and scrolls behind the header
        // and the composer, which float over it.
        floatingChrome
      >
        {children}
      </AiChatContainer>
    </KeyboardAvoidingView>
  );
}
