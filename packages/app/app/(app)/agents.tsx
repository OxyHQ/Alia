import { AgentListingRow } from '@/features/agents/ui/agent-listing-row';
import { catalogueItems, type CatalogueItem } from '@/features/agents/model/catalogue-items';
import { agentCategoryLabel } from '@/features/agents/model/category';
import { agentChatRoute, agentIdentityMatches } from '@/features/agents/model/identity';
import { useAgentCatalogue } from '@/features/agents/runtime/use-agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { FlashList } from '@shopify/flash-list';
import { useNewAgentConversation } from '@/features/agents/runtime/use-new-agent-conversation';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, useWindowDimensions, View } from 'react-native';

/**
 * The agent catalogue. Plain content on the layout's surface: the layout draws
 * the page, its corners, the menu button and the "Agents" crumb, so this page
 * starts at its description and actions.
 */
export default function AgentsScreen() {
  const { t } = useTranslation();
  const { data, isPending: loading, refetch } = useAgentCatalogue();
  const agents = data?.agents ?? [];
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const router = useRouter();
  // Rows sit two to a line where there is room (Bloom's `sm` breakpoint), one on a phone.
  const columns = useWindowDimensions().width >= 640 ? 2 : 1;

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const handleSelectAgent = useCallback(
    (agentId: string) => {
      router.push(`/(app)/agents/${agentId}`);
    },
    [router],
  );

  const handleChat = useCallback(
    (agentId: string) => {
      const agent = agents.find((entry) => entry._id === agentId);
      router.push(
        agent === undefined
          ? { pathname: '/(app)/agents/[id]', params: { id: agentId } }
          : agentChatRoute(agent),
      );
    },
    [agents, router],
  );

  const handleHire = useCallback(
    (agentId: string) => {
      router.push(`/(app)/agents/${agentId}`);
    },
    [router],
  );

  const handleCreateAgent = useNewAgentConversation();
  const handleTeams = useCallback(() => router.push('/(app)/agents/teams'), [router]);

  const categories = useMemo(() => {
    const cats = new Set(agents.map((a) => a.category));
    return [t('common.all'), ...Array.from(cats)];
  }, [agents, t]);

  const filteredAgents = useMemo(() => {
    let filtered = agents;
    if (selectedCategory && selectedCategory !== t('common.all')) {
      filtered = filtered.filter((agent) => agent.category === selectedCategory);
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (agent) =>
          // Name and handle are Oxy's and may be unresolved; the shared matcher
          // is what keeps every surface agreeing on what an agent is called.
          agentIdentityMatches(agent, query) ||
          agent.tagline.toLowerCase().includes(query) ||
          agent.description.toLowerCase().includes(query) ||
          agent.category.toLowerCase().includes(query) ||
          agent.tags.some((tag) => tag.toLowerCase().includes(query)),
      );
    }
    return filtered;
  }, [agents, searchQuery, selectedCategory, t]);

  // ── Split header into smaller memos to avoid re-rendering everything ──

  /** The description, and the page's two actions beside it. */
  const headerTop = (
    <View className="pt-4">
      <Muted>{t('agents.subtitle')}</Muted>
    </View>
  );

  const searchBar = (
    <View className="pt-4">
      <Search
        label={t('agents.searchPlaceholder')}
        value={searchQuery}
        onChangeText={setSearchQuery}
        onClearText={() => setSearchQuery('')}
      />
    </View>
  );

  const categoryChips = useMemo(
    () => (
      <View className="py-3">
        <ChipRow role="radiogroup" accessibilityLabel={t('pages.agents.categories')}>
          {categories.map((category) => {
            const isActive =
              selectedCategory === category || (!selectedCategory && category === t('common.all'));
            return (
              <Chip
                key={category}
                size="xl"
                role="radio"
                selected={isActive}
                onPress={() => setSelectedCategory(category === t('common.all') ? null : category)}
              >
                {category === t('common.all') ? category : agentCategoryLabel(category, t)}
              </Chip>
            );
          })}
        </ChipRow>
      </View>
    ),
    [categories, selectedCategory, t],
  );

  /** With nothing typed and no category chosen: Featured, then a preview of every category. */
  const overview = !searchQuery.trim() && !selectedCategory;
  const items = useMemo(
    () =>
      catalogueItems({
        agents: filteredAgents,
        overview,
        columns,
        featuredLabel: t('agents.featured'),
        categoryLabel: (category) => agentCategoryLabel(category, t),
        matchedLabel: (count) =>
          selectedCategory
            ? agentCategoryLabel(selectedCategory, t)
            : `${count} ${count === 1 ? 'agent' : 'agents'}`,
      }),
    [filteredAgents, overview, columns, selectedCategory, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: CatalogueItem }) =>
      item.kind === 'title' ? (
        <View className="flex-row items-center justify-between px-3 pb-1 pt-5">
          <Text variant="headline-semibold">{item.label}</Text>
          {item.category === undefined ? null : (
            <Button
              size="sm"
              tone="neutral"
              appearance="plain"
              onPress={() => setSelectedCategory(item.category ?? null)}
            >
              {t('agents.viewAll')}
            </Button>
          )}
        </View>
      ) : (
        <View className="flex-row">
          {item.agents.map((agent) => (
            <View key={agent._id} className="min-w-0 flex-1">
              <AgentListingRow agent={agent} onPress={handleSelectAgent} onChat={handleChat} />
            </View>
          ))}
          {/* A short last row keeps its agents the width of a column. */}
          {Array.from({ length: columns - item.agents.length }, (_, index) => (
            <View key={`pad-${index}`} className="flex-1" />
          ))}
        </View>
      ),
    [columns, handleSelectAgent, handleChat, t],
  );

  /** Rows shaped like `AgentListingRow`, while the catalogue is on its way. */
  const loadingSkeleton = useMemo(() => {
    if (!loading || agents.length > 0) return null;
    return (
      <View className="pt-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <View key={i} className="flex-row items-center gap-3 p-3">
            <Skeleton.Circle size={32} />
            <View className="flex-1 gap-1.5">
              <Skeleton.Box width="45%" height={13} />
              <Skeleton.Box width="80%" height={11} />
            </View>
          </View>
        ))}
      </View>
    );
  }, [loading, agents.length]);

  const listHeader = (
    <View className="px-1.5">
      {headerTop}
      {searchBar}
      {categoryChips}
      {loadingSkeleton}
    </View>
  );

  const listEmpty = useMemo(() => {
    if (loading) return null;
    return (
      <EmptyState
        icon={RiRobot2Line}
        title={t('agents.noAgents')}
        description={searchQuery ? t('common.tryDifferentSearch') : t('agents.createFirstHint')}
        // Creating an agent is a real screen, so an empty list offers it
        // rather than saying it is "coming soon" (#608, rule 6).
        action={
          searchQuery ? undefined : { label: t('agents.createAgent'), onPress: handleCreateAgent }
        }
      />
    );
  }, [loading, t, searchQuery, handleCreateAgent]);

  // FlashList measures its own content container, so the page gutter (16, the
  // layout breadcrumb's, less the 6 each cell pads) and the bottom breathing
  // room sit around the list and after it rather than in `contentContainerStyle`.
  return (
    <View className="flex-1 px-2.5">
      <Stack.Screen
        options={{
          headerRight: () => (
            <>
              <ButtonGroup accessibilityLabel={t('pages.agents.teams')}>
                <ButtonGroupItem leadingIcon={RiTeamLine} onPress={handleTeams}>
                  {t('pages.agents.teams')}
                </ButtonGroupItem>
              </ButtonGroup>
              {/* "Create", as on Skills: with Teams beside it, "Create Agent"
                  left the page's own title at "Ag…" on a phone. The page says
                  what is created; the label for a screen reader still does. */}
              <Button
                size="md"
                tone="action"
                leadingIcon={RiAddLine}
                onPress={handleCreateAgent}
                accessibilityLabel={t('agents.createAgent')}
              >
                {t('common.create')}
              </Button>
            </>
          ),
        }}
      />
      <FlashList
        key={columns}
        data={filteredAgents.length === 0 ? [] : items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={<View className="h-6" />}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </View>
  );
}
