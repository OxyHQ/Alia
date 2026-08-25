/**
 * One show, and its episodes — presented the way Syra presents a podcast.
 *
 * Syra's show page (`packages/frontend/app/podcasts/[id].tsx`) opens with a
 * hero: the cover at a real size, the title, who is on it, and the one action
 * that screen exists for, over a gradient that bleeds to the panel edges. Then
 * an expandable description, the credits, and the episode list under a plain
 * `Episodes` heading. Alia's series is a Syra podcast, so it gets the same
 * shape, rebuilt in Alia's own idiom rather than imported.
 *
 * What is deliberately NOT here: Syra's Subscribe toggle, which makes no sense
 * on a show you own; its cover-derived ambient theming, which needs colours
 * Syra extracts server-side and Alia's series row does not carry; and its
 * resume-progress bars, which need listening history Alia does not keep.
 *
 * The one action a Syra show page cannot offer is the one this screen exists
 * for: another episode.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable, RefreshControl, FlatList, Linking, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Plus, Trash2, ChevronLeft, ExternalLink, Lock, Link2, Globe } from 'lucide-react-native';
import { toast } from '@oxyhq/bloom/toast';
import { ContentPanel } from '@oxyhq/bloom/content-panel';
import { withAlpha } from '@oxyhq/bloom/theme';
import {
  useShowStore,
  useSeriesEpisodes,
  type ShowEpisode,
  type ShowVisibility,
} from '@/lib/stores/show-store';
import { EpisodeRow } from '@/components/show/episode-row';
import { ShowArtwork } from '@/components/show/show-artwork';
import { EpisodeCreateDialog } from '@/components/show/episode-create-dialog';
import { useShowProgress } from '@/lib/hooks/use-show-progress';
import { useColorScheme } from '@/lib/useColorScheme';
import { Skeleton } from '@/components/ui/skeleton';
import { formatEpisodeCount } from '@/lib/utils/show-format';

/** Where a listener would go to see the podcast itself. */
const SYRA_WEB_URL = 'https://syra.fm';

/**
 * Longer than this and the description is worth clamping. Syra shows its
 * expand toggle unconditionally; a show's brief is often two sentences, and a
 * "Show more" that reveals nothing is a control that looks broken.
 */
const DESCRIPTION_CLAMP_CHARS = 170;

/** Who can hear it, as an icon and a word. */
const VISIBILITY: Record<ShowVisibility, { label: string; icon: typeof Lock }> = {
  private: { label: 'Private', icon: Lock },
  unlisted: { label: 'Unlisted', icon: Link2 },
  public: { label: 'Public', icon: Globe },
};

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
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

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
      <View className="px-2">
        <EpisodeRow episode={item} onDelete={handleDeleteEpisode} />
      </View>
    ),
    [handleDeleteEpisode],
  );

  const hosts = useMemo(
    () => (series ? series.speakers.map((speaker) => speaker.name).join(', ') : ''),
    [series],
  );

  if (!series) {
    return (
      <ContentPanel surfaceClassName="bg-background">
        <View className="flex-1 gap-4 bg-background p-4">
          <View className="flex-row gap-4">
            <Skeleton className="h-28 w-28 rounded-2xl" />
            <View className="flex-1 justify-center gap-2">
              <Skeleton className="h-6 w-3/4 rounded-lg" />
              <Skeleton className="h-4 w-1/2 rounded-lg" />
              <Skeleton className="h-8 w-32 rounded-full" />
            </View>
          </View>
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </View>
      </ContentPanel>
    );
  }

  const visibility = VISIBILITY[series.visibility];
  const VisibilityIcon = visibility.icon;
  const description = series.description?.trim() || series.brief;
  const isClampable = description.length > DESCRIPTION_CLAMP_CHARS;

  const header = (
    <View>
      {/*
        Syra's hero bleeds a cover-derived gradient to the panel edges. Alia has
        no cover colours — Syra extracts those server-side and keeps them on its
        own podcast, not on the series row — so the wash is the app's own accent.
        It fades to a fully transparent BACKGROUND, never to `transparent`, which
        renders as black on some Android surfaces.
      */}
      <View className="overflow-hidden">
        <LinearGradient
          colors={[
            withAlpha(colors.primary, 0.14),
            withAlpha(colors.primary, 0.04),
            withAlpha(colors.background, 0),
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.6, y: 1 }}
          style={StyleSheet.absoluteFill}
        />

        <View className="flex-row items-center px-2 pt-3">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back to shows"
            className="h-9 w-9 items-center justify-center rounded-full active:opacity-70 web:hover:bg-muted"
          >
            <ChevronLeft size={20} className="text-foreground" />
          </Pressable>
        </View>

        <View className="flex-row gap-4 px-4 pb-6 pt-1 md:gap-5">
          <ShowArtwork
            assetId={series.coverImageAssetId}
            title={series.title}
            className="h-28 w-28 rounded-2xl md:h-36 md:w-36"
            iconSize={40}
          />

          <View className="min-w-0 flex-1 justify-center gap-1.5">
            <Text
              className="text-xl font-bold leading-7 text-foreground md:text-2xl md:leading-8"
              numberOfLines={3}
            >
              {series.title}
            </Text>

            {hosts ? (
              <Text className="text-sm text-muted-foreground" numberOfLines={2}>
                {hosts}
              </Text>
            ) : null}

            <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
              <View className="flex-row items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                <VisibilityIcon size={11} className="text-muted-foreground" />
                <Text className="text-[11px] font-medium text-muted-foreground">
                  {visibility.label}
                </Text>
              </View>
              <Text className="text-xs capitalize text-muted-foreground">{series.format}</Text>
              <Text className="text-xs text-muted-foreground">
                {formatEpisodeCount(episodes.length)}
              </Text>
            </View>

            <View className="flex-row flex-wrap items-center gap-2 pt-1.5">
              <Button
                size="sm"
                className="flex-row items-center gap-1.5 rounded-full"
                onPress={() => setCreateOpen(true)}
              >
                <Plus size={14} className="text-primary-foreground" />
                <Text className="text-sm text-primary-foreground">New episode</Text>
              </Button>
              <Pressable
                onPress={openOnSyra}
                accessibilityRole="link"
                accessibilityLabel="Open this podcast on Syra"
                className="h-8 flex-row items-center gap-1.5 rounded-full border border-border px-3 active:opacity-70 web:hover:bg-muted"
              >
                <ExternalLink size={13} className="text-muted-foreground" />
                <Text className="text-xs font-medium text-muted-foreground">Open on Syra</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>

      <Pressable
        onPress={() => setDescriptionExpanded((value) => !value)}
        disabled={!isClampable}
        accessibilityRole={isClampable ? 'button' : undefined}
        className="gap-1 px-4 pb-5"
      >
        <Text
          className="text-sm leading-5 text-muted-foreground"
          numberOfLines={descriptionExpanded || !isClampable ? undefined : 3}
        >
          {description}
        </Text>
        {isClampable ? (
          <Text className="text-[13px] font-semibold text-primary">
            {descriptionExpanded ? 'Show less' : 'Show more'}
          </Text>
        ) : null}
      </Pressable>

      {series.speakers.length > 0 ? (
        <View className="gap-3 px-4 pb-6">
          <Text className="text-base font-bold text-foreground">Hosts</Text>
          {series.speakers.map((speaker) => (
            <View key={`${speaker.name}-${speaker.voiceId}`} className="flex-row items-center gap-3">
              <Avatar className="h-11 w-11">
                <AvatarFallback>
                  <Text className="text-sm font-semibold text-muted-foreground">
                    {speaker.name.slice(0, 1).toUpperCase()}
                  </Text>
                </AvatarFallback>
              </Avatar>
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
                  {speaker.name}
                </Text>
                <Text className="text-[13px] capitalize text-muted-foreground" numberOfLines={1}>
                  {speaker.role} · {speaker.voiceName}
                </Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      <View className="flex-row items-baseline justify-between px-4 pb-1">
        <Text className="text-lg font-bold text-foreground">Episodes</Text>
        {episodes.length > 0 ? (
          <Text className="text-xs text-muted-foreground">
            {formatEpisodeCount(episodes.length)}
          </Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <ContentPanel surfaceClassName="bg-background">
      <View className="flex-1 bg-background">
        <FlatList
          data={episodes}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={header}
          ListEmptyComponent={
            <View className="items-center gap-3 px-8 py-12">
              <Text className="text-center text-base font-semibold text-foreground">
                No episodes yet
              </Text>
              <Text className="text-center text-sm text-muted-foreground">
                Say what the first one should cover, and Alia will write it, voice it with{' '}
                {series.speakers.map((speaker) => speaker.name).join(' and ')}, and publish it.
              </Text>
              <Button
                onPress={() => setCreateOpen(true)}
                className="flex-row items-center gap-1.5 rounded-full"
              >
                <Plus size={14} className="text-primary-foreground" />
                <Text className="text-primary-foreground">Record the first episode</Text>
              </Button>
            </View>
          }
          ListFooterComponent={
            <View className="px-4 pt-6">
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
          contentContainerStyle={{ paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
        />
      </View>

      <EpisodeCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        seriesId={seriesId}
        nextEpisodeNumber={series.nextEpisodeNumber}
      />
    </ContentPanel>
  );
}
