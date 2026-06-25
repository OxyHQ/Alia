import React, { useEffect, useState, useCallback } from "react";
import { View, ScrollView, Pressable, Share, TextInput, Alert, useWindowDimensions, ActivityIndicator } from "react-native";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { AliaFace } from "@/components/ui/alia-face";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  BadgeCheck,
  CheckCircle2,
  Star,
  Send,
  Bookmark,
  Ellipsis,
  Share2,
  Trash2,
} from "lucide-react-native";
import { useAgentsStore, type Agent } from "@/lib/stores/agents-store";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { useOxy } from "@oxyhq/services";
import { toast } from "@/components/sonner";
import { SectionLabel, PillList, ActivityGrid } from "@/components/detail";
import { AgentTerminal } from "@/components/agent-terminal";
import apiClient from "@/lib/api/client";
import { useColorScheme } from "@/lib/useColorScheme";
import { cn } from "@/lib/utils";
import { useCreateConversation } from "@/lib/hooks/use-conversations";
import { useAgentFavoritesStore } from "@/lib/stores/agent-favorites-store";
import { errorMessage as getErrorMessage, errorStatus, errorResponseData } from "@/lib/errors/error-utils";

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

function StarRatingInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <View className="flex-row gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <Pressable key={star} onPress={() => onChange(star)} className="p-0.5">
          <Star
            size={20}
            className={star <= value ? "text-amber-500" : "text-muted-foreground/30"}
            fill={star <= value ? "#f59e0b" : "transparent"}
          />
        </Pressable>
      ))}
    </View>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

// ─── Report Item ────────────────────────────────────────────────────────────

interface ReportItem {
  _id: string;
  status: "success" | "failed" | string;
  createdAt: string;
  durationMs?: number;
  result?: string;
}

function ReportCard({ item }: { item: ReportItem }) {
  const isSuccess = item.status === "success";
  const preview = (item.result || "").slice(0, 200);
  return (
    <View className="rounded-2xl bg-surface border border-border p-4 mb-3">
      <View className="flex-row items-center justify-between mb-2">
        <View
          className={cn(
            "px-2 py-0.5 rounded-full",
            isSuccess ? "bg-green-500/10" : "bg-red-500/10"
          )}
        >
          <Text
            className={cn(
              "text-[11px] font-semibold",
              isSuccess ? "text-green-600" : "text-red-500"
            )}
          >
            {item.status}
          </Text>
        </View>
        <View className="flex-row items-center gap-3">
          {item.durationMs != null && (
            <Text className="text-[11px] text-muted-foreground">
              {formatDuration(item.durationMs)}
            </Text>
          )}
          <Text className="text-[11px] text-muted-foreground">
            {formatRelativeTime(item.createdAt)}
          </Text>
        </View>
      </View>
      {preview ? (
        <Text className="text-[13px] text-foreground/80 leading-[18px]">
          {preview}
          {(item.result || "").length > 200 ? "…" : ""}
        </Text>
      ) : null}
    </View>
  );
}

// ─── Routing Log Item ───────────────────────────────────────────────────────

interface RoutingLogItem {
  _id: string;
  classification?: {
    category?: string;
    priority?: "urgent" | "high" | "medium" | "low" | string;
    confidence?: number;
  };
  inboundSummary?: string;
  routedTo?: { type?: string; id?: string; name?: string } | null;
  reasoning?: string;
  status?: string;
  createdAt: string;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-green-500",
};

const PRIORITY_TEXT_COLORS: Record<string, string> = {
  urgent: "text-red-500",
  high: "text-orange-500",
  medium: "text-yellow-500",
  low: "text-green-500",
};

function RoutingLogCard({ item }: { item: RoutingLogItem }) {
  const priority = item.classification?.priority ?? "medium";
  const category = item.classification?.category;
  const dotColor = PRIORITY_COLORS[priority] ?? "bg-gray-400";
  const textColor = PRIORITY_TEXT_COLORS[priority] ?? "text-gray-400";
  return (
    <View className="rounded-2xl bg-surface border border-border p-4 mb-3">
      <View className="flex-row items-center justify-between mb-1.5">
        <View className="flex-row items-center gap-2">
          <View className={cn("w-2 h-2 rounded-full", dotColor)} />
          {category ? (
            <Text className="text-[12px] font-medium text-foreground">
              {category}
            </Text>
          ) : null}
          <Text className={cn("text-[11px] font-semibold capitalize", textColor)}>
            {priority}
          </Text>
        </View>
        <Text className="text-[11px] text-muted-foreground">
          {formatRelativeTime(item.createdAt)}
        </Text>
      </View>
      {item.inboundSummary ? (
        <Text className="text-[13px] text-foreground/80 leading-[18px] mb-1.5">
          {item.inboundSummary}
        </Text>
      ) : null}
      <View className="flex-row items-center gap-2">
        {item.routedTo?.name ? (
          <Text className="text-[12px] text-muted-foreground">
            → {item.routedTo.name}
          </Text>
        ) : null}
        {item.status ? (
          <View className="px-1.5 py-0.5 rounded bg-muted/50">
            <Text className="text-[10px] text-muted-foreground">{item.status}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ─── Detail Tab Bar ─────────────────────────────────────────────────────────

type DetailTab = "overview" | "reports" | "routing";

function DetailTabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: DetailTab; label: string }[];
  active: DetailTab;
  onChange: (t: DetailTab) => void;
}) {
  return (
    <View className="flex-row border-b border-border mb-5">
      {tabs.map((tab) => (
        <Pressable
          key={tab.key}
          onPress={() => onChange(tab.key)}
          className="mr-5 pb-2.5 active:opacity-70"
        >
          <Text
            className={cn(
              "text-[13px] font-medium",
              active === tab.key
                ? "text-foreground border-b-2 border-primary"
                : "text-muted-foreground"
            )}
          >
            {tab.label}
          </Text>
          {active === tab.key && (
            <View className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
          )}
        </Pressable>
      ))}
    </View>
  );
}

export default function AgentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const getAgent = useAgentsStore((state) => state.getAgent);
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy();
  const { colors } = useColorScheme();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
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

  // Archetype tab state
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [routingLogs, setRoutingLogs] = useState<RoutingLogItem[]>([]);
  const [routingLoading, setRoutingLoading] = useState(false);

  // Review state
  const [reviews, setReviews] = useState<any[]>([]);
  const [userReview, setUserReview] = useState<any>(null);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);

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

  // Load reviews
  useEffect(() => {
    if (id) {
      apiClient.get(`/agents/${id}/reviews`).then((res) => {
        setReviews(res.data?.reviews || []);
        setUserReview(res.data?.userReview || null);
        if (res.data?.userReview) {
          setReviewRating(res.data.userReview.rating);
          setReviewComment(res.data.userReview.comment || "");
        }
      }).catch((err) => console.error('Failed to load reviews:', err));
    }
  }, [id]);

  // Load reports when reports tab becomes active (status_update archetype)
  const archetype = agent?.archetype;
  useEffect(() => {
    if (detailTab !== "reports" || !id || archetype !== "status_update") return;
    setReportsLoading(true);
    apiClient
      .get(`/agents/${id}/reports`)
      .then((res) => setReports(res.data?.reports || res.data || []))
      .catch((err) => console.error("Failed to load reports:", err))
      .finally(() => setReportsLoading(false));
  }, [detailTab, id, archetype]);

  // Load routing logs when routing tab becomes active (task_router archetype)
  useEffect(() => {
    if (detailTab !== "routing" || !id || archetype !== "task_router") return;
    setRoutingLoading(true);
    apiClient
      .get(`/agents/${id}/routing-logs`)
      .then((res) => setRoutingLogs(res.data?.logs || res.data || []))
      .catch((err) => console.error("Failed to load routing logs:", err))
      .finally(() => setRoutingLoading(false));
  }, [detailTab, id, archetype]);

  const isOwner = !!(user && agent && user.id === agent.author);
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
      const res = await apiClient.post(`/agents/${agent._id}/hire`, {
        task: taskInput.trim(),
      });
      setTaskInput("");
      setShowHireInput(false);
      toast.success(t("agents.hireStarted"));

      // Open agent panel if session was created
      const sessionId = res.data?.sessionId;
      if (sessionId) {
        const { useUIStore } = await import("@/lib/stores/ui-store");
        useUIStore.getState().openAgentPanel(String(sessionId), agent._id);
      }
    } catch (err: unknown) {
      const status = errorStatus(err);
      const data = errorResponseData(err);
      if (status === 402) {
        toast.error(`Insufficient credits. You need ${data?.creditsNeeded || 'more'} credits.`);
        // Open credits panel
        const { useUIStore } = await import("@/lib/stores/ui-store");
        useUIStore.getState().setRightPanel("credits");
      } else if (status === 503) {
        toast.error("Agent infrastructure unavailable. Try again later.");
      } else {
        toast.error(data?.error || "Failed to hire agent");
      }
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
      const res = await apiClient.get("/agents/teams");
      const teams = res.data.teams || [];

      if (teams.length === 0) {
        toast.info(t("agents.noTeams"));
        return;
      }

      if (teams.length === 1) {
        await apiClient.post(`/agents/teams/${teams[0]._id}/agents`, { agentId: agent._id });
        toast.success(t("agents.addedToTeam"));
      } else {
        Alert.alert(
          t("agents.addToTeam"),
          t("agents.selectTeam"),
          [
            ...teams.slice(0, 4).map((team: any) => ({
              text: team.name,
              onPress: async () => {
                try {
                  await apiClient.post(`/agents/teams/${team._id}/agents`, { agentId: agent._id });
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

  const handleSubmitReview = useCallback(async () => {
    if (!agent || !reviewRating || submittingReview) return;
    setSubmittingReview(true);
    try {
      const res = await apiClient.post(`/agents/${agent._id}/reviews`, {
        rating: reviewRating,
        comment: reviewComment.trim(),
      });
      setUserReview(res.data.review);
      setAgent({ ...agent, rating: res.data.rating, reviewCount: res.data.reviewCount });
      setShowReviewForm(false);
      toast.success(t("agents.reviewSubmitted"));
      const reviewsRes = await apiClient.get(`/agents/${agent._id}/reviews`);
      setReviews(reviewsRes.data?.reviews || []);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to submit review"));
    } finally {
      setSubmittingReview(false);
    }
  }, [agent, reviewRating, reviewComment, submittingReview, t]);

  const handleDeleteReview = useCallback(async () => {
    if (!agent) return;
    Alert.alert(t("agents.deleteReview"), t("agents.deleteReviewConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("agents.deleteReview"),
        style: "destructive",
        onPress: async () => {
          try {
            await apiClient.delete(`/agents/${agent._id}/reviews`);
            setUserReview(null);
            setReviewRating(0);
            setReviewComment("");
            toast.success(t("agents.reviewDeleted"));
            const [agentRes, reviewsRes] = await Promise.all([
              getAgent(agent._id),
              apiClient.get(`/agents/${agent._id}/reviews`),
            ]);
            if (agentRes) setAgent(agentRes);
            setReviews(reviewsRes.data?.reviews || []);
          } catch {
            toast.error("Failed to delete review");
          }
        },
      },
    ]);
  }, [agent, t, getAgent]);

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
      <View className="px-4 py-2.5 z-10 flex-row items-center gap-3 border-b border-border">
        <Pressable
          onPress={() => router.back()}
          className="active:opacity-70 p-1"
        >
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        {isLargeScreen && (
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            {agent.name}
          </Text>
        )}
      </View>

      {/* Content area: side-by-side on desktop, stacked on mobile */}
      <View className={cn("flex-1", isLargeScreen && "flex-row")}>
        {/* Left panel (or full-width on mobile): agent details */}
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <View className={cn("px-5 pb-6 pt-4", isLargeScreen && "px-6 max-w-2xl")}>
            {/* Avatar */}
            <View className="relative self-start">
              <AliaFace size={80} accessories={agent.accessories} />
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
                  <BadgeCheck size={16} className="text-blue-500" />
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
                  @{agent.handle}
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
                />
              </View>
            )}

            {/* Action Buttons — shadcn button group */}
            <View className="flex-row self-start rounded-md border border-border overflow-hidden mb-4">
              {isOwner && (
                <>
                  <Pressable
                    onPress={() => router.push(`/(app)/agents/edit/${agent._id}` as any)}
                    className="items-center justify-center px-3.5 py-2 active:bg-muted"
                  >
                    <Text className="text-[13px] font-medium text-foreground">
                      {t("agents.edit")}
                    </Text>
                  </Pressable>
                  <View className="w-px bg-border" />
                </>
              )}
              <Pressable
                onPress={handleChat}
                className="items-center justify-center px-3.5 py-2 active:bg-muted"
              >
                <Text className="text-[13px] font-medium text-foreground">
                  {t("agents.chat")}
                </Text>
              </Pressable>
              <View className="w-px bg-border" />
              <Pressable
                onPress={handleHirePress}
                className="items-center justify-center px-3.5 py-2 active:bg-muted"
              >
                <Text className="text-[13px] font-medium text-foreground">
                  {agent.price != null
                    ? `${t("agents.hire")} · $${agent.price.toFixed(2)}`
                    : t("agents.hire")}
                </Text>
              </Pressable>
              <View className="w-px bg-border" />
              <Pressable
                onPress={handleAddToTeam}
                disabled={addingToTeam}
                className="items-center justify-center px-3.5 py-2 active:bg-muted"
              >
                <Text className="text-[13px] font-medium text-foreground">
                  {t("agents.addToTeam")}
                </Text>
              </Pressable>
              <View className="w-px bg-border" />
              <Pressable
                onPress={handleShare}
                className="items-center justify-center px-3 py-2 active:bg-muted"
              >
                <Share2 size={15} className="text-foreground" />
              </Pressable>
              <View className="w-px bg-border" />
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Pressable className="items-center justify-center px-2.5 py-2">
                    <Ellipsis size={16} className="text-foreground" />
                  </Pressable>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  <DropdownMenu.Item key="bookmark" onSelect={handleBookmark}>
                    <DropdownMenu.ItemIcon ios={{ name: bookmarked ? "bookmark.fill" : "bookmark" }} />
                    <DropdownMenu.ItemTitle>
                      {bookmarked ? t("agents.removeBookmark") : t("agents.bookmark")}
                    </DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item key="report" onSelect={() => toast.info(t("agents.reportSubmitted"))}>
                    <DropdownMenu.ItemIcon ios={{ name: "exclamationmark.triangle" }} />
                    <DropdownMenu.ItemTitle>{t("agents.report")}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </View>

            {/* Hire Task Input */}
            {showHireInput && (
              <View className="mb-5 bg-muted/30 rounded-xl px-3 py-2 border border-border">
                <TextInput
                  value={taskInput}
                  onChangeText={setTaskInput}
                  placeholder={t("agents.taskPlaceholder")}
                  placeholderTextColor={colors.mutedForeground}
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

            {/* Archetype Tab Bar */}
            {(agent.archetype === "status_update" || agent.archetype === "task_router") && (
              <DetailTabBar
                tabs={[
                  { key: "overview", label: "Overview" },
                  ...(agent.archetype === "status_update"
                    ? [{ key: "reports", label: "Reports" }]
                    : [{ key: "routing", label: "Routing" }]),
                ]}
                active={detailTab}
                onChange={setDetailTab}
              />
            )}

            {/* Reports Tab Content */}
            {detailTab === "reports" && agent.archetype === "status_update" && (
              <View className="mb-5">
                {reportsLoading ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primary}
                    style={{ marginVertical: 24 }}
                  />
                ) : reports.length === 0 ? (
                  <View className="items-center py-10">
                    <Text className="text-[14px] text-muted-foreground">
                      No reports yet
                    </Text>
                  </View>
                ) : (
                  <View>
                    {reports.map((item) => (
                      <ReportCard key={item._id} item={item} />
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* Routing Tab Content */}
            {detailTab === "routing" && agent.archetype === "task_router" && (
              <View className="mb-5">
                {routingLoading ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primary}
                    style={{ marginVertical: 24 }}
                  />
                ) : routingLogs.length === 0 ? (
                  <View className="items-center py-10">
                    <Text className="text-[14px] text-muted-foreground">
                      No routing activity yet
                    </Text>
                  </View>
                ) : (
                  <View>
                    {routingLogs.map((item) => (
                      <RoutingLogCard key={item._id} item={item} />
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* Overview Tab Content (shown for all archetypes when overview is active) */}
            {detailTab === "overview" && (
              <>
                {/* Activity Grid */}
                <View className="mb-5">
                  <SectionLabel>{t("agents.activity")}</SectionLabel>
                  <View className="mt-2">
                    <ActivityGrid agentId={agent._id} />
                  </View>
                </View>

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

                {/* Reviews */}
                <View className="h-px bg-border mx-0 mb-5" />
                <View className="mb-5">
                  <View className="flex-row items-center justify-between mb-3">
                    <SectionLabel>{t("agents.reviews")}</SectionLabel>
                    {user && !isOwner && !showReviewForm && (
                      <Pressable
                        onPress={() => setShowReviewForm(true)}
                        className="active:opacity-70"
                      >
                        <Text className="text-[12px] font-medium text-primary">
                          {userReview ? t("agents.editReview") : t("agents.writeReview")}
                        </Text>
                      </Pressable>
                    )}
                  </View>

                  {/* Review Form */}
                  {showReviewForm && (
                    <View className="bg-muted/30 rounded-xl px-4 py-3 border border-border mb-4">
                      <View className="mb-3">
                        <StarRatingInput value={reviewRating} onChange={setReviewRating} />
                      </View>
                      <TextInput
                        value={reviewComment}
                        onChangeText={setReviewComment}
                        placeholder={t("agents.reviewPlaceholder")}
                        placeholderTextColor={colors.mutedForeground}
                        multiline
                        numberOfLines={3}
                        style={{
                          color: "#fff",
                          fontSize: 14,
                          paddingVertical: 8,
                          minHeight: 60,
                          textAlignVertical: "top",
                        }}
                      />
                      <View className="flex-row justify-end gap-2 mt-2">
                        <Pressable
                          onPress={() => setShowReviewForm(false)}
                          className="px-3 py-1.5 active:opacity-70"
                        >
                          <Text className="text-[13px] text-muted-foreground">
                            {t("common.cancel")}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={handleSubmitReview}
                          disabled={!reviewRating || submittingReview}
                          className={cn(
                            "px-3 py-1.5 rounded-md active:opacity-70",
                            reviewRating ? "bg-primary" : "bg-muted"
                          )}
                        >
                          <Text className={cn(
                            "text-[13px] font-medium",
                            reviewRating ? "text-primary-foreground" : "text-muted-foreground"
                          )}>
                            {submittingReview ? "..." : t("agents.writeReview")}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  )}

                  {/* Reviews List */}
                  {reviews.length === 0 && !showReviewForm ? (
                    <Text className="text-[13px] text-muted-foreground">
                      {t("agents.noReviews")}
                    </Text>
                  ) : (
                    <View className="gap-3">
                      {reviews.map((review: any) => (
                        <View key={review._id} className="gap-1">
                          <View className="flex-row items-center justify-between">
                            <View className="flex-row items-center gap-2">
                              <Text className="text-[13px] font-medium text-foreground">
                                {review.userId?.username || "User"}
                              </Text>
                              <View className="flex-row">
                                {[1, 2, 3, 4, 5].map((star) => (
                                  <Star
                                    key={star}
                                    size={10}
                                    className={star <= review.rating ? "text-amber-500" : "text-muted-foreground/20"}
                                    fill={star <= review.rating ? "#f59e0b" : "transparent"}
                                  />
                                ))}
                              </View>
                            </View>
                            {user && review.userId?._id === user.id && (
                              <Pressable onPress={handleDeleteReview} className="p-1 active:opacity-70">
                                <Trash2 size={12} className="text-muted-foreground" />
                              </Pressable>
                            )}
                          </View>
                          {review.comment ? (
                            <Text className="text-[13px] text-foreground/80 leading-[18px]">
                              {review.comment}
                            </Text>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  )}
                </View>

                {/* Activity Terminal — mobile only */}
                {!isLargeScreen && (
                  <>
                    <View className="h-px bg-border mx-0 mb-5" />
                    <View className="mb-5">
                      <SectionLabel>{t("agents.activity")}</SectionLabel>
                      <View style={{ height: 300 }} className="rounded-lg overflow-hidden mt-2">
                        <AgentTerminal agentId={agent._id} />
                      </View>
                    </View>
                  </>
                )}
              </>
            )}
          </View>
        </ScrollView>

        {/* Right panel: terminal — desktop only */}
        {isLargeScreen && (
          <View className="flex-1 p-4 pl-0">
            <View className="flex-1 bg-[#0d0d0d] rounded-xl overflow-hidden border border-border">
              <View className="px-4 py-2.5 flex-row items-center gap-2 border-b border-white/5">
                <View className="w-2 h-2 rounded-full bg-green-500" />
                <Text className="text-xs font-medium text-[#808080]">
                  {t("agents.activity")}
                </Text>
              </View>
              <View className="flex-1">
                <AgentTerminal agentId={agent._id} />
              </View>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}
