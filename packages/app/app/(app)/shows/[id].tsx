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
 * resume-progress bars, which need listening history Alia does not keep; and
 * the hero's gradient wash, because the page's surface is the app layout's
 * (`AiChatContainer`) and a page paints no background of its own.
 *
 * The one action a Syra show page cannot offer is the one this screen exists
 * for: another episode.
 */

import { EpisodeCreateDialog } from '@/components/show/episode-create-dialog';
import { EpisodeRow } from '@/components/show/episode-row';
import { ShowArtwork } from '@/components/show/show-artwork';
import { useShowProgress } from '@/lib/hooks/use-show-progress';
import {
  useSeriesEpisodes,
  useShowStore,
  type ShowEpisode,
  type ShowVisibility,
} from '@/lib/stores/show-store';
import { formatEpisodeCount } from '@/lib/utils/show-format';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge, type BadgeIcon } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiArrowLeftSLine } from '@oxy.so/bloom/icons/RiArrowLeftSLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiLink } from '@oxy.so/bloom/icons/RiLink';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiPencilLine } from '@oxy.so/bloom/icons/RiPencilLine';
import { Item } from '@oxy.so/bloom/item';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { H5, Muted, Text } from '@oxy.so/bloom/typography';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Linking, RefreshControl, View } from 'react-native';

/** Where a listener would go to see the podcast itself. */
const SYRA_WEB_URL = 'https://syra.fm';

/**
 * Longer than this and the description is worth clamping. Syra shows its
 * expand toggle unconditionally; a show's brief is often two sentences, and a
 * "Show more" that reveals nothing is a control that looks broken.
 */
const DESCRIPTION_CLAMP_CHARS = 170;

/** Who can hear it, as an icon and a word. */
const VISIBILITY: Record<ShowVisibility, { label: string; icon: BadgeIcon }> = {
  private: { label: 'Private', icon: RiLockLine },
  unlisted: { label: 'Unlisted', icon: RiLink },
  public: { label: 'Public', icon: RiGlobalLine },
};

export default function SeriesDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const seriesId = typeof id === 'string' ? id : '';
  const router = useRouter();
  const { colors } = useTheme();

  const series = useShowStore((s) =>
    s.series.find((entry) => entry.id === seriesId),
  );
  const episodes = useSeriesEpisodes(seriesId);
  const fetchOneSeries = useShowStore((s) => s.fetchOneSeries);
  const createEpisode = useShowStore((s) => s.createEpisode);
  const deleteEpisode = useShowStore((s) => s.deleteEpisode);
  const deleteSeries = useShowStore((s) => s.deleteSeries);

  useShowProgress();

  const [createOpen, setCreateOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  useEffect(() => {
    if (seriesId === '') return;
    void fetchOneSeries(seriesId);
  }, [seriesId, fetchOneSeries]);

  /**
   * The whole action: another episode, please.
   *
   * Nothing to fill in, because there is nothing this screen knows that the
   * show does not — the brief says what it is about and the earlier episodes
   * say what it has already covered. `starting` is what stops an impatient
   * second press queueing a second episode against the three-at-once cap.
   */
  const handleNewEpisode = useCallback(async () => {
    setStarting(true);
    try {
      const episodeId = await createEpisode(seriesId);
      if (episodeId) toast.success('Recording started');
    } finally {
      setStarting(false);
    }
  }, [createEpisode, seriesId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchOneSeries(seriesId);
    setRefreshing(false);
  }, [fetchOneSeries, seriesId]);

  /**
   * Removing an episode, and saying only what actually happened.
   *
   * Two things this used to get wrong, and both told a person something untrue
   * about their own recording. It asked nothing before acting, on a button
   * whose whole affordance is a red bin; and it toasted "removed" in the same
   * tick it started the request, so a delete that failed still reported
   * success while the row it names sat there.
   *
   * What it now DOES do is remove the recording from Syra as well, so the copy
   * had to change with it: this is no longer "Alia forgets", it is a delete,
   * and the confirmation says so BEFORE the press rather than in a toast
   * afterwards — see the note on `handleDeleteSeries`.
   */
  const handleDeleteEpisode = useCallback(
    async (episodeId: string) => {
      const ok = await confirm({
        title: 'Delete this episode everywhere?',
        description:
          'The recording is deleted from Syra too, along with its audio and every listener saved place in it. This cannot be undone.',
        confirmLabel: 'Delete everywhere',
        cancelLabel: 'Cancel',
        destructive: true,
      });
      if (!ok) return;

      const removed = await deleteEpisode(seriesId, episodeId);
      if (!removed) {
        toast.error(
          useShowStore.getState().error ?? 'Could not remove the episode',
        );
        return;
      }
      toast.success('Episode deleted from Alia and Syra');
    },
    [deleteEpisode, seriesId],
  );

  /**
   * Removing the show, and NOT leaving the screen until it is actually gone.
   *
   * `router.back()` used to fire beside an unconditional success toast, so a
   * failed delete navigated away from the show it had not removed — the person
   * was told it was gone, and found it again on the next visit.
   *
   * The confirmation names what is destroyed, because this button now means
   * what "delete" means. Syra deletes first and Alia only forgets what Syra
   * let go of, so a person who presses this ends with the show gone from both
   * — never gone from one and alive in the other, which is the orphan this
   * replaced. The copy says "everywhere" at the moment of the decision rather
   * than reporting it afterwards.
   */
  const handleDeleteSeries = useCallback(async () => {
    const ok = await confirm({
      title: 'Delete this show everywhere?',
      description:
        'The podcast is deleted from Syra too, with every episode, all of their audio, and everyone subscribed to it. This cannot be undone.',
      confirmLabel: 'Delete everywhere',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;

    const removed = await deleteSeries(seriesId);
    if (!removed) {
      toast.error(useShowStore.getState().error ?? 'Could not remove the show');
      return;
    }
    toast.success('Show deleted from Alia and Syra');
    router.back();
  }, [deleteSeries, seriesId, router]);

  const openOnSyra = useCallback(() => {
    if (!series) return;
    void Linking.openURL(`${SYRA_WEB_URL}/podcasts/${series.syraPodcastId}`);
  }, [series]);

  const renderItem = useCallback(
    ({ item }: { item: ShowEpisode }) => (
      <EpisodeRow episode={item} onDelete={handleDeleteEpisode} />
    ),
    [handleDeleteEpisode],
  );

  const hosts = useMemo(
    () =>
      series ? series.speakers.map((speaker) => speaker.name).join(', ') : '',
    [series],
  );

  if (!series) {
    return (
      <Skeleton.Col style={{ flex: 1, gap: 16, padding: 16 }}>
        <Skeleton.Row style={{ gap: 16 }}>
          <Skeleton.Box width={112} height={112} borderRadius={16} />
          <Skeleton.Col style={{ flex: 1, justifyContent: 'center', gap: 8 }}>
            <Skeleton.Text style={{ width: '75%', lineHeight: 24 }} />
            <Skeleton.Text style={{ width: '50%', lineHeight: 16 }} />
            <Skeleton.Pill size={32} />
          </Skeleton.Col>
        </Skeleton.Row>
        <Skeleton.Box width="100%" height={56} />
        <Skeleton.Box width="100%" height={64} />
      </Skeleton.Col>
    );
  }

  const visibility = VISIBILITY[series.visibility];
  const VisibilityIcon = visibility.icon;
  const description = series.description?.trim() || series.brief;
  const isClampable = description.length > DESCRIPTION_CLAMP_CHARS;

  const secondary = { color: colors.textSecondary };

  /*
   * No surface and no wash of its own: the layout's `AiChatContainer` paints
   * the page and carries the "Shows" crumb. The show's own title stays — it is
   * content, not the page's name.
   */
  const header = (
    // Stacking only: the hero, the description, the hosts and the heading.
    <View style={{ gap: 20, paddingBottom: 4 }}>
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          tone="neutral"
          appearance="plain"
          size="sm"
          icon={RiArrowLeftSLine}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to shows"
        />
      </View>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        <ShowArtwork
          assetId={series.coverImageAssetId}
          title={series.title}
          size={112}
          radius="radius-16"
          iconSize={40}
        />

        <View style={{ minWidth: 0, flex: 1, justifyContent: 'center', gap: 6 }}>
          <Text variant="title-2-bold" numberOfLines={3}>
            {series.title}
          </Text>

          {hosts ? <Muted numberOfLines={2}>{hosts}</Muted> : null}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Badge
              size="label-small"
              variant="subtle"
              icon={visibility.icon}
              content={visibility.label}
            />
            <Text variant="caption-1-regular" style={[secondary, { textTransform: 'capitalize' }]}>
              {series.format}
            </Text>
            <Text variant="caption-1-regular" style={secondary}>
              {formatEpisodeCount(episodes.length)}
            </Text>
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 6 }}>
            <Button
              tone="action"
              size="sm"
              leadingIcon={RiAddLine}
              onPress={handleNewEpisode}
              disabled={starting}
            >
              {starting ? 'Starting...' : 'New episode'}
            </Button>
            {/*
              The other case, kept and kept QUIET: usually there is nothing
              specific to say, and occasionally there is an article to work
              from or a subject that will not wait.
            */}
            <Button
              tone="neutral"
              appearance="outline"
              size="sm"
              leadingIcon={RiPencilLine}
              onPress={() => setCreateOpen(true)}
              disabled={starting}
              accessibilityRole="button"
              accessibilityLabel="Say what this episode should cover"
            >
              Something specific
            </Button>
            <Button
              tone="neutral"
              appearance="outline"
              size="sm"
              leadingIcon={RiExternalLinkLine}
              onPress={openOnSyra}
              accessibilityRole="link"
              accessibilityLabel="Open this podcast on Syra"
            >
              Open on Syra
            </Button>
          </View>
        </View>
      </View>

      <View style={{ alignItems: 'flex-start', gap: 4 }}>
        <Text
          variant="body-regular"
          style={secondary}
          numberOfLines={descriptionExpanded || !isClampable ? undefined : 3}
        >
          {description}
        </Text>
        {isClampable ? (
          <Button
            tone="accent"
            appearance="plain"
            size="xs"
            onPress={() => setDescriptionExpanded((value) => !value)}
          >
            {descriptionExpanded ? 'Show less' : 'Show more'}
          </Button>
        ) : null}
      </View>

      {series.speakers.length > 0 ? (
        <View style={{ gap: 4 }}>
          <H5>Hosts</H5>
          {series.speakers.map((speaker) => (
            <Item
              key={`${speaker.name}-${speaker.voiceId}`}
              role="listitem"
              leading={
                // A host has no photo anywhere in the Shows model; Bloom's
                // Avatar derives the initial and clears AA in either mode.
                // `color="neutral"` keeps the quiet grey rather than tinting
                // the disc per host, which is a product decision.
                <Avatar name={speaker.name} size={44} color="neutral" />
              }
              title={speaker.name}
              subtitle={`${speaker.role} · ${speaker.voiceName}`}
              subtitleStyle={{ textTransform: 'capitalize' }}
            />
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <H5>Episodes</H5>
        {episodes.length > 0 ? (
          <Text variant="caption-1-regular" style={secondary}>
            {formatEpisodeCount(episodes.length)}
          </Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <>
      <FlatList
        style={{ flex: 1 }}
        data={episodes}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <EmptyState
            title="No episodes yet"
            description={`Alia will work out what the first one covers from what this show is about, write it, voice it with ${series.speakers
              .map((speaker) => speaker.name)
              .join(' and ')}, and publish it.`}
            action={{
              label: starting ? 'Starting...' : 'Record the first episode',
              icon: RiAddLine,
              onPress: handleNewEpisode,
              disabled: starting,
            }}
            secondaryAction={{
              label: 'Or say what it should cover',
              onPress: () => setCreateOpen(true),
              disabled: starting,
              accessibilityLabel: 'Say what the first episode should cover',
            }}
          />
        }
        ListFooterComponent={
          <View style={{ alignItems: 'center', paddingTop: 24 }}>
            <Button
              tone="danger"
              appearance="plain"
              size="sm"
              leadingIcon={RiDeleteBinLine}
              onPress={handleDeleteSeries}
              accessibilityRole="button"
              accessibilityLabel="Remove this show from Alia"
            >
              Remove this show from Alia
            </Button>
          </View>
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 32,
          gap: 4,
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      />

      <EpisodeCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        seriesId={seriesId}
        nextEpisodeNumber={series.nextEpisodeNumber}
      />
    </>
  );
}
