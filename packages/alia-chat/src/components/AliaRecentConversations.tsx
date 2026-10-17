import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import { useMemo } from 'react';
import { View } from 'react-native';
import { useLabels } from '../lib/labels';
import { useConversations } from '../runtime/conversations';

/** How many of the lead's conversations the sheet offers to pick up again. */
export const RECENT_CONVERSATIONS_SHOWN = 3;

/**
 * The person's latest conversations with the sheet's lead, under its greeting: "Ask Sindi" picks
 * up where it left off instead of every opening being a blank page. Alia's own sheet lists the
 * person's latest conversations of any kind. Nothing while loading or when there are none.
 */
export function AliaRecentConversations({
  agentId,
  onOpen,
}: {
  /** The lead; omitted, Alia. */
  agentId?: string;
  onOpen: (conversationId: string) => void;
}) {
  const labels = useLabels();
  const { data } = useConversations(agentId === undefined ? {} : { agentId });
  const recent = useMemo(
    () => data?.pages[0]?.conversations.slice(0, RECENT_CONVERSATIONS_SHOWN) ?? [],
    [data],
  );
  const when = useMemo(
    () => new Intl.DateTimeFormat(labels.locale, { day: 'numeric', month: 'short' }),
    [labels.locale],
  );
  if (recent.length === 0) return null;
  return (
    <View accessibilityRole="list" className="w-full max-w-[480px] self-center gap-1">
      <Text className="px-3 text-sm text-text-secondary">{labels.recentConversations}</Text>
      {recent.map((conversation) => {
        const title = conversation.title || labels.newChat;
        return (
          <Item
            key={conversation.id}
            density="compact"
            accessibilityRole="button"
            accessibilityLabel={title}
            onPress={() => onOpen(conversation.id)}
            title={<Text numberOfLines={1}>{title}</Text>}
            trailing={
              <Text className="text-xs text-text-tertiary">
                {when.format(new Date(conversation.updatedAt))}
              </Text>
            }
          />
        );
      })}
    </View>
  );
}
