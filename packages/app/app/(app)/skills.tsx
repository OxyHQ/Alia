import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, ScrollView, Pressable, RefreshControl } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, Download, Plus, Search } from 'lucide-react-native';
import { useTranslation } from '@/lib/hooks/use-translation';
import { useRouter } from 'expo-router';
import {
  useInstallSkill,
  useInstalledSkills,
  useSkillCataloguePages,
  type InstalledSkill,
  type Skill,
} from '@/lib/hooks/use-skills';
import { SkillCover } from '@/components/ui/skill-cover';
import { Skeleton } from '@/components/ui/skeleton';
import { DrawerToggle } from '@/components/ui/drawer-toggle';
import { ContentPanel } from '@oxy.so/bloom/content-panel';

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
  return (
    <View style={{ width: BOOK_WIDTH, marginRight: BOOK_GAP }}>
      <Pressable onPress={onPress} className="active:opacity-80">
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
        size="sm"
        variant={installed ? 'secondary' : 'outline'}
        className="mt-1.5 h-7 rounded-full"
        disabled={installed}
        onPress={onInstall}
      >
        {installed ? (
          <Check size={12} className="text-muted-foreground" />
        ) : (
          <Download size={12} className="text-foreground" />
        )}
      </Button>
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
    <ContentPanel surfaceClassName="bg-background">
      <View className="mb-5">
        <View className="px-5 mb-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">{title}</Text>
        </View>
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
            contentContainerStyle={{ paddingHorizontal: 20 }}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.5}
          />
        </View>
      </View>
    </ContentPanel>
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
    () => new Set((installed.data ?? []).map((skill: InstalledSkill) => skill._id)),
    [installed.data],
  );

  const skills = useMemo(() => catalogue.data?.pages.flat() ?? [], [catalogue.data]);
  // An installed skill lives on the Installed shelf and nowhere else on this
  // screen: the same book twice is twice the covers for no information.
  const official = useMemo(
    () =>
      skills.filter(
        (skill) => !installedIds.has(skill._id) && (skill.source === 'builtin' || skill.source === 'registry'),
      ),
    [skills, installedIds],
  );
  const community = useMemo(
    () =>
      skills.filter(
        (skill) => !installedIds.has(skill._id) && skill.source !== 'builtin' && skill.source !== 'registry',
      ),
    [skills, installedIds],
  );
  const installedShelf = useMemo(
    () => (installed.data ?? []).filter((skill) => matchesQuery(skill, query)),
    [installed.data, query],
  );

  const openSkill = useCallback((name: string) => router.push(`/(app)/skills/${name}`), [router]);
  const installSkill = useCallback((id: string) => install.mutate(id), [install]);
  const loadMore = useCallback(() => {
    if (catalogue.hasNextPage && !catalogue.isFetchingNextPage) void catalogue.fetchNextPage();
  }, [catalogue]);

  const nothingToShow = skills.length === 0 && installedShelf.length === 0;

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={catalogue.isFetching && !catalogue.isLoading && !catalogue.isFetchingNextPage}
            onRefresh={() => {
              void catalogue.refetch();
              void installed.refetch();
            }}
          />
        }
      >
        <View className="px-5 pt-6 pb-4">
          <View className="flex-row items-center justify-between">
            {/* The drawer opener sits first, as on every top-level page (#532). */}
            <View className="flex-row items-center gap-2">
              <DrawerToggle />
              <Text className="text-2xl font-bold text-foreground">{t('skills.title')}</Text>
            </View>
            <View className="flex-row gap-2">
              <Button
                size="icon"
                variant="outline"
                className="rounded-full h-8 w-8"
                onPress={() => router.push('/(app)/skills/import')}
              >
                <Download size={16} className="text-foreground" />
              </Button>
              <Button size="icon" className="rounded-full h-8 w-8" onPress={() => router.push('/(app)/skills/create')}>
                <Plus size={16} className="text-primary-foreground" />
              </Button>
            </View>
          </View>
          <Text className="text-[13px] text-muted-foreground mt-0.5">{t('skills.subtitle')}</Text>

          <View className="mt-3 flex-row items-center gap-2 rounded-full border border-border px-3">
            <Search size={14} className="text-muted-foreground" />
            <Input
              value={search}
              onChangeText={setSearch}
              placeholder={t('skills.searchPlaceholder')}
              className="flex-1 border-0 bg-transparent px-0"
            />
          </View>
        </View>

        {catalogue.isLoading ? (
          <View className="mb-5">
            <View className="px-5 mb-2">
              <Skeleton style={{ width: 80, height: 10, borderRadius: 6 }} />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}>
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} style={{ width: BOOK_WIDTH, height: BOOK_WIDTH * 1.5, borderRadius: 8 }} />
              ))}
            </ScrollView>
          </View>
        ) : (
          <>
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
              <View className="px-5 py-6 items-center gap-3">
                <Text className="text-[13px] text-muted-foreground text-center">{t('skills.loadFailed')}</Text>
                <Button size="sm" variant="outline" className="rounded-full" onPress={() => void catalogue.refetch()}>
                  <Text className="text-[13px]">{t('common.tryAgain')}</Text>
                </Button>
              </View>
            ) : null}

            {/* An empty catalogue is a real state — a fresh database before the
                registry sync has run — and saying so beats a blank screen. */}
            {nothingToShow && !catalogue.isError ? (
              <View className="px-5 py-10 items-center">
                <Text className="text-[13px] text-muted-foreground text-center">
                  {query ? t('skills.noResults') : t('skills.empty')}
                </Text>
              </View>
            ) : null}

            {/* The shelves ask for more as they are scrolled; this is the same
                request for anybody who would rather press than scroll. */}
            {catalogue.hasNextPage ? (
              <View className="px-5 pb-6 items-center">
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  disabled={catalogue.isFetchingNextPage}
                  onPress={loadMore}
                >
                  <Text className="text-[13px]">{t('skills.loadMore')}</Text>
                </Button>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
