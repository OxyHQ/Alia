import { SessionEventCard } from '@/components/agents/session/session-event-card';
import { SessionSummary } from '@/components/agents/session/session-summary';
import { useSessionActivity } from '@/lib/hooks/agents/use-session-activity';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Divider } from '@oxy.so/bloom/divider';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { Loading } from '@oxy.so/bloom/loading';
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
        <View className="flex-1 items-center justify-center">
          <Loading variant="spinner" />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item._id || String(item.seq)}
          renderItem={({ item }) => <SessionEventCard entry={item} />}
          contentContainerClassName="gap-2 px-4 pb-4"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <EmptyState
              icon={RiHistoryLine}
              title={t('pages.agents.sessionEmpty')}
            />
          }
        />
      )}
    </View>
  );
}
