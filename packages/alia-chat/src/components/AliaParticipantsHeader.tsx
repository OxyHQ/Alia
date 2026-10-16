import { useAiChatShell } from '@oxy.so/bloom/ai-chat';
import { Button } from '@oxy.so/bloom/button';
import { RiMenuLine } from '@oxy.so/bloom/icons/RiMenuLine';
import { memo } from 'react';
import { View } from 'react-native';
import type { AliaChatParticipants } from '../lib/participants';
import { AliaParticipants } from './AliaParticipants';

export interface AliaParticipantsHeaderProps {
  participants: AliaChatParticipants;
  /** Pressing the participants. Omitted, every avatar in it waves. */
  onPress?: () => void;
}

/**
 * The conversation's header inside Bloom's AI chat shell: the participants as its title, between
 * the shell's own buttons — the navigation drawer's on a narrow screen and the panel's below `xl`,
 * as `AiChatMobileHeader` places them. That header's title is a string; this one is the
 * conversation's participants, so a host puts this in `chrome.header` instead of drawing a title
 * of its own. Outside a shell it is the participants alone.
 */
export const AliaParticipantsHeader = memo(function AliaParticipantsHeader({
  participants,
  onPress,
}: AliaParticipantsHeaderProps) {
  const shell = useAiChatShell();
  const nav = shell?.compact === true && shell.navCollapsed && shell.hasNav;
  const panel = shell?.compact === true && shell.hasPanel;
  return (
    <View className="min-h-12 shrink-0 flex-row items-center justify-between px-3 pt-3">
      <View className="w-10">
        {nav && shell ? (
          <Button
            size="md"
            icon={RiMenuLine}
            accessibilityLabel={shell.labels.openNavigation}
            onPress={shell.openNav}
            appearance="plain"
            tone="neutral"
          />
        ) : null}
      </View>
      <View className="min-w-0 shrink items-center">
        <AliaParticipants participants={participants} onPress={onPress} />
      </View>
      <View className="w-10 items-end">
        {panel && shell ? (
          <Button
            size="md"
            icon={shell.panelIcon}
            accessibilityLabel={shell.labels.openPanel(shell.panelLabel)}
            onPress={shell.openPanel}
            appearance="plain"
            tone="neutral"
          />
        ) : null}
      </View>
    </View>
  );
});
