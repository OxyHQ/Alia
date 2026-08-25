/**
 * Your shows — a list of SERIES, each of which is a real podcast on Syra.
 *
 * The screen this replaces listed one row per generated recording, because a
 * show WAS one recording. A show is now a series you keep adding to, so the
 * list is series and the episodes live one level down.
 *
 * The row is the shape Syra's own creator portal gives a show
 * (`packages/studio/components/ShowCard.tsx`): cover art at a real size, the
 * title with its status beside it, who is on it, and how many episodes there
 * are. Rebuilt in Alia's idiom rather than imported — same product, two design
 * systems.
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
import { ShowArtwork } from '@/components/show/show-artwork';
import { useShowProgress } from '@/lib/hooks/use-show-progress';
import { useColorScheme } from '@/lib/useColorScheme';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEpisodeCount } from '@/lib/utils/show-format';

/** Who can hear it, as an icon and a word. */
const VISIBILITY: Record<ShowVisibility, { label: string; icon: typeof Lock }> = {
  private: { label: 'Private', icon: Lock },
  unlisted: { label: 'Unlisted', icon: Link2 },
  public: { label: 'Public', icon: Globe },
};

function SeriesRow({ series, onOpen }: { series: ShowSeries; onOpen: (id: string) => void }) {
  const visibility = VISIBILITY[series.visibility];
  const VisibilityIcon = visibility.icon;
  // `nextEpisodeNumber` counts from 1, so it is one past however many have been
  // started — which is what a person means by "how many episodes".
  const episodeCount = series.nextEpisodeNumber - 1;
  // Syra names a show's author under its title. Alia's author is its cast; a
  // series with no cast yet falls back to what the show is about.
  const byline = series.speakers.map((speaker) => speaker.name).join(', ') || series.brief;

  return (
    <Pressable
      onPress={() => onOpen(series.id)}
      accessibilityRole="button"
      accessibilityLabel={`Open ${series.title}`}
      className="flex-row items-center gap-4 rounded-2xl border border-border bg-card p-3 active:opacity-80 web:transition-colors web:hover:bg-muted/40"
    >
      <ShowArtwork
        assetId={series.coverImageAssetId}
        title={series.title}
        className="h-16 w-16 rounded-xl"
        iconSize={26}
      />

      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="flex-1 text-base font-semibold text-foreground" numberOfLines={1}>
            {series.title}
          </Text>
          <View className="flex-row items-center gap-1 rounded-full bg-muted px-2 py-0.5">
            <VisibilityIcon size={10} className="text-muted-foreground" />
            <Text className="text-[10px] font-medium text-muted-foreground">
              {visibility.label}
            </Text>
          </View>
        </View>

        <Text className="text-sm text-muted-foreground" numberOfLines={1}>
          {byline}
        </Text>

        <Text className="text-xs capitalize text-muted-foreground" numberOfLines={1}>
          {formatEpisodeCount(episodeCount)} · {series.format}
        </Text>
      </View>

      <ChevronRight size={20} className="text-muted-foreground" />
    </Pressable>
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

  const openSeries = useCallback((id: string) => router.push(`/(app)/shows/${id}`), [router]);

  const renderItem = useCallback(
    ({ item }: { item: ShowSeries }) => (
      <View className="pb-3">
        <SeriesRow series={item} onOpen={openSeries} />
      </View>
    ),
    [openSeries],
  );

  const isEmpty = !loading && series.length === 0;

  return (
    <ContentPanel surfaceClassName="bg-background">
      <View className="flex-1 bg-background">
        <FlatList
          data={loading && series.length === 0 ? [] : series}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <View className="pb-3 pt-6">
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-2xl font-bold text-foreground">Shows</Text>
                <Button
                  size="sm"
                  className="flex-row items-center gap-1.5 rounded-full"
                  onPress={() => setCreateOpen(true)}
                >
                  <Plus size={14} className="text-primary-foreground" />
                  <Text className="text-sm text-primary-foreground">New</Text>
                </Button>
              </View>
              <Text className="mt-0.5 text-[13px] text-muted-foreground">
                Podcasts Alia writes, voices and publishes to Syra.
              </Text>

              {error ? (
                <View className="mt-3 rounded-lg bg-destructive/10 p-2">
                  <Text className="text-xs text-destructive">{error}</Text>
                </View>
              ) : null}

              {loading && series.length === 0 ? (
                <View className="gap-3 pt-4">
                  {[1, 2, 3].map((key) => (
                    <View
                      key={key}
                      className="flex-row items-center gap-4 rounded-2xl border border-border p-3"
                    >
                      <Skeleton className="h-16 w-16 rounded-xl" />
                      <View className="flex-1 gap-2">
                        <Skeleton className="h-4 w-2/3 rounded" />
                        <Skeleton className="h-3 w-1/2 rounded" />
                        <Skeleton className="h-3 w-1/3 rounded" />
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            isEmpty ? (
              <View className="items-center gap-4 px-4 py-16">
                <View className="h-20 w-20 items-center justify-center rounded-2xl bg-muted">
                  <Mic size={32} className="text-muted-foreground" />
                </View>
                <Text className="text-center text-lg font-semibold text-foreground">
                  No shows yet
                </Text>
                <Text className="text-center text-sm text-muted-foreground">
                  Start a show and Alia will write, voice and publish each episode to Syra — where
                  it becomes a real podcast you can share or keep to yourself.
                </Text>
                <Button
                  onPress={() => setCreateOpen(true)}
                  className="flex-row items-center gap-1.5 rounded-full"
                >
                  <Plus size={14} className="text-primary-foreground" />
                  <Text className="text-primary-foreground">Start a show</Text>
                </Button>
              </View>
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
        />
      </View>

      <SeriesCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={openSeries} />
    </ContentPanel>
  );
}
