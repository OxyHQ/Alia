import React from "react";
import { View, ScrollView, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { ArrowLeft, Plus, Users, ChevronRight } from "lucide-react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useAgentTeams } from "@/lib/hooks/use-agent-teams";

export default function AgentTeamsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { data: teams, isLoading } = useAgentTeams();

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-5 pt-4 pb-2">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={() => router.back()} className="active:opacity-70">
            <ArrowLeft size={22} className="text-foreground" />
          </Pressable>
          <Text className="text-lg font-bold text-foreground">
            {t("agents.teams")}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push("/(app)/agents/teams/create")}
          className="active:opacity-70"
        >
          <Plus size={22} className="text-foreground" />
        </Pressable>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 20 }}
        showsVerticalScrollIndicator={false}
      >
        {isLoading ? (
          <View className="items-center justify-center py-12">
            <Text className="text-muted-foreground">{t("common.loading")}</Text>
          </View>
        ) : !teams || teams.length === 0 ? (
          <View className="items-center justify-center py-12">
            <Users size={40} className="text-muted-foreground mb-3" />
            <Text className="text-muted-foreground text-center">
              {t("agents.noTeamsYet")}
            </Text>
          </View>
        ) : (
          <View className="gap-3">
            {teams.map((team) => (
              <Pressable
                key={team._id}
                onPress={() => router.push({ pathname: "/(app)/agents/teams/[id]", params: { id: team._id } })}
                className="rounded-xl border border-border bg-surface p-4 active:opacity-80"
              >
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 gap-1">
                    <Text className="text-[15px] font-semibold text-foreground">
                      {team.name}
                    </Text>
                    {team.description && (
                      <Text
                        className="text-[13px] text-muted-foreground"
                        numberOfLines={1}
                      >
                        {team.description}
                      </Text>
                    )}
                    <Text className="text-[11px] text-muted-foreground mt-0.5">
                      {team.agents.length} {team.agents.length === 1 ? "agent" : "agents"}
                    </Text>
                  </View>
                  <ChevronRight size={16} className="text-muted-foreground ml-2" />
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
