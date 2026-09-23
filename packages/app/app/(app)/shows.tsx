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
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

/** Who can hear it, as an icon and a word. */
const VISIBILITY: Record<ShowVisibility, { label: string; icon: BadgeIcon }> = {
  private: { label: 'Private', icon: RiLockLine },
  unlisted: { label: 'Unlisted', icon: RiLink },
  public: { label: 'Public', icon: RiGlobalLine },
};

function SeriesRow({
  series,
  onOpen,
}: {
  series: ShowSeries;
  onOpen: (id: string) => void;
}) {
  const { colors } = useTheme();
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
      accessibilityLabel={`Open ${series.title}`}
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
            <Text variant="body-2-regular" numberOfLines={1} style={{ color: colors.textSecondary }}>
              {byline}
            </Text>
            <Text
              variant="caption-1-regular"
              numberOfLines={1}
              style={{ color: colors.textSecondary, textTransform: 'capitalize' }}
            >
              {formatEpisodeCount(episodeCount)} · {series.format}
            </Text>
          </>
        }
        trailing={
          // Stacking only: the visibility badge beside the chevron.
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Badge
              size="label-small"
              variant="subtle"
              icon={visibility.icon}
              content={visibility.label}
            />
            <RiArrowRightSLine width={20} height={20} fill={colors.textSecondary} />
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
   * draws the page, its "Shows" crumb and the mobile header. The page is its
   * description, its one action, and the list.
   */
  return (
    <>
      <FlatList
        style={{ flex: 1 }}
        data={loading && series.length === 0 ? [] : series}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 24,
          gap: 12,
        }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          // Stacking only: the top row, the error and the placeholders.
          <View style={{ gap: 12 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <Muted style={{ flex: 1 }}>
                Podcasts Alia writes, voices and publishes to Syra.
              </Muted>
              <Button
                tone="action"
                size="sm"
                leadingIcon={RiAddLine}
                onPress={startShow}
              >
                New
              </Button>
            </View>

            {error ? <Admonition type="error">{error}</Admonition> : null}

            {loading && series.length === 0 ? (
              <Skeleton.Col style={{ gap: 16, paddingTop: 4 }}>
                {[1, 2, 3].map((key) => (
                  <Skeleton.Row key={key} style={{ gap: 16, alignItems: 'center' }}>
                    <Skeleton.Box width={64} height={64} borderRadius={12} />
                    <Skeleton.Col style={{ flex: 1, gap: 8 }}>
                      <Skeleton.Text style={{ width: '66%', lineHeight: 16 }} />
                      <Skeleton.Text style={{ width: '50%', lineHeight: 12 }} />
                      <Skeleton.Text style={{ width: '33%', lineHeight: 12 }} />
                    </Skeleton.Col>
                  </Skeleton.Row>
                ))}
              </Skeleton.Col>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          isEmpty ? (
            <EmptyState
              icon={RiMic2Line}
              media="circle"
              title="No shows yet"
              description="Start a show and Alia will write, voice and publish each episode to Syra — where it becomes a real podcast you can share or keep to yourself."
              action={{ label: 'Start a show', icon: RiAddLine, onPress: startShow }}
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
