import React, { useEffect, useState, useMemo } from "react";
import { View, ScrollView, Pressable, TextInput, useWindowDimensions } from "react-native";
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

export default function AgentsScreen() {
  const { t } = useTranslation();
  const agents = useAgentsStore((state) => state.agents);
  const loadAgents = useAgentsStore((state) => state.loadAgents);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const router = useRouter();
  const { colors } = useColorScheme();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const handleSelectAgent = (agentId: string) => {
    router.push(`/(app)/agents/${agentId}`);
  };

  const handleChat = (agentId: string) => {
    router.push(`/(app)/agents/${agentId}`);
  };

  const handleHire = (_agentId: string) => {
    toast.info(t("agents.hireComingSoon"));
  };

  const handleCreateAgent = () => {
    router.push("/(app)/agents/create");
  };

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

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/* Header */}
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

        {/* Search */}
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

        {/* Category Chips */}
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

        {/* Featured Section */}
        {!searchQuery && !selectedCategory && featuredAgents.length > 0 && (
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
                  onChat={handleChat}
                  onHire={handleHire}
                />
              ))}
            </ScrollView>
          </View>
        )}

        {/* All Agents Grid */}
        <View className="px-5 pb-6">
          {(searchQuery || selectedCategory) && (
            <View className="mb-2">
              <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
                {filteredAgents.length}{" "}
                {filteredAgents.length === 1 ? "agent" : "agents"}
              </Text>
            </View>
          )}
          {!searchQuery && !selectedCategory && (
            <View className="mb-2">
              <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
                {t("common.all")}
              </Text>
            </View>
          )}

          <View className="flex-row flex-wrap" style={{ margin: -6 }}>
            {filteredAgents.map((agent) => (
              <View
                key={agent._id}
                style={{
                  width: isLargeScreen ? "33.33%" : "50%",
                  padding: 6,
                }}
              >
                <AgentCard
                  agent={agent}
                  variant="grid"
                  onPress={handleSelectAgent}
                  onChat={handleChat}
                  onHire={handleHire}
                />
              </View>
            ))}
          </View>

          {filteredAgents.length === 0 && (
            <View className="items-center justify-center py-16">
              <Text className="text-sm font-medium text-foreground">
                {t("agents.noAgents")}
              </Text>
              <Text className="text-xs text-muted-foreground text-center mt-1">
                {searchQuery
                  ? t("common.tryDifferentSearch")
                  : t("agents.createComingSoon")}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
