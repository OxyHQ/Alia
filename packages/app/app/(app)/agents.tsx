import { AgentCard } from '@/features/agents/ui/agent-card';
import { agentCategoryLabel } from '@/features/agents/model/category';
import { agentChatRoute, agentIdentityMatches } from '@/features/agents/model/identity';
import { useAgentCatalogue } from '@/features/agents/runtime/use-agents';
import { useIsLargeScreen } from '@/shared/platform/use-is-large-screen';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { Card, CardBody } from '@oxy.so/bloom/card';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { FlashList } from '@shopify/flash-list';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

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
  const isLargeScreen = useIsLargeScreen();
  const numColumns = isLargeScreen ? 3 : 2;

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

  const handleCreateAgent = useCallback(() => {
    router.push('/(app)/agents/create');
  }, [router]);
  const handleTeams = useCallback(
    () => router.push('/(app)/agents/teams'),
    [router],
  );

  const categories = useMemo(() => {
    const cats = new Set(agents.map((a) => a.category));
    return [t('common.all'), ...Array.from(cats)];
  }, [agents, t]);

  const filteredAgents = useMemo(() => {
    let filtered = agents;
    if (selectedCategory && selectedCategory !== t('common.all')) {
      filtered = filtered.filter(
        (agent) => agent.category === selectedCategory,
      );
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

  const featuredAgents = useMemo(
    () => agents.filter((a) => a.isFeatured),
    [agents],
  );

  const renderItem = useCallback(
    ({ item: agent }: { item: (typeof filteredAgents)[0] }) => (
      <View className="flex-1 p-1.5">
        <AgentCard
          agent={agent}
          variant="grid"
          onPress={handleSelectAgent}
          onChat={handleChat}
          onHire={handleHire}
        />
      </View>
    ),
    [handleSelectAgent, handleChat, handleHire],
  );

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
        <ChipRow
          role="radiogroup"
          accessibilityLabel={t('pages.agents.categories')}
        >
          {categories.map((category) => {
            const isActive =
              selectedCategory === category ||
              (!selectedCategory && category === t('common.all'));
            return (
              <Chip
                key={category}
                size="xl"
                role="radio"
                selected={isActive}
                onPress={() =>
                  setSelectedCategory(
                    category === t('common.all') ? null : category,
                  )
                }
              >
                {category === t('common.all')
                  ? category
                  : agentCategoryLabel(category, t)}
              </Chip>
            );
          })}
        </ChipRow>
      </View>
    ),
    [categories, selectedCategory, t],
  );

  const featuredSection = useMemo(() => {
    if (searchQuery || selectedCategory || featuredAgents.length === 0)
      return null;
    return (
      <View className="gap-2 pb-4">
        <Text variant="headline-semibold">{t('agents.featured')}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-3"
        >
          {featuredAgents.map((agent) => (
            <AgentCard
              key={agent._id}
              agent={agent}
              variant="featured"
              onPress={handleSelectAgent}
              onChat={handleChat}
              onHire={handleHire}
            />
          ))}
        </ScrollView>
      </View>
    );
  }, [
    searchQuery,
    selectedCategory,
    featuredAgents,
    t,
    handleSelectAgent,
    handleChat,
    handleHire,
  ]);

  const sectionTitle = useMemo(
    () => (
      <View className="pb-1.5">
        <Text variant="headline-semibold">
          {searchQuery || selectedCategory
            ? `${filteredAgents.length} ${filteredAgents.length === 1 ? 'agent' : 'agents'}`
            : t('common.all')}
        </Text>
      </View>
    ),
    [searchQuery, selectedCategory, filteredAgents.length, t],
  );

  /** Cards shaped like `AgentCard`, while the catalogue is on its way. */
  const loadingSkeleton = useMemo(() => {
    if (!loading || agents.length > 0) return null;
    return (
      <View className="-m-1.5 flex-row flex-wrap">
        {Array.from({ length: 6 }).map((_, i) => (
          <View
            key={i}
            className={isLargeScreen ? 'w-1/3 p-1.5' : 'w-1/2 p-1.5'}
          >
            <Card appearance="outline">
              <CardBody>
                <View className="gap-2.5 py-2">
                  <Skeleton.Circle size={40} />
                  <Skeleton.Box width="70%" height={14} />
                  <Skeleton.Box width="90%" height={10} />
                  <Skeleton.Box width="50%" height={10} />
                </View>
              </CardBody>
            </Card>
          </View>
        ))}
      </View>
    );
  }, [loading, agents.length, isLargeScreen]);

  const listHeader = (
    <View className="px-1.5">
      {headerTop}
      {searchBar}
      {categoryChips}
      {featuredSection}
      {sectionTitle}
      {loadingSkeleton}
    </View>
  );

  const listEmpty = useMemo(() => {
    if (loading) return null;
    return (
      <EmptyState
        icon={RiRobot2Line}
        title={t('agents.noAgents')}
        description={
          searchQuery
            ? t('common.tryDifferentSearch')
            : t('agents.createFirstHint')
        }
        // Creating an agent is a real screen, so an empty list offers it
        // rather than saying it is "coming soon" (#608, rule 6).
        action={
          searchQuery
            ? undefined
            : { label: t('agents.createAgent'), onPress: handleCreateAgent }
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
              <Button
                size="md"
                tone="action"
                leadingIcon={RiAddLine}
                onPress={handleCreateAgent}
              >
                {t('agents.createAgent')}
              </Button>
            </>
          ),
        }}
      />
      <FlashList
        key={numColumns}
        data={loading && agents.length === 0 ? [] : filteredAgents}
        numColumns={numColumns}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={<View className="h-6" />}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      />
    </View>
  );
}
