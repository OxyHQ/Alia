import { AgentCard } from '@/components/agent-card';
import { agentIdentityMatches } from '@/lib/agents/identity';
import { useAgentCatalogue } from '@/lib/hooks/use-agents';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
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
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

/** The page's side gutter, the same 16 the layout's breadcrumb sits on. */
const GUTTER = 16;

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
      <View style={{ flex: 1, padding: 6 }}>
        <AgentCard
          agent={agent}
          variant="grid"
          onPress={handleSelectAgent}
          onChat={handleSelectAgent}
          onHire={handleHire}
        />
      </View>
    ),
    [handleSelectAgent, handleHire],
  );

  // ── Split header into smaller memos to avoid re-rendering everything ──

  /** The description, and the page's two actions beside it. */
  const headerTop = useMemo(
    () => (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          paddingTop: 16,
        }}
      >
        <Muted style={{ flexShrink: 1 }}>{t('agents.subtitle')}</Muted>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            size="sm"
            tone="neutral"
            appearance="subtle"
            leadingIcon={RiTeamLine}
            onPress={handleTeams}
          >
            {t('pages.agents.teams')}
          </Button>
          <Button
            size="sm"
            tone="action"
            leadingIcon={RiAddLine}
            onPress={handleCreateAgent}
          >
            {t('agents.createAgent')}
          </Button>
        </View>
      </View>
    ),
    [t, handleCreateAgent, handleTeams],
  );

  const searchBar = (
    <View style={{ paddingTop: 16 }}>
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
      <ChipRow
        role="radiogroup"
        accessibilityLabel={t('pages.agents.categories')}
        style={{ paddingVertical: 12 }}
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
              {category}
            </Chip>
          );
        })}
      </ChipRow>
    ),
    [categories, selectedCategory, t],
  );

  const featuredSection = useMemo(() => {
    if (searchQuery || selectedCategory || featuredAgents.length === 0)
      return null;
    return (
      <View style={{ gap: 8, paddingBottom: 16 }}>
        <Text variant="headline-semibold">{t('agents.featured')}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 12 }}
        >
          {featuredAgents.map((agent) => (
            <AgentCard
              key={agent._id}
              agent={agent}
              variant="featured"
              onPress={handleSelectAgent}
              onChat={handleSelectAgent}
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
    handleHire,
  ]);

  const sectionTitle = useMemo(
    () => (
      <Text variant="headline-semibold" style={{ paddingBottom: 6 }}>
        {searchQuery || selectedCategory
          ? `${filteredAgents.length} ${filteredAgents.length === 1 ? 'agent' : 'agents'}`
          : t('common.all')}
      </Text>
    ),
    [searchQuery, selectedCategory, filteredAgents.length, t],
  );

  /** Cards shaped like `AgentCard`, while the catalogue is on its way. */
  const loadingSkeleton = useMemo(() => {
    if (!loading || agents.length > 0) return null;
    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', margin: -6 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <View
            key={i}
            style={{ width: isLargeScreen ? '33.33%' : '50%', padding: 6 }}
          >
            <Card appearance="outline">
              <CardBody style={{ gap: 10, paddingVertical: 16 }}>
                <Skeleton.Circle size={40} />
                <Skeleton.Box width="70%" height={14} />
                <Skeleton.Box width="90%" height={10} />
                <Skeleton.Box width="50%" height={10} />
              </CardBody>
            </Card>
          </View>
        ))}
      </View>
    );
  }, [loading, agents.length, isLargeScreen]);

  const listHeader = (
    <View style={{ paddingHorizontal: 6 }}>
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
            : t('agents.createComingSoon')
        }
      />
    );
  }, [loading, t, searchQuery]);

  return (
    <FlashList
      key={numColumns}
      data={loading && agents.length === 0 ? [] : filteredAgents}
      numColumns={numColumns}
      renderItem={renderItem}
      ListHeaderComponent={listHeader}
      ListEmptyComponent={listEmpty}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: GUTTER - 6,
        paddingBottom: 24,
      }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    />
  );
}
