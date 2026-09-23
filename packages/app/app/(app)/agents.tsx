import { AgentCard } from '@/components/agent-card';
import { DrawerToggle } from '@/components/ui/drawer-toggle';
import { agentIdentityMatches } from '@/lib/agents/identity';
import { useAgentCatalogue } from '@/lib/hooks/use-agents';
import { useIsLargeScreen } from '@/lib/hooks/use-is-large-screen';
import { useTranslation } from '@/lib/hooks/use-translation';
import { cn } from '@/lib/utils';
import { Button } from '@oxy.so/bloom/button';
import { ContentPanel } from '@oxy.so/bloom/content-panel';
import { Search } from '@oxy.so/bloom/search';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Text } from '@oxy.so/bloom/typography';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Plus, Users } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

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

  const headerTop = useMemo(
    () => (
      <View className="px-5 pt-6 pb-1">
        <View className="flex-row items-center justify-between">
          {/* The drawer opener sits first, as on every top-level page (#532). */}
          <View className="flex-row items-center gap-2">
            <DrawerToggle />
            <Text className="text-2xl font-bold text-foreground">
              {t('agents.title')}
            </Text>
          </View>
          <View className="flex-row gap-2">
            <Button
              onPress={handleTeams}
              size="icon"
              variant="secondary"
              className="rounded-full h-8 w-8"
              icon={
                <>
                  <Users size={16} className="text-foreground" />
                </>
              }
            />
            <Button
              onPress={handleCreateAgent}
              size="icon"
              className="rounded-full h-8 w-8"
              icon={
                <>
                  <Plus size={16} className="text-primary-foreground" />
                </>
              }
            />
          </View>
        </View>
        <Text className="text-[13px] text-muted-foreground mt-0.5">
          {t('agents.subtitle')}
        </Text>
      </View>
    ),
    [t, handleCreateAgent, handleTeams],
  );

  const searchBar = (
    <View className="px-5 pt-3 pb-2">
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
      <View className="py-2">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20 }}
        >
          <View className="flex-row gap-1.5">
            {categories.map((category) => {
              const isActive =
                selectedCategory === category ||
                (!selectedCategory && category === t('common.all'));
              return (
                <Pressable
                  key={category}
                  onPress={() =>
                    setSelectedCategory(
                      category === t('common.all') ? null : category,
                    )
                  }
                  className="active:opacity-70"
                >
                  <View
                    className={cn(
                      'px-3 py-1 rounded-full',
                      isActive ? 'bg-foreground' : 'bg-muted/70',
                    )}
                  >
                    <Text
                      className={cn(
                        'text-xs font-medium',
                        isActive ? 'text-background' : 'text-muted-foreground',
                      )}
                    >
                      {category}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>
    ),
    [categories, selectedCategory, t],
  );

  const featuredSection = useMemo(() => {
    if (searchQuery || selectedCategory || featuredAgents.length === 0)
      return null;
    return (
      <View className="mt-2 mb-4">
        <View className="px-5 mb-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            {t('agents.featured')}
          </Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}
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
      <View className="px-5">
        {searchQuery || selectedCategory ? (
          <View className="mb-2">
            <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
              {filteredAgents.length}{' '}
              {filteredAgents.length === 1 ? 'agent' : 'agents'}
            </Text>
          </View>
        ) : (
          <View className="mb-2">
            <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
              {t('common.all')}
            </Text>
          </View>
        )}
      </View>
    ),
    [searchQuery, selectedCategory, filteredAgents.length, t],
  );

  const loadingSkeleton = useMemo(() => {
    if (!loading || agents.length > 0) return null;
    return (
      <View className="px-5">
        <View className="flex-row flex-wrap" style={{ margin: -6 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <View
              key={i}
              style={{
                width: isLargeScreen ? '33.33%' : '50%',
                padding: 6,
              }}
            >
              <View className="bg-muted/50 rounded-xl p-3 gap-2.5">
                <Skeleton.Circle size={40} />
                <Skeleton.Box width="70%" height={14} borderRadius={8} />
                <Skeleton.Box width="90%" height={10} borderRadius={6} />
                <Skeleton.Box width="50%" height={10} borderRadius={6} />
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }, [loading, agents.length, isLargeScreen]);

  const listHeader = (
    <>
      {headerTop}
      {searchBar}
      {categoryChips}
      {featuredSection}
      {sectionTitle}
      {loadingSkeleton}
    </>
  );

  const listEmpty = useMemo(() => {
    if (loading) return null;
    return (
      <View className="items-center justify-center py-16 px-5">
        <Text className="text-sm font-medium text-foreground">
          {t('agents.noAgents')}
        </Text>
        <Text className="text-xs text-muted-foreground text-center mt-1">
          {searchQuery
            ? t('common.tryDifferentSearch')
            : t('agents.createComingSoon')}
        </Text>
      </View>
    );
  }, [loading, t, searchQuery]);

  return (
    <ContentPanel surfaceClassName="bg-background">
      <View className="flex-1 bg-background">
        <FlashList
          key={numColumns}
          data={loading && agents.length === 0 ? [] : filteredAgents}
          numColumns={numColumns}
          renderItem={renderItem}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={listEmpty}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
      </View>
    </ContentPanel>
  );
}
