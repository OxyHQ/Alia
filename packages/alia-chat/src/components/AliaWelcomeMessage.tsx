import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { AvatarAnchor } from '@oxy.so/bloom/avatar-flight';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { ANCHORS, useAliaFlights } from '../lib/flights';
import { greetingLines } from '../lib/greeting';
import { ALIA_LEAD, type AliaLead } from '../lib/participants';
import { AliaAvatar } from './AliaAvatar';

export interface AliaWelcomeMessageProps {
  /** The greeting, e.g. "Hi Nate, what's on your mind?". */
  greeting: string;
  subtitle?: string;
  markSize?: number;
  /** Who greets: the agent the chat was opened on. Default Alia. */
  lead?: AliaLead;
}

/**
 * The empty chat's greeting: the lead's avatar above it, both centred, the address on top ("Hi Nate,")
 * and the rest under it (`greetingLines`). The Alia app and the SDK chat
 * draw exactly this. The greeting has a max width (`max-w-xs`, 20rem) so it sets in two lines at
 * any width, as a headline under a mark rather than one long line across a wide column. The
 * suggestions are not part of it; they sit over the composer (`ComposerSuggestions`).
 */
export function AliaWelcomeMessage({
  greeting,
  subtitle,
  markSize = 88,
  lead = ALIA_LEAD,
}: AliaWelcomeMessageProps) {
  const flights = useAliaFlights();
  const avatar = lead.isAlia ? (
    <AliaAvatar size={markSize} interactive />
  ) : (
    <AgentAvatar character={lead.character} size={markSize} label={lead.name} interactive />
  );
  return (
    <View className="items-center gap-2">
      <View className="items-center justify-center gap-4">
        {/* It flies up into the header's profile when the conversation begins. */}
        {flights ? (
          <AvatarAnchor flights={flights} anchor={ANCHORS.welcome}>
            {avatar}
          </AvatarAnchor>
        ) : (
          avatar
        )}
        <Text selectable={false} className="max-w-xs shrink text-center text-4xl text-text-primary">
          {greetingLines(greeting).join('\n')}
        </Text>
      </View>
      {subtitle ? (
        <Text className="text-center text-lg text-text-secondary">{subtitle}</Text>
      ) : null}
    </View>
  );
}
