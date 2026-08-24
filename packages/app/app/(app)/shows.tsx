/**
 * Your shows — a list of SERIES, each of which is a real podcast on Syra.
 *
 * The screen this replaces listed one row per generated recording, because a
 * show WAS one recording. A show is now a series you keep adding to, so the
 * list is series and the episodes live one level down.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, RefreshControl, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Plus, Mic, ChevronRight, Lock, Link2, Globe } from 'lucide-react-native';
import { useAuth } from '@oxyhq/services';
import { ContentPanel } from '@oxyhq/bloom/content-panel';
import { useShowStore, type ShowSeries, type ShowVisibility } from '@/lib/stores/show-store';
import { SeriesCreateDialog } from '@/components/show/series-create-dialog';
import { useShowProgress } from '@/lib/hooks/use-show-progress';
import { useColorScheme } from '@/lib/useColorScheme';
import { Skeleton } from '@/components/ui/skeleton';

/** Who can hear it, as an icon and a word. */
const VISIBILITY: Record<ShowVisibility, { label: string; icon: typeof Lock }> = {
  private: { label: 'Private', icon: Lock },
  unlisted: { label: 'Unlisted', icon: Link2 },
  public: { label: 'Public', icon: Globe },
};

const formatDate = (value: string): string =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function SeriesCard({ series, onOpen }: { series: ShowSeries; onOpen: (id: string) => void }) {
  const visibility = VISIBILITY[series.visibility];
  const VisibilityIcon = visibility.icon;
  // `nextEpisodeNumber` counts from 1, so it is one past however many have been
  // started — which is what a person means by "how many episodes".
  const episodeCount = series.nextEpisodeNumber - 1;

  return (
    <ContentPanel surfaceClassName="bg-background">
      <Pressable
        onPress={() => onOpen(series.id)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${series.title}`}
        className="gap-3 rounded-xl border border-border bg-card p-4 active:opacity-80"
      >
        <View className="flex-row items-start justify-between gap-2">
          <View className="flex-1 gap-1">
            <Text className="text-base font-semibold text-foreground" numberOfLines={2}>
              {series.title}
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={2}>
              {series.brief}
            </Text>
          </View>
          <ChevronRight size={18} className="text-muted-foreground" />
        </View>

        <View className="flex-row flex-wrap items-center gap-2">
          <View className="rounded-full bg-muted px-2 py-0.5">
            <Text className="text-[10px] font-medium uppercase text-muted-foreground">
              {series.format}
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            <VisibilityIcon size={11} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">{visibility.label}</Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            {episodeCount === 1 ? '1 episode' : `${episodeCount} episodes`}
          </Text>
          <Text className="text-xs text-muted-foreground">{formatDate(series.createdAt)}</Text>
        </View>
      </Pressable>
    </ContentPanel>
  );
}

export default function ShowsScreen() {
  const router = useRouter();
  const series = useShowStore((s) => s.series);
  const loading = useShowStore((s) => s.loading);
  const error = useShowStore((s) => s.error);
  const fetchSeries = useShowStore((s) => s.fetchSeries);
  const fetchPreferences = useShowStore((s) => s.fetchPreferences);
  const { isAuthenticated } = useAuth();
  const { colors } = useColorScheme();

  // One listener for the whole feature, on the shared notifications socket, so
  // an episode started here keeps reporting while the user is on the list.
  useShowProgress();

  const [createOpen, setCreateOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    void fetchSeries();
    void fetchPreferences();
  }, [isAuthenticated, fetchSeries, fetchPreferences]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchSeries();
    setRefreshing(false);
  }, [fetchSeries]);

  const openSeries = useCallback(
    (id: string) => router.push(`/(app)/shows/${id}`),
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: ShowSeries }) => (
      <View className="px-4 pb-3">
        <SeriesCard series={item} onOpen={openSeries} />
      </View>
    ),
    [openSeries],
  );

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-4 pb-2 pt-4">
        <View className="flex-row items-center gap-2">
          <Mic size={20} className="text-foreground" />
          <Text className="text-xl font-bold text-foreground">Shows</Text>
        </View>
        <Button
          size="sm"
          className="flex-row items-center gap-1.5"
          onPress={() => setCreateOpen(true)}
        >
          <Plus size={14} className="text-primary-foreground" />
          <Text className="text-sm text-primary-foreground">New</Text>
        </Button>
      </View>

      {error && (
        <View className="px-4 pb-2">
          <View className="rounded-lg bg-destructive/10 p-2">
            <Text className="text-xs text-destructive">{error}</Text>
          </View>
        </View>
      )}

      {loading && series.length === 0 ? (
        <View className="gap-3 px-4 pt-2">
          {[1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-28 w-full rounded-xl" />
          ))}
        </View>
      ) : series.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <Mic size={48} className="text-muted-foreground" />
          <Text className="text-center text-lg font-semibold text-foreground">No shows yet</Text>
          <Text className="text-center text-sm text-muted-foreground">
            Start a show and Alia will write, voice and publish each episode to Syra — where it
            becomes a real podcast you can share or keep to yourself.
          </Text>
          <Button
            onPress={() => setCreateOpen(true)}
            className="flex-row items-center gap-1.5"
          >
            <Plus size={14} className="text-primary-foreground" />
            <Text className="text-primary-foreground">Start a show</Text>
          </Button>
        </View>
      ) : (
        <FlatList
          data={series}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: 20 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
        />
      )}

      <SeriesCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={openSeries}
      />
    </View>
  );
}
