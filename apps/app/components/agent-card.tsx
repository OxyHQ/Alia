import React from "react";
import { View, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Text } from "@/components/ui/text";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Plus, Zap } from "lucide-react-native";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { Agent } from "@/lib/stores/agents-store";

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
  const bannerHeight = isFeatured ? 70 : 60;
  const avatarSize = isFeatured ? "h-14 w-14" : "h-12 w-12";
  const avatarOffset = isFeatured ? -28 : -24;

  return (
    <Pressable
      onPress={() => onPress(agent.id)}
      className="active:opacity-80"
      style={isFeatured ? { width: 280 } : undefined}
    >
      <View className="rounded-2xl overflow-hidden border border-border bg-surface">
        {/* Banner */}
        <LinearGradient
          colors={agent.bannerGradient as [string, string, ...string[]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ height: bannerHeight }}
        />

        {/* Content */}
        <View className="px-3 pb-3">
          {/* Avatar overlapping banner */}
          <View className="flex-row items-end" style={{ marginTop: avatarOffset }}>
            <View className="relative">
              <Avatar className={cn(avatarSize, "border-2 border-surface")}>
                {agent.avatar ? (
                  <AvatarImage source={{ uri: agent.avatar }} />
                ) : (
                  <AvatarFallback>
                    <Text className={cn("font-bold text-foreground", isFeatured ? "text-lg" : "text-base")}>
                      {agent.name.charAt(0)}
                    </Text>
                  </AvatarFallback>
                )}
              </Avatar>
              {/* Status dot */}
              <View
                className={cn(
                  "absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface",
                  STATUS_COLORS[agent.status]
                )}
              />
            </View>
          </View>

          {/* Name + verified */}
          <View className="flex-row items-center gap-1 mt-2">
            <Text className="text-[14px] font-bold text-foreground" numberOfLines={1}>
              {agent.name}
            </Text>
            {agent.isVerified && (
              <CheckCircle2
                size={13}
                className="text-blue-500"
                fill="#3b82f6"
                strokeWidth={0}
              />
            )}
          </View>

          {/* Handle */}
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
            {agent.handle}
          </Text>

          {/* Tagline */}
          <Text
            className="text-[12px] text-muted-foreground leading-4 mt-1.5"
            numberOfLines={2}
          >
            {agent.tagline}
          </Text>

          {/* Stats */}
          <View className="flex-row items-center gap-1.5 mt-2">
            <Text className="text-[11px] font-semibold text-foreground">
              {formatCount(agent.followerCount)}
            </Text>
            <Text className="text-[11px] text-muted-foreground">
              {t("agents.followers")}
            </Text>
            <Text className="text-[11px] text-muted-foreground mx-0.5">·</Text>
            <Text className="text-[11px] font-semibold text-foreground">
              {formatCount(agent.hireCount)}
            </Text>
            <Text className="text-[11px] text-muted-foreground">
              {t("agents.hires")}
            </Text>
          </View>

          {/* Action Buttons */}
          <View className="flex-row gap-2 mt-3">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 rounded-full h-8"
              onPress={(e) => {
                e.stopPropagation?.();
                onFollow?.(agent.id);
              }}
            >
              <View className="flex-row items-center gap-1">
                <Plus size={13} className="text-foreground" />
                <Text className="text-[11px] font-medium text-foreground">
                  {t("agents.follow")}
                </Text>
              </View>
            </Button>
            <Button
              size="sm"
              className="flex-1 rounded-full h-8"
              onPress={(e) => {
                e.stopPropagation?.();
                onHire?.(agent.id);
              }}
            >
              <View className="flex-row items-center gap-1">
                <Zap size={12} className="text-primary-foreground" />
                <Text className="text-[11px] font-semibold text-primary-foreground">
                  {agent.price != null
                    ? `${t("agents.hire")} · $${agent.price.toFixed(2)}`
                    : t("agents.hire")}
                </Text>
              </View>
            </Button>
          </View>
        </View>
      </View>
    </Pressable>
  );
});
