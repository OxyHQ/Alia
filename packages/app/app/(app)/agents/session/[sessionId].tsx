import { SessionEventCard } from '@/features/agents/ui/session/session-event-card';
import { SessionSummary } from '@/features/agents/ui/session/session-summary';
import { useSessionActivity } from '@/features/agents/runtime/use-session-activity';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Divider } from '@oxy.so/bloom/divider';
import { EmptyState } from '@/shared/stickers/empty-state';
import { ListRowsSkeleton } from '@/shared/ui/skeletons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

/**
 * Agent Session Activity — Timeline view of all agent actions in a session.
 *
 * Shows a chronological feed of tool calls, observations, errors, threats,
 * and model responses. Entries can be expanded for full details. Plain content
 * on the layout's surface: every entry is a Bloom `Card`, every label a Bloom
 * `Badge`.
 */
export default function SessionActivityScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const { t } = useTranslation();
  const activity = useSessionActivity(sessionId);
  const entries = activity.data?.entries ?? [];
  const session = activity.data?.session ?? null;

  const [refreshing, setRefreshing] = useState(false);
  const { refetch } = activity;
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  return (
    <View className="flex-1">
      <Stack.Screen
        options={{
          title: t('pages.agents.sessionTitle'),
          headerBackVisible: true,
        }}
      />
      {session && <SessionSummary session={session} entries={entries} />}

      <Divider spacing={12} />

      {/* Activity timeline */}
      {activity.isPending ? (
        <ListRowsSkeleton rows={6} mark="tile" />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item._id || String(item.seq)}
          renderItem={({ item }) => <SessionEventCard entry={item} />}
          contentContainerClassName="gap-2 px-4 pb-4"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <EmptyState sticker="agentSession" title={t('pages.agents.sessionEmpty')} />
          }
        />
      )}
    </View>
  );
}
