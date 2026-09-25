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

import { SeriesCreateDialog } from '@/components/show/series-create-dialog';
import { ShowArtwork } from '@/components/show/show-artwork';
import { useShowProgress } from '@/lib/hooks/use-show-progress';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  useShowStore,
  type ShowSeries,
  type ShowVisibility,
} from '@/lib/stores/show-store';
import { formatEpisodeCount } from '@/lib/utils/show-format';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge, type BadgeIcon } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiLink } from '@oxy.so/bloom/icons/RiLink';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { Item } from '@oxy.so/bloom/item';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

/** Who can hear it, as an icon and a word (an i18n key). */
const VISIBILITY: Record<ShowVisibility, { label: string; icon: BadgeIcon }> = {
  private: { label: 'shows.visibility.private.label', icon: RiLockLine },
  unlisted: { label: 'shows.visibility.unlisted.label', icon: RiLink },
  public: { label: 'shows.visibility.public.label', icon: RiGlobalLine },
};

function SeriesRow({
  series,
  onOpen,
}: {
  series: ShowSeries;
  onOpen: (id: string) => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const visibility = VISIBILITY[series.visibility];
  // `nextEpisodeNumber` counts from 1, so it is one past however many have been
  // started — which is what a person means by "how many episodes".
  const episodeCount = series.nextEpisodeNumber - 1;
  // Syra names a show's author under its title. Alia's author is its cast; a
  // series with no cast yet falls back to what the show is about.
  const byline =
    series.speakers.map((speaker) => speaker.name).join(', ') || series.brief;

  return (
    <Card
      appearance="outline"
      onPress={() => onOpen(series.id)}
      accessibilityRole="button"
      accessibilityLabel={t('shows.openSeries', { title: series.title })}
    >
      <Item
        leading={
          <ShowArtwork
            assetId={series.coverImageAssetId}
            title={series.title}
            size={64}
            radius="radius-12"
            iconSize={26}
          />
        }
        title={series.title}
        subtitle={
          <>
            <Text
              numberOfLines={1}
              className="text-[13px] leading-[18px] text-muted-foreground"
            >
              {byline}
            </Text>
            <Text
              numberOfLines={1}
              className="text-xs text-muted-foreground"
            >
              {formatEpisodeCount(episodeCount, t)} ·{' '}
              {t(`shows.formatName.${series.format}.label`)}
            </Text>
          </>
        }
        trailing={
          // Stacking only: the visibility badge beside the chevron.
          <View className="flex-row items-center gap-2">
            <Badge
              size="label-small"
              variant="subtle"
              icon={visibility.icon}
              content={t(visibility.label)}
            />
            <RiArrowRightSLine
              width={20}
              height={20}
              fill={colors.textSecondary}
            />
          </View>
        }
      />
    </Card>
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
  const { colors } = useTheme();
  const { t } = useTranslation();

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
      <SeriesRow series={item} onOpen={openSeries} />
    ),
    [openSeries],
  );

  const isEmpty = !loading && series.length === 0;
  const startShow = () => setCreateOpen(true);

  /*
   * No surface, no title and no menu button: the layout's `AiChatContainer`
   * draws the page and its header, where this page puts its one action. The
   * page is its description and the list.
   */
  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Button
              tone="action"
              size="md"
              leadingIcon={RiAddLine}
              onPress={startShow}
            >
              {t('shows.new')}
            </Button>
          ),
        }}
      />
      <FlatList
        className="flex-1"
        data={loading && series.length === 0 ? [] : series}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        contentContainerClassName="gap-3 px-4 pb-6 pt-4"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          // Stacking only: the top row, the error and the placeholders.
          <View className="gap-3">
            <Muted>{t('shows.subtitle')}</Muted>

            {error ? <Admonition type="error">{error}</Admonition> : null}

            {loading && series.length === 0 ? (
              // Bars sized as the text they stand for: a 16px title line and
              // two 12px ones, each bar 0.7 of its line.
              <View className="gap-4 pt-1">
                {[1, 2, 3].map((key) => (
                  <View key={key} className="flex-row items-center gap-4">
                    <Skeleton.Box width={64} height={64} borderRadius={12} />
                    <View className="flex-1 gap-3">
                      <Skeleton.Box width="66%" height={11} />
                      <Skeleton.Box width="50%" height={8} />
                      <Skeleton.Box width="33%" height={8} />
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          isEmpty ? (
            <EmptyState
              icon={RiMic2Line}
              media="circle"
              title={t('shows.empty.title')}
              description={t('shows.empty.description')}
              action={{
                label: t('shows.empty.action'),
                icon: RiAddLine,
                onPress: startShow,
              }}
            />
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

      <SeriesCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={openSeries}
      />
    </>
  );
}
