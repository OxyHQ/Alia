import React, { useEffect, useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  ArrowLeft,
  CheckCircle2,
  Plus,
  Zap,
  Share2,
  Star,
} from "lucide-react-native";
import { useAgentsStore, type Agent } from "@/lib/stores/agents-store";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { toast } from "@/components/sonner";
import { SectionLabel, PillList } from "@/components/detail";
import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500",
  idle: "bg-yellow-500",
  offline: "bg-gray-400",
};

const STATUS_TEXT_COLORS: Record<string, string> = {
  active: "text-green-500",
  idle: "text-yellow-500",
  offline: "text-gray-400",
};

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function AgentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getAgent = useAgentsStore((state) => state.getAgent);
  const followAgent = useAgentsStore((state) => state.followAgent);
  const router = useRouter();
  const { t } = useTranslation();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) {
      setLoading(true);
      getAgent(id).then((data) => {
        setAgent(data);
        setLoading(false);
      });
    }
  }, [id, getAgent]);

  const handleFollow = async () => {
    if (!agent) return;
    await followAgent(agent._id);
    const updated = await getAgent(agent._id);
    if (updated) setAgent(updated);
  };

  const handleHire = () => {
    toast.info(t("agents.hireComingSoon"));
  };

  const handleShare = () => {
    toast.info(t("agents.shareComingSoon"));
  };

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t("common.loading")}</Text>
      </View>
    );
  }

  if (!agent) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <Text className="text-muted-foreground">{t("agents.notFound")}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      {/* Back Header */}
      <View className="px-5 py-3 z-10">
        <Pressable
          onPress={() => router.back()}
          className="active:opacity-70 self-start"
        >
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/* Banner */}
        <LinearGradient
          colors={agent.bannerGradient as [string, string, ...string[]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ height: 120 }}
        />

        <View className="px-5 pb-6">
          {/* Avatar overlapping banner */}
          <View className="flex-row items-end" style={{ marginTop: -40 }}>
            <View className="relative">
              <Avatar className="h-20 w-20 border-4 border-background">
                {agent.avatar ? (
                  <AvatarImage source={{ uri: agent.avatar }} />
                ) : (
                  <AvatarFallback>
                    <Text className="text-2xl font-bold text-foreground">
                      {agent.name.charAt(0)}
                    </Text>
                  </AvatarFallback>
                )}
              </Avatar>
              <View
                className={cn(
                  "absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-background",
                  STATUS_COLORS[agent.status]
                )}
              />
            </View>
          </View>

          {/* Name + Verified + Status */}
          <View className="mt-3">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-xl font-bold text-foreground">
                {agent.name}
              </Text>
              {agent.isVerified && (
                <CheckCircle2
                  size={16}
                  className="text-blue-500"
                  fill="#3b82f6"
                  strokeWidth={0}
                />
              )}
              <View
                className={cn(
                  "px-2 py-0.5 rounded-full ml-1",
                  agent.status === "active"
                    ? "bg-green-500/15"
                    : agent.status === "idle"
                      ? "bg-yellow-500/15"
                      : "bg-gray-500/15"
                )}
              >
                <Text
                  className={cn(
                    "text-[10px] font-semibold",
                    STATUS_TEXT_COLORS[agent.status]
                  )}
                >
                  {t(`agents.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}`)}
                </Text>
              </View>
            </View>

            {/* Handle + Author */}
            <View className="flex-row items-center gap-1 mt-0.5">
              <Text className="text-[13px] text-muted-foreground">
                {agent.handle}
              </Text>
              <Text className="text-[13px] text-muted-foreground mx-1">·</Text>
              <Text className="text-[13px] text-muted-foreground">
                {agent.authorName}
              </Text>
              {agent.authorVerified && (
                <CheckCircle2
                  size={11}
                  className="text-blue-500"
                  fill="#3b82f6"
                  strokeWidth={0}
                />
              )}
            </View>
          </View>

          {/* Tagline */}
          {agent.tagline && (
            <Text className="text-[14px] text-muted-foreground leading-5 mt-2">
              {agent.tagline}
            </Text>
          )}

          {/* Stats Row */}
          <View className="flex-row items-center gap-4 mt-3 mb-4">
            <View className="flex-row items-center gap-1">
              <Star size={13} className="text-amber-500" fill="#f59e0b" />
              <Text className="text-[13px] font-bold text-foreground">
                {agent.rating}
              </Text>
              <Text className="text-[11px] text-muted-foreground">
                ({agent.reviewCount})
              </Text>
            </View>
            <Text className="text-[11px] text-muted-foreground">·</Text>
            <Text className="text-[12px] text-muted-foreground">
              {formatCount(agent.followerCount)} {t("agents.followers")}
            </Text>
            <Text className="text-[11px] text-muted-foreground">·</Text>
            <Text className="text-[12px] text-muted-foreground">
              {formatCount(agent.hireCount)} {t("agents.hires")}
            </Text>
            <Text className="text-[11px] text-muted-foreground">·</Text>
            <Text className="text-[12px] text-muted-foreground">
              {formatCount(agent.usageCount)} {t("agents.uses")}
            </Text>
          </View>

          {/* Action Buttons */}
          <View className="flex-row gap-2 mb-5">
            <Button
              variant="outline"
              onPress={handleFollow}
              className="flex-1 h-11 rounded-full"
            >
              <View className="flex-row items-center gap-1.5">
                <Plus size={15} className="text-foreground" />
                <Text className="text-[13px] font-semibold text-foreground">
                  {t("agents.follow")}
                </Text>
              </View>
            </Button>
            <Button onPress={handleHire} className="flex-1 h-11 rounded-full">
              <View className="flex-row items-center gap-1.5">
                <Zap size={15} className="text-primary-foreground" />
                <Text className="text-[13px] font-semibold text-primary-foreground">
                  {agent.price != null
                    ? `${t("agents.hire")} · $${agent.price.toFixed(2)}`
                    : t("agents.hire")}
                </Text>
              </View>
            </Button>
            <Button
              variant="secondary"
              onPress={handleShare}
              className="h-11 px-4 rounded-full"
            >
              <Share2 size={15} className="text-foreground" />
            </Button>
          </View>

          {/* Price Badge */}
          {agent.price != null && (
            <View className="flex-row items-center gap-1.5 mb-4">
              <Text className="text-[12px] text-muted-foreground">
                ${agent.price.toFixed(2)} per use
              </Text>
            </View>
          )}

          {/* Description */}
          <Text className="text-[14px] text-foreground leading-5 mb-5">
            {agent.description}
          </Text>

          {/* Capabilities */}
          {agent.capabilities.length > 0 && (
            <View className="mb-5">
              <SectionLabel>{t("agents.capabilities")}</SectionLabel>
              <PillList items={agent.capabilities} />
            </View>
          )}

          {/* Tags */}
          {agent.tags.length > 0 && (
            <View className="mb-5">
              <SectionLabel>{t("agents.tags")}</SectionLabel>
              <PillList items={agent.tags} />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
