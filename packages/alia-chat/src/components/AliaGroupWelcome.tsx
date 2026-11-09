import { useAvatarFlights } from '@oxy.so/bloom/avatar-flight';
import { SelectedAgentPreview } from '@oxy.so/bloom/multi-agent-chat';
import { Text, View } from 'react-native';
import { useMemo } from 'react';
import { useAliaFlights } from '../lib/flights';
import { useLabels } from '../lib/labels';
import type { AliaParticipant } from '../lib/participants';

/**
 * The empty chat of a GROUP: its members together, as Bloom's multi-agent chat draws them (one
 * large avatar, a trio, or a ring), above "A few minds, one conversation". Each avatar is named
 * `empty:<agent id>` for the chat's flights, the anchor Bloom's own group chat flies from.
 */
export function AliaGroupWelcome({ members }: { members: readonly AliaParticipant[] }) {
  const { t } = useLabels();
  const shared = useAliaFlights();
  const own = useAvatarFlights();
  const agents = useMemo(
    () =>
      members.map((member) => ({
        id: member.id,
        name: member.name,
        label: '',
        description: '',
        avatar: member.character,
      })),
    [members],
  );
  return (
    <View className="items-center gap-4">
      <SelectedAgentPreview agents={agents} flights={shared ?? own} anchor="empty" />
      <Text selectable={false} className="max-w-md shrink text-center text-4xl text-text-primary">
        {t('chat.groupWelcome')}
      </Text>
    </View>
  );
}
