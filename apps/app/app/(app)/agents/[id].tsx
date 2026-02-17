import React, { useEffect, useState, useCallback } from "react";
import { View, ScrollView, Pressable, Share, TextInput, Switch, Alert } from "react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage } from "@/components/ui/avatar";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DEFAULT_AVATAR = require("@/assets/images/agent-avatar-reference.png");
import {
  ArrowLeft,
  CheckCircle2,
  Zap,
  Share2,
  Star,
  Send,
  MessageCircle,
  Bookmark,
  UserPlus,
} from "lucide-react-native";
import { useAgentsStore, type Agent } from "@/lib/stores/agents-store";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { useOxy } from "@oxyhq/services";
import { toast } from "@/components/sonner";
import { SectionLabel, PillList } from "@/components/detail";
import { AgentTerminal } from "@/components/agent-terminal";
import apiClient from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { useCreateConversation } from "@/lib/hooks/use-conversations";
import { useAgentFavoritesStore } from "@/lib/stores/agent-favorites-store";

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
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);

  // Hire input state
  const [showHireInput, setShowHireInput] = useState(false);
  const [taskInput, setTaskInput] = useState("");
  const [hiring, setHiring] = useState(false);

  // Chat
  const createConversationMutation = useCreateConversation();

  // Favorites
  const toggleFavorite = useAgentFavoritesStore((s) => s.toggleFavorite);
  const isFavorite = useAgentFavoritesStore((s) => s.isFavorite);
  const loadFavorites = useAgentFavoritesStore((s) => s.loadFavorites);

  // Add to team state
  const [addingToTeam, setAddingToTeam] = useState(false);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  useEffect(() => {
    if (id) {
      setLoading(true);
      getAgent(id).then((data) => {
        setAgent(data);
        setLoading(false);
      });
    }
  }, [id, getAgent]);

  const isOwner = !!(user && agent && user._id === agent.author);
  const bookmarked = agent ? isFavorite(agent._id) : false;

  const handleChat = useCallback(async () => {
    if (!agent) return;
    try {
      const conversation = await createConversationMutation.mutateAsync({ agentId: agent._id });
      router.replace(`/(app)/c/${conversation.id}?agentId=${agent._id}` as any);
    } catch {
      toast.error("Failed to start chat");
    }
  }, [agent, createConversationMutation, router]);

  const handleHirePress = () => {
    if (agent?.status !== "active") {
      toast.error(t("agents.notActive"));
      return;
    }
    setShowHireInput(true);
  };

  const handleHireSubmit = useCallback(async () => {
    if (!agent || !taskInput.trim() || hiring) return;
    setHiring(true);
    try {
      await apiClient.post(`/agents/${agent._id}/hire`, {
        task: taskInput.trim(),
      });
      setTaskInput("");
      setShowHireInput(false);
      toast.success(t("agents.hireStarted"));
    } catch (err: any) {
      const msg = err?.response?.data?.error || "Failed to hire agent";
      toast.error(msg);
    } finally {
      setHiring(false);
    }
  }, [agent, taskInput, hiring, t]);

  const handleShare = async () => {
    if (!agent) return;
    try {
      await Share.share({
        message: `${agent.name} — ${agent.tagline}\nhttps://alia.app/agents/${agent._id}`,
      });
    } catch {
      // user cancelled — no action needed
    }
  };

  const handleBookmark = () => {
    if (!agent) return;
    toggleFavorite(agent._id);
  };

  const handleAddToTeam = async () => {
    if (!agent) return;
    setAddingToTeam(true);
    try {
      const res = await apiClient.get("/organization");
      const orgs = res.data.organizations || [];

      if (orgs.length === 0) {
        toast.info(t("agents.noTeams"));
        return;
      }

      // Show simple selection via Alert
      if (orgs.length === 1) {
        await apiClient.post(`/organization/${orgs[0]._id}/agents`, { agentId: agent._id });
        toast.success(t("agents.addedToTeam"));
      } else {
        // For multiple orgs, use Alert with buttons
        Alert.alert(
          t("agents.addToTeam"),
          t("agents.selectTeam"),
          [
            ...orgs.slice(0, 4).map((org: any) => ({
              text: org.name,
              onPress: async () => {
                try {
                  await apiClient.post(`/organization/${org._id}/agents`, { agentId: agent._id });
                  toast.success(t("agents.addedToTeam"));
                } catch {
                  toast.error(t("agents.addToTeamFailed"));
                }
              },
            })),
            { text: t("common.cancel"), style: "cancel" as const },
          ],
        );
      }
    } catch {
      toast.error(t("agents.addToTeamFailed"));
    } finally {
      setAddingToTeam(false);
    }
  };

  const handleStatusToggle = async (newStatus: "active" | "idle") => {
    if (!agent) return;
    try {
      await apiClient.patch(`/agents/${agent._id}/status`, {
        status: newStatus,
      });
      setAgent({ ...agent, status: newStatus });
    } catch {
      toast.error("Failed to update status");
    }
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
      {/* Header */}
      <View className="px-5 py-3 z-10 flex-row items-center justify-between">
        <Pressable
          onPress={() => router.back()}
          className="active:opacity-70"
        >
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <View className="flex-row items-center gap-3">
          <Pressable onPress={handleBookmark} className="active:opacity-70">
            <Bookmark
              size={20}
              className={bookmarked ? "text-primary" : "text-muted-foreground"}
              fill={bookmarked ? "currentColor" : "none"}
            />
          </Pressable>
          <Pressable onPress={handleShare} className="active:opacity-70">
            <Share2 size={20} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="px-5 pb-6 pt-2">
          {/* Avatar */}
          <View className="relative self-start">
            <Avatar className="h-20 w-20">
              <AvatarImage source={agent.avatar ? { uri: agent.avatar } : DEFAULT_AVATAR} />
            </Avatar>
            <View
              className={cn(
                "absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-background",
                STATUS_COLORS[agent.status]
              )}
            />
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
              {formatCount(agent.hireCount)} {t("agents.hires")}
            </Text>
            <Text className="text-[11px] text-muted-foreground">·</Text>
            <Text className="text-[12px] text-muted-foreground">
              {formatCount(agent.usageCount)} {t("agents.uses")}
            </Text>
          </View>

          {/* Owner Controls */}
          {isOwner && (
            <View className="flex-row items-center justify-between bg-muted/50 rounded-xl px-4 py-3 mb-4">
              <View>
                <Text className="text-[13px] font-semibold text-foreground">
                  {agent.status === "active" ? "Active" : "Paused"}
                </Text>
                <Text className="text-[11px] text-muted-foreground">
                  {agent.status === "active"
                    ? "Accepting hires"
                    : "Not accepting hires"}
                </Text>
              </View>
              <Switch
                value={agent.status === "active"}
                onValueChange={(on) =>
                  handleStatusToggle(on ? "active" : "idle")
                }
                trackColor={{ false: "#3e3e3e", true: "#22c55e" }}
                thumbColor="#ffffff"
              />
            </View>
          )}

          {/* Action Buttons: Chat + Hire */}
          <View className="flex-row gap-2 mb-2">
            <Button variant="outline" onPress={handleChat} className="flex-1 h-11 rounded-full">
              <View className="flex-row items-center gap-1.5">
                <MessageCircle size={15} className="text-foreground" />
                <Text className="text-[13px] font-semibold text-foreground">
                  {t("agents.chat")}
                </Text>
              </View>
            </Button>
            <Button onPress={handleHirePress} className="flex-1 h-11 rounded-full">
              <View className="flex-row items-center gap-1.5">
                <Zap size={15} className="text-primary-foreground" />
                <Text className="text-[13px] font-semibold text-primary-foreground">
                  {agent.price != null
                    ? `${t("agents.hire")} · $${agent.price.toFixed(2)}`
                    : t("agents.hire")}
                </Text>
              </View>
            </Button>
          </View>

          {/* Add to Team */}
          <Button
            variant="secondary"
            onPress={handleAddToTeam}
            disabled={addingToTeam}
            className="h-9 rounded-full mb-4"
          >
            <View className="flex-row items-center gap-1.5">
              <UserPlus size={14} className="text-foreground" />
              <Text className="text-[12px] font-medium text-foreground">
                {t("agents.addToTeam")}
              </Text>
            </View>
          </Button>

          {/* Hire Task Input */}
          {showHireInput && (
            <View className="mb-5 bg-muted/30 rounded-xl px-3 py-2 border border-border">
              <TextInput
                value={taskInput}
                onChangeText={setTaskInput}
                placeholder={t("agents.taskPlaceholder")}
                placeholderTextColor="#888"
                editable={!hiring}
                multiline
                numberOfLines={3}
                style={{
                  color: "#fff",
                  fontSize: 14,
                  paddingVertical: 8,
                  minHeight: 72,
                  textAlignVertical: "top",
                }}
              />
              <View className="flex-row justify-end mt-1">
                <Pressable
                  onPress={handleHireSubmit}
                  disabled={hiring || !taskInput.trim()}
                  className="p-2 active:opacity-70"
                >
                  <Send
                    size={18}
                    className={
                      taskInput.trim() ? "text-primary" : "text-muted-foreground"
                    }
                  />
                </Pressable>
              </View>
            </View>
          )}

          {/* Divider */}
          <View className="h-px bg-border mx-0 mb-5" />

          {/* About / Description */}
          <View className="mb-5">
            <SectionLabel>{t("agents.about")}</SectionLabel>
            <Text className="text-[14px] text-foreground leading-5 mt-1">
              {agent.description}
            </Text>
          </View>

          {/* Capabilities */}
          {agent.capabilities.length > 0 && (
            <>
              <View className="h-px bg-border mx-0 mb-5" />
              <View className="mb-5">
                <SectionLabel>{t("agents.capabilities")}</SectionLabel>
                <PillList items={agent.capabilities} />
              </View>
            </>
          )}

          {/* Tags */}
          {agent.tags.length > 0 && (
            <>
              <View className="h-px bg-border mx-0 mb-5" />
              <View className="mb-5">
                <SectionLabel>{t("agents.tags")}</SectionLabel>
                <PillList items={agent.tags} />
              </View>
            </>
          )}

          {/* Activity Terminal */}
          <View className="h-px bg-border mx-0 mb-5" />
          <View className="mb-5">
            <SectionLabel>{t("agents.activity")}</SectionLabel>
            <View style={{ height: 300 }} className="rounded-lg overflow-hidden mt-2">
              <AgentTerminal agentId={agent._id} />
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
