import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { IdentityMark } from "@alia.onl/sdk";
import { Button } from "@/components/ui/button";
import { BadgeCheck, Zap } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/hooks/use-translation";
import type { Agent } from "@/lib/types/agents";
import { agentDisplayName, agentHandle } from "@/lib/agents/identity";
import { agentTint } from "@/lib/agents/agent-color";
import { useColorScheme } from "@/lib/useColorScheme";

interface AgentCardProps {
  agent: Agent;
  onPress: (id: string) => void;
  onChat?: (id: string) => void;
  onHire?: (id: string) => void;
  variant?: "featured" | "grid";
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const STATUS_COLORS: Record<Agent["status"], string> = {
  active: "bg-green-500",
  idle: "bg-yellow-500",
  offline: "bg-gray-400",
};

export const AgentCard = React.memo(function AgentCard({
  agent,
  onPress,
  onChat,
  onHire,
  variant = "grid",
}: AgentCardProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const isFeatured = variant === "featured";
  const markSize = isFeatured ? 64 : 56;
  const statusDotSize = isFeatured
    ? "w-3.5 h-3.5 border-[2.5px]"
    : "w-3 h-3 border-2";

  return (
    <Pressable
      onPress={() => onPress(agent._id)}
      className="active:opacity-80"
      style={isFeatured ? { width: 300 } : { flex: 1 }}
    >
      <View className="rounded-2xl border border-border bg-surface p-4 flex-1">
        {/* Top row: the agent's mark (left) + Chat button (right) — like Twitter avatar + Follow */}
        <View className="flex-row items-start justify-between">
          <View className="relative">
            <IdentityMark
              size={markSize}
              color={agentTint(agent.color, colors)}
              accessibilityLabel={agentDisplayName(agent)}
            />
            <View
              className={cn(
                "absolute bottom-0 right-0 rounded-full border-surface",
                statusDotSize,
                STATUS_COLORS[agent.status]
              )}
            />
          </View>
          <Button
            variant="default"
            size="sm"
            className="rounded-full h-8 px-4 bg-foreground"
            onPress={(e) => {
              e.stopPropagation?.();
              onChat?.(agent._id);
            }}
          >
            <Text className="text-[13px] font-semibold text-background">
              {t("agents.chat")}
            </Text>
          </Button>
        </View>

        {/* Name + native badge */}
        <View className="flex-row items-center gap-1 mt-3">
          <Text
            className={cn(
              "font-bold text-foreground",
              isFeatured ? "text-[16px]" : "text-[15px]"
            )}
            numberOfLines={1}
          >
            {agentDisplayName(agent)}
          </Text>
        </View>

        {/* Handle — absent when Oxy could not resolve the bot account. */}
        {agentHandle(agent) !== "" && (
          <Text className="text-[13px] text-muted-foreground mt-0.5" numberOfLines={1}>
            @{agentHandle(agent)}
          </Text>
        )}

        {/* Tagline */}
        <Text
          className="text-[14px] text-foreground leading-5 mt-2.5"
          numberOfLines={2}
        >
          {agent.tagline}
        </Text>

        {/* Spacer to push stats + hire to bottom */}
        <View className="flex-1" />

        {/* Stats */}
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-0.5 mt-3">
          <View className="flex-row items-center gap-1">
            <Text className="text-[13px] font-bold text-foreground">
              {formatCount(agent.hireCount)}
            </Text>
            <Text className="text-[13px] text-muted-foreground">
              {t("agents.hires")}
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            <Text className="text-[13px] font-bold text-foreground">
              {formatCount(agent.usageCount)}
            </Text>
            <Text className="text-[13px] text-muted-foreground">
              {t("agents.uses")}
            </Text>
          </View>
          {agent.rating > 0 && (
            <View className="flex-row items-center gap-1">
              <Text className="text-[13px] font-bold text-foreground">
                {agent.rating}
              </Text>
              <Text className="text-[13px] text-muted-foreground">
                {t("agents.rating")}
              </Text>
            </View>
          )}
        </View>

        {/* Hire button — full width outline at bottom, like Twitter "Profile Summary" */}
        {/* Only an agent anyone may use offers the button to everyone; a
            private one is reached through its own thread, by people who were
            given access. */}
        {agent.access === 'public' && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full h-9 w-full mt-3"
            onPress={(e) => {
              e.stopPropagation?.();
              onHire?.(agent._id);
            }}
          >
            <View className="flex-row items-center justify-center gap-1.5">
              <Zap size={13} className="text-foreground" />
              <Text className="text-[12px] font-semibold text-foreground">
                {agent.price != null
                  ? `${t("agents.hire")} · $${agent.price.toFixed(2)}`
                  : t("agents.hire")}
              </Text>
            </View>
          </Button>
        )}
      </View>
    </Pressable>
  );
});
