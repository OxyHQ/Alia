import { AiChatContainer } from '@oxy.so/bloom/ai-chat';
import { Platform } from 'react-native';

import { KeyboardAvoidingView } from '@/lib/keyboard';

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
}: ChatWorkspaceProps) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
        style={{ flex: 1 }}
      >
        {children}
      </AiChatContainer>
    </KeyboardAvoidingView>
  );
}
