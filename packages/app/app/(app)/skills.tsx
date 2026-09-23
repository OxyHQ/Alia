import { SkillCover } from '@/components/ui/skill-cover';
import {
  useInstallSkill,
  useInstalledSkills,
  useSkillCataloguePages,
  type InstalledSkill,
  type Skill,
} from '@/lib/hooks/use-skills';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiDownloadLine } from '@oxy.so/bloom/icons/RiDownloadLine';
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

/**
 * The Skills catalogue.
 *
 * Two questions, kept apart because they are different: what EXISTS (the
 * catalogue, which anybody can browse) and what this account has INSTALLED,
 * which is the only thing the model can reach.
 *
 * What this screen mounts is bounded, on purpose (#545). The catalogue arrives
 * a page at a time; each shelf is a horizontal FlashList that mounts only the
 * books within `drawDistance` of the viewport; a skill on the shelf appears on
 * the Installed shelf ONLY, never a second time in its catalogue row; and every
 * cover is the static grid — no canvas, no clock, no blur. The animated cover
 * is the detail page's one opt-in.
 */

const BOOK_WIDTH = 110;
const BOOK_GAP = 10;
/** Cover (2:3) + the gap below it + the install button. FlashList needs the height. */
const SHELF_HEIGHT = BOOK_WIDTH * 1.5 + 6 + 28;
/** How far past the viewport edge a shelf pre-mounts: about two books. */
const SHELF_DRAW_DISTANCE = (BOOK_WIDTH + BOOK_GAP) * 2;
/** Typing pauses this long before a keystroke becomes a request. */
const SEARCH_DEBOUNCE_MS = 250;

/** Stacking only: the page's side gutter, shared by the header and the shelves. */
const GUTTER = { paddingHorizontal: 16 } as const;
/** Stacking only: the header block above the shelves. */
const HEADER = { ...GUTTER, paddingTop: 16, gap: 12 } as const;
/** Stacking only: the header's action row. */
const ACTIONS = { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 } as const;
/** Stacking only: one shelf, its title above its books. */
const SECTION = { gap: 8 } as const;
/** Stacking only: the shelves, one under the other. */
const SHELVES = { paddingTop: 20, paddingBottom: 32, gap: 20 } as const;
/** Stacking only: a book, its cover over its install button. */
const BOOK = { width: BOOK_WIDTH, marginRight: BOOK_GAP, gap: 6, alignItems: 'center' } as const;

/**
 * The server's `query` filter, applied locally to the installed shelf: an
 * `ilike` on name, display name and description. The installed list is not
 * searched server-side, and a shelf that ignored the search box while the
 * others obeyed it would look like results.
 */
function matchesQuery(skill: Skill, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    skill.name.toLowerCase().includes(needle) ||
    skill.displayName.toLowerCase().includes(needle) ||
    skill.description.toLowerCase().includes(needle)
  );
}

function SkillBook({
  skill,
  installed,
  onPress,
  onInstall,
}: {
  skill: Skill;
  installed: boolean;
  onPress: () => void;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={BOOK}>
      {/* The cover is the skill's own artwork, not a control, so the press
          around it is a bare `Pressable`: Bloom's `PressableScale` animates
          through reanimated, which the shelf must not load (#545). */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={skill.displayName}
        onPress={onPress}
      >
        <SkillCover
          seed={skill.name}
          width={BOOK_WIDTH}
          color={skill.color ?? undefined}
          title={skill.displayName}
          author={skill.publisher ?? undefined}
          updatedAt={skill.updatedAt}
        />
      </Pressable>
      <Button
        size="xs"
        tone="neutral"
        appearance={installed ? 'plain' : 'subtle'}
        icon={installed ? RiCheckLine : RiDownloadLine}
        accessibilityLabel={
          installed
            ? t('pages.skills.installedSkill', { name: skill.displayName })
            : t('pages.skills.installSkill', { name: skill.displayName })
        }
        disabled={installed}
        onPress={onInstall}
      />
    </View>
  );
}

function Shelf({
  title,
  skills,
  installedIds,
  onPressSkill,
  onInstall,
  onEndReached,
}: {
  title: string;
  skills: Skill[];
  installedIds: Set<string>;
  onPressSkill: (name: string) => void;
  onInstall: (id: string) => void;
  /** Reaching the end of a catalogue shelf asks for the next page. */
  onEndReached?: () => void;
}) {
  const renderItem = useCallback(
    ({ item }: { item: Skill }) => (
      <SkillBook
        skill={item}
        installed={installedIds.has(item._id)}
        onPress={() => onPressSkill(item.name)}
        onInstall={() => onInstall(item._id)}
      />
    ),
    [installedIds, onPressSkill, onInstall],
  );

  if (skills.length === 0) return null;
  return (
    <View style={SECTION}>
      <Text variant="headline-semibold" style={GUTTER}>
        {title}
      </Text>
      {/* A horizontal list needs its height from outside; the books are all one size. */}
      <View style={{ height: SHELF_HEIGHT }}>
        <FlashList
          horizontal
          data={skills}
          keyExtractor={(skill) => skill._id}
          renderItem={renderItem}
          extraData={installedIds}
          drawDistance={SHELF_DRAW_DISTANCE}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={GUTTER}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
        />
      </View>
    </View>
  );
}

export default function SkillsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [search, setSearch] = useState('');
  /** What the catalogue is actually asked for: `search`, once typing has paused. */
  const [query, setQuery] = useState('');

  // Clearing the box answers at once; typing waits. A request per keystroke is
  // a page of covers per keystroke.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === '') {
      setQuery('');
      return;
    }
    const timer = setTimeout(() => setQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const catalogue = useSkillCataloguePages(query ? { query } : {});
  const installed = useInstalledSkills();
  const install = useInstallSkill();

  const installedIds = useMemo(
    () =>
      new Set((installed.data ?? []).map((skill: InstalledSkill) => skill._id)),
    [installed.data],
  );

  const skills = useMemo(
    () => catalogue.data?.pages.flat() ?? [],
    [catalogue.data],
  );
  // An installed skill lives on the Installed shelf and nowhere else on this
  // screen: the same book twice is twice the covers for no information.
  const official = useMemo(
    () =>
      skills.filter(
        (skill) =>
          !installedIds.has(skill._id) &&
          (skill.source === 'builtin' || skill.source === 'registry'),
      ),
    [skills, installedIds],
  );
  const community = useMemo(
    () =>
      skills.filter(
        (skill) =>
          !installedIds.has(skill._id) &&
          skill.source !== 'builtin' &&
          skill.source !== 'registry',
      ),
    [skills, installedIds],
  );
  const installedShelf = useMemo(
    () => (installed.data ?? []).filter((skill) => matchesQuery(skill, query)),
    [installed.data, query],
  );

  const openSkill = useCallback(
    (name: string) => router.push(`/(app)/skills/${name}`),
    [router],
  );
  const installSkill = useCallback(
    (id: string) => install.mutate(id),
    [install],
  );
  const loadMore = useCallback(() => {
    if (catalogue.hasNextPage && !catalogue.isFetchingNextPage)
      void catalogue.fetchNextPage();
  }, [catalogue]);

  const nothingToShow = skills.length === 0 && installedShelf.length === 0;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={
            catalogue.isFetching &&
            !catalogue.isLoading &&
            !catalogue.isFetchingNextPage
          }
          onRefresh={() => {
            void catalogue.refetch();
            void installed.refetch();
          }}
        />
      }
    >
      <View style={HEADER}>
        <View style={ACTIONS}>
          <Button
            tone="neutral"
            appearance="subtle"
            size="sm"
            leadingIcon={RiDownloadLine}
            onPress={() => router.push('/(app)/skills/import')}
          >
            {t('skills.import')}
          </Button>
          <Button
            tone="action"
            size="sm"
            leadingIcon={RiAddLine}
            onPress={() => router.push('/(app)/skills/create')}
          >
            {t('common.create')}
          </Button>
        </View>
        <Muted>{t('skills.subtitle')}</Muted>
        <Search
          label={t('skills.searchPlaceholder')}
          value={search}
          onChangeText={setSearch}
          onClearText={() => setSearch('')}
        />
      </View>

      {catalogue.isLoading ? (
        <View style={SHELVES}>
          <View style={SECTION}>
            <Skeleton.Text style={{ width: 120, marginHorizontal: 16 }} />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={[GUTTER, { gap: BOOK_GAP }]}
            >
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton.Box
                  key={index}
                  width={BOOK_WIDTH}
                  height={BOOK_WIDTH * 1.5}
                />
              ))}
            </ScrollView>
          </View>
        </View>
      ) : (
        <View style={SHELVES}>
          <Shelf
            title={t('skills.installed')}
            skills={installedShelf}
            installedIds={installedIds}
            onPressSkill={openSkill}
            onInstall={installSkill}
          />
          <Shelf
            title={t('skills.official')}
            skills={official}
            installedIds={installedIds}
            onPressSkill={openSkill}
            onInstall={installSkill}
            onEndReached={loadMore}
          />
          <Shelf
            title={t('skills.community')}
            skills={community}
            installedIds={installedIds}
            onPressSkill={openSkill}
            onInstall={installSkill}
            onEndReached={loadMore}
          />

          {/* A failed request is said out loud, with the way back. A blank
              catalogue after a search that errored reads as "no results". */}
          {catalogue.isError ? (
            <EmptyState
              variant="compact"
              title={t('skills.loadFailed')}
              action={{
                label: t('common.tryAgain'),
                onPress: () => void catalogue.refetch(),
              }}
            />
          ) : null}

          {/* An empty catalogue is a real state — a fresh database before the
              registry sync has run — and saying so beats a blank screen. */}
          {nothingToShow && !catalogue.isError ? (
            <EmptyState
              title={query ? t('skills.noResults') : t('skills.empty')}
            />
          ) : null}

          {/* The shelves ask for more as they are scrolled; this is the same
              request for anybody who would rather press than scroll. */}
          {catalogue.hasNextPage ? (
            <View style={GUTTER}>
              <Button
                tone="neutral"
                appearance="subtle"
                size="sm"
                loading={catalogue.isFetchingNextPage}
                disabled={catalogue.isFetchingNextPage}
                onPress={loadMore}
              >
                {t('skills.loadMore')}
              </Button>
            </View>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}
