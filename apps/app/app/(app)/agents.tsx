import React, { useEffect, useState, useMemo, useCallback } from "react";
import { View, ScrollView, Pressable, TextInput, useWindowDimensions, RefreshControl } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react-native";
import { useAgentsStore } from "@/lib/stores/agents-store";
import { AgentCard } from "@/components/agent-card";
import { useRouter } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "@/components/sonner";
import { cn } from "@/lib/utils";
import { useColorScheme } from "@/lib/useColorScheme";
import { Skeleton } from "@/components/ui/skeleton";

export default function AgentsScreen() {
  const { t } = useTranslation();
  const agents = useAgentsStore((state) => state.agents);
  const loadAgents = useAgentsStore((state) => state.loadAgents);
  const loading = useAgentsStore((state) => state.loading);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const router = useRouter();
  const { colors } = useColorScheme();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const numColumns = isLargeScreen ? 3 : 2;

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAgents();
    setRefreshing(false);
  }, [loadAgents]);

  const handleSelectAgent = useCallback((agentId: string) => {
    router.push(`/(app)/agents/${agentId}`);
  }, [router]);

  const handleHire = useCallback((_agentId: string) => {
    toast.info(t("agents.hireComingSoon"));
  }, [t]);

  const handleCreateAgent = useCallback(() => {
    router.push("/(app)/agents/create");
  }, [router]);

  const categories = useMemo(() => {
    const cats = new Set(agents.map((a) => a.category));
    return [t("common.all"), ...Array.from(cats)];
  }, [agents, t]);

  const filteredAgents = useMemo(() => {
    let filtered = agents;
    if (selectedCategory && selectedCategory !== t("common.all")) {
      filtered = filtered.filter((agent) => agent.category === selectedCategory);
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (agent) =>
          agent.name.toLowerCase().includes(query) ||
          agent.handle.toLowerCase().includes(query) ||
          agent.tagline.toLowerCase().includes(query) ||
          agent.description.toLowerCase().includes(query) ||
          agent.category.toLowerCase().includes(query) ||
          agent.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    }
    return filtered;
  }, [agents, searchQuery, selectedCategory, t]);

  const featuredAgents = useMemo(
    () => agents.filter((a) => a.isFeatured),
    [agents]
  );

  const renderItem = useCallback(({ item: agent }: { item: typeof filteredAgents[0] }) => (
    <View style={{ flex: 1, padding: 6 }}>
      <AgentCard
        agent={agent}
        variant="grid"
        onPress={handleSelectAgent}
        onChat={handleSelectAgent}
        onHire={handleHire}
      />
    </View>
  ), [handleSelectAgent, handleHire]);

  // ── Split header into smaller memos to avoid re-rendering everything ──

  const headerTop = useMemo(() => (
    <View className="px-5 pt-6 pb-1">
      <View className="flex-row items-center justify-between">
        <Text className="text-2xl font-bold text-foreground">
          {t("agents.title")}
        </Text>
        <Button
          onPress={handleCreateAgent}
          size="icon"
          className="rounded-full h-8 w-8"
        >
          <Plus size={16} className="text-primary-foreground" />
        </Button>
      </View>
      <Text className="text-[13px] text-muted-foreground mt-0.5">
        {t("agents.subtitle")}
      </Text>
    </View>
  ), [t, handleCreateAgent]);

  const searchBar = (
    <View className="px-5 pt-3 pb-2">
      <View className="flex-row items-center gap-2 bg-muted/70 rounded-lg px-3 py-2">
        <Search size={15} className="text-muted-foreground" />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder={t("agents.searchPlaceholder")}
          placeholderTextColor={colors.mutedForeground}
          className="flex-1 text-[13px] text-foreground"
        />
      </View>
    </View>
  );

  const categoryChips = useMemo(() => (
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
              (!selectedCategory && category === t("common.all"));
            return (
              <Pressable
                key={category}
                onPress={() =>
                  setSelectedCategory(
                    category === t("common.all") ? null : category
                  )
                }
                className="active:opacity-70"
              >
                <View
                  className={cn(
                    "px-3 py-1 rounded-full",
                    isActive ? "bg-foreground" : "bg-muted/70"
                  )}
                >
                  <Text
                    className={cn(
                      "text-xs font-medium",
                      isActive
                        ? "text-background"
                        : "text-muted-foreground"
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
  ), [categories, selectedCategory, t]);

  const featuredSection = useMemo(() => {
    if (searchQuery || selectedCategory || featuredAgents.length === 0) return null;
    return (
      <View className="mt-2 mb-4">
        <View className="px-5 mb-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            {t("agents.featured")}
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
  }, [searchQuery, selectedCategory, featuredAgents, t, handleSelectAgent, handleHire]);

  const sectionTitle = useMemo(() => (
    <View className="px-5">
      {(searchQuery || selectedCategory) ? (
        <View className="mb-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            {filteredAgents.length}{" "}
            {filteredAgents.length === 1 ? "agent" : "agents"}
          </Text>
        </View>
      ) : (
        <View className="mb-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            {t("common.all")}
          </Text>
        </View>
      )}
    </View>
  ), [searchQuery, selectedCategory, filteredAgents.length, t]);

  const loadingSkeleton = useMemo(() => {
    if (!loading || agents.length > 0) return null;
    return (
      <View className="px-5">
        <View className="flex-row flex-wrap" style={{ margin: -6 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <View
              key={i}
              style={{
                width: isLargeScreen ? "33.33%" : "50%",
                padding: 6,
              }}
            >
              <View className="bg-muted/50 rounded-xl p-3 gap-2.5">
                <Skeleton style={{ width: 40, height: 40, borderRadius: 20 }} />
                <Skeleton style={{ width: '70%', height: 14, borderRadius: 8 }} />
                <Skeleton style={{ width: '90%', height: 10, borderRadius: 6 }} />
                <Skeleton style={{ width: '50%', height: 10, borderRadius: 6 }} />
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
          {t("agents.noAgents")}
        </Text>
        <Text className="text-xs text-muted-foreground text-center mt-1">
          {searchQuery
            ? t("common.tryDifferentSearch")
            : t("agents.createComingSoon")}
        </Text>
      </View>
    );
  }, [loading, t, searchQuery]);

  return (
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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </View>
  );
}
