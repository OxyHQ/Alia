import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Plus, Zap } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { Agent } from "@/lib/stores/agents-store";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DEFAULT_AVATAR = require("@/assets/images/agent-avatar-reference.png");

interface AgentCardProps {
  agent: Agent;
  onPress: (id: string) => void;
  onFollow?: (id: string) => void;
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
  onFollow,
  onHire,
  variant = "grid",
}: AgentCardProps) {
  const { t } = useTranslation();
  const isFeatured = variant === "featured";
  const avatarSize = isFeatured ? "h-16 w-16" : "h-14 w-14";
  const statusDotSize = isFeatured
    ? "w-3.5 h-3.5 border-[2.5px]"
    : "w-3 h-3 border-2";

  return (
    <Pressable
      onPress={() => onPress(agent._id)}
      className="active:opacity-80"
      style={isFeatured ? { width: 300 } : undefined}
    >
      <View className="rounded-2xl border border-border bg-surface p-4">
        {/* Top row: Avatar + Follow button */}
        <View className="flex-row items-start justify-between">
          <View className="relative">
            <Avatar className={cn(avatarSize)}>
              <AvatarImage source={agent.avatar ? { uri: agent.avatar } : DEFAULT_AVATAR} />
            </Avatar>
            {/* Status dot */}
            <View
              className={cn(
                "absolute bottom-0 right-0 rounded-full border-surface",
                statusDotSize,
                STATUS_COLORS[agent.status]
              )}
            />
          </View>

          {/* Follow button */}
          <Button
            variant="pill"
            size="sm"
            className="rounded-full h-8 px-4"
            onPress={(e) => {
              e.stopPropagation?.();
              onFollow?.(agent._id);
            }}
          >
            <View className="flex-row items-center gap-1">
              <Plus size={13} className="text-primary-foreground" />
              <Text className="text-[12px] font-bold text-primary-foreground">
                {t("agents.follow")}
              </Text>
            </View>
          </Button>
        </View>

        {/* Name + verified */}
        <View className="flex-row items-center gap-1 mt-3">
          <Text
            className={cn(
              "font-bold text-foreground",
              isFeatured ? "text-[15px]" : "text-[14px]"
            )}
            numberOfLines={1}
          >
            {agent.name}
          </Text>
          {agent.isVerified && (
            <CheckCircle2
              size={14}
              className="text-blue-500"
              fill="#3b82f6"
              strokeWidth={0}
            />
          )}
        </View>

        {/* Handle */}
        <Text className="text-[12px] text-muted-foreground mt-0.5" numberOfLines={1}>
          {agent.handle}
        </Text>

        {/* Tagline */}
        <Text
          className="text-[13px] text-foreground leading-[18px] mt-2"
          numberOfLines={2}
        >
          {agent.tagline}
        </Text>

        {/* Stats row */}
        <View className="flex-row items-center gap-3 mt-2.5">
          <View className="flex-row items-center gap-1">
            <Text className="text-[13px] font-bold text-foreground">
              {formatCount(agent.followerCount)}
            </Text>
            <Text className="text-[13px] text-muted-foreground">
              {t("agents.followers")}
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            <Text className="text-[13px] font-bold text-foreground">
              {formatCount(agent.hireCount)}
            </Text>
            <Text className="text-[13px] text-muted-foreground">
              {t("agents.hires")}
            </Text>
          </View>
        </View>

        {/* Hire button */}
        {agent.allowHiring && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full h-9 mt-3 w-full"
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
