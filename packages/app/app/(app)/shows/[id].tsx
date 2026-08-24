/**
 * One show, and its episodes.
 *
 * The screen where "give me another episode" lives — which is the whole point
 * of a series, and the thing a one-off show could not offer.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, RefreshControl, FlatList, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import {
  Plus,
  Trash2,
  AlertCircle,
  CheckCircle,
  ChevronLeft,
  ExternalLink,
  Lock,
  Link2,
  Globe,
} from 'lucide-react-native';
import { toast } from '@oxyhq/bloom/toast';
import { ContentPanel } from '@oxyhq/bloom/content-panel';
import {
  useShowStore,
  useSeriesEpisodes,
  ACTIVE_EPISODE_STATUSES,
  type ShowEpisode,
  type ShowEpisodeStatus,
  type ShowVisibility,
} from '@/lib/stores/show-store';
import { EpisodeProgressCard } from '@/components/show/episode-progress';
import { EpisodePlayer } from '@/components/show/episode-player';
import { EpisodeCreateDialog } from '@/components/show/episode-create-dialog';
import { useShowProgress } from '@/lib/hooks/use-show-progress';
import { useColorScheme } from '@/lib/useColorScheme';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Where a listener would go to see the podcast itself. */
const SYRA_WEB_URL = 'https://syra.fm';

const STATUS_LABEL: Record<ShowEpisodeStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: 'text-muted-foreground' },
  generating_script: { label: 'Writing', color: 'text-blue-500' },
  generating_audio: { label: 'Recording', color: 'text-blue-500' },
  concatenating: { label: 'Assembling', color: 'text-blue-500' },
  publishing: { label: 'Publishing', color: 'text-blue-500' },
  completed: { label: 'Ready', color: 'text-green-500' },
  failed: { label: 'Failed', color: 'text-red-500' },
};

const VISIBILITY_ICON: Record<ShowVisibility, typeof Lock> = {
  private: Lock,
  unlisted: Link2,
  public: Globe,
};

function EpisodeRow({
  episode,
  onDelete,
}: {
  episode: ShowEpisode;
  onDelete: (episodeId: string) => void;
}) {
  const progress = useShowStore((s) => s.activeGenerations.get(episode.id));
  const isActive = ACTIVE_EPISODE_STATUSES.includes(episode.status);
  const status = STATUS_LABEL[episode.status];

  return (
    <ContentPanel surfaceClassName="bg-background">
      <View className="gap-3 rounded-xl border border-border bg-card p-4">
        <View className="flex-row items-start justify-between gap-2">
          <View className="flex-1 gap-1">
            <Text className="text-xs text-muted-foreground">Episode {episode.episodeNumber}</Text>
            <Text className="text-base font-semibold text-foreground" numberOfLines={2}>
              {episode.title}
            </Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={2}>
              {episode.topic}
            </Text>
          </View>
          <View className="ml-2 flex-row items-center gap-1.5">
            {episode.status === 'completed' && (
              <CheckCircle size={14} className="text-green-500" />
            )}
            {episode.status === 'failed' && <AlertCircle size={14} className="text-red-500" />}
            <Text className={cn('text-xs font-medium', status.color)}>{status.label}</Text>
          </View>
        </View>

        {isActive && progress && <EpisodeProgressCard progress={progress} />}

        {episode.status === 'completed' && episode.syraEpisodeId && (
          <EpisodePlayer
            syraEpisodeId={episode.syraEpisodeId}
            title={episode.title}
            durationMs={episode.durationMs}
          />
        )}

        {episode.status === 'failed' && episode.error && (
          <View className="rounded-lg bg-destructive/10 p-2">
            <Text className="text-xs text-destructive">{episode.error}</Text>
          </View>
        )}

        <View className="flex-row items-center justify-between">
          {episode.creditsCharged ? (
            <Text className="text-xs text-muted-foreground">
              {episode.creditsCharged} credits
            </Text>
          ) : (
            <View />
          )}
          <Pressable
            onPress={() => onDelete(episode.id)}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${episode.title}`}
            className="p-2 active:opacity-70"
          >
            <Trash2 size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>
    </ContentPanel>
  );
}

export default function SeriesDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const seriesId = typeof id === 'string' ? id : '';
  const router = useRouter();
  const { colors } = useColorScheme();

  const series = useShowStore((s) => s.series.find((entry) => entry.id === seriesId));
  const episodes = useSeriesEpisodes(seriesId);
  const fetchOneSeries = useShowStore((s) => s.fetchOneSeries);
  const deleteEpisode = useShowStore((s) => s.deleteEpisode);
  const deleteSeries = useShowStore((s) => s.deleteSeries);

  useShowProgress();

  const [createOpen, setCreateOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (seriesId === '') return;
    void fetchOneSeries(seriesId);
  }, [seriesId, fetchOneSeries]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOneSeries(seriesId);
    setRefreshing(false);
  }, [fetchOneSeries, seriesId]);

  const handleDeleteEpisode = useCallback(
    (episodeId: string) => {
      void deleteEpisode(seriesId, episodeId);
      // Precise about what happened: the recording is published on Syra and
      // stays there, and a message that said "deleted" would be a lie a user
      // discovers later.
      toast.success('Removed from Alia — the episode stays on Syra');
    },
    [deleteEpisode, seriesId],
  );

  const handleDeleteSeries = useCallback(() => {
    void deleteSeries(seriesId);
    toast.success('Removed from Alia — the podcast stays on Syra');
    router.back();
  }, [deleteSeries, seriesId, router]);

  const openOnSyra = useCallback(() => {
    if (!series) return;
    void Linking.openURL(`${SYRA_WEB_URL}/podcasts/${series.syraPodcastId}`);
  }, [series]);

  const renderItem = useCallback(
    ({ item }: { item: ShowEpisode }) => (
      <View className="px-4 pb-3">
        <EpisodeRow episode={item} onDelete={handleDeleteEpisode} />
      </View>
    ),
    [handleDeleteEpisode],
  );

  if (!series) {
    return (
      <View className="flex-1 gap-3 bg-background px-4 pt-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </View>
    );
  }

  const VisibilityIcon = VISIBILITY_ICON[series.visibility];

  return (
    <View className="flex-1 bg-background">
      <View className="gap-3 px-4 pb-2 pt-4">
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back to shows"
            className="p-1 active:opacity-70"
          >
            <ChevronLeft size={20} className="text-foreground" />
          </Pressable>
          <Text className="flex-1 text-xl font-bold text-foreground" numberOfLines={1}>
            {series.title}
          </Text>
          <Button
            size="sm"
            className="flex-row items-center gap-1.5"
            onPress={() => setCreateOpen(true)}
          >
            <Plus size={14} className="text-primary-foreground" />
            <Text className="text-sm text-primary-foreground">Episode</Text>
          </Button>
        </View>

        <Text className="text-xs text-muted-foreground">{series.brief}</Text>

        <View className="flex-row flex-wrap items-center gap-3">
          <View className="flex-row items-center gap-1">
            <VisibilityIcon size={12} className="text-muted-foreground" />
            <Text className="text-xs capitalize text-muted-foreground">{series.visibility}</Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            {series.speakers.map((speaker) => speaker.name).join(', ')}
          </Text>
          <Pressable
            onPress={openOnSyra}
            accessibilityRole="link"
            accessibilityLabel="Open this podcast on Syra"
            className="flex-row items-center gap-1 active:opacity-70"
          >
            <ExternalLink size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">Open on Syra</Text>
          </Pressable>
        </View>
      </View>

      {episodes.length === 0 ? (
        <View className="flex-1 items-center justify-center gap-4 px-8">
          <Text className="text-center text-lg font-semibold text-foreground">
            No episodes yet
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            Say what the first one should cover, and Alia will write it, voice it with{' '}
            {series.speakers.map((speaker) => speaker.name).join(' and ')}, and publish it.
          </Text>
          <Button onPress={() => setCreateOpen(true)} className="flex-row items-center gap-1.5">
            <Plus size={14} className="text-primary-foreground" />
            <Text className="text-primary-foreground">Record the first episode</Text>
          </Button>
        </View>
      ) : (
        <FlatList
          data={episodes}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingTop: 8, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          ListFooterComponent={
            <View className="px-4 pt-4">
              <Pressable
                onPress={handleDeleteSeries}
                accessibilityRole="button"
                accessibilityLabel="Remove this show from Alia"
                className="flex-row items-center justify-center gap-1.5 p-2 active:opacity-70"
              >
                <Trash2 size={14} className="text-destructive" />
                <Text className="text-xs text-destructive">Remove this show from Alia</Text>
              </Pressable>
            </View>
          }
        />
      )}

      <EpisodeCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        seriesId={seriesId}
        nextEpisodeNumber={series.nextEpisodeNumber}
      />
    </View>
  );
}
