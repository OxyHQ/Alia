import { AiChatHeader } from '@oxy.so/bloom/ai-chat';
import { memo } from 'react';
import type { AliaChatParticipants } from '../lib/participants';
import { AliaParticipants } from './AliaParticipants';

export interface AliaParticipantsHeaderProps {
  participants: AliaChatParticipants;
  /** Pressing the participants. Omitted, every avatar in it waves. */
  onPress?: () => void;
}

/**
 * The conversation's header inside Bloom's AI chat shell: the participants as its title, in
 * Bloom's `AiChatHeader`, between the shell's own navigation and panel buttons on a compact
 * screen. A host puts this in `chrome.header` instead of drawing a title of its own. Outside a
 * shell it is the participants alone.
 */
export const AliaParticipantsHeader = memo(function AliaParticipantsHeader({
  participants,
  onPress,
}: AliaParticipantsHeaderProps) {
  return (
    <AiChatHeader>
      <AliaParticipants participants={participants} onPress={onPress} />
    </AiChatHeader>
  );
});
