/**
 * Agent Session Activity — Timeline view of all agent actions in a session.
 *
 * Shows a chronological feed of tool calls, observations, errors, threats,
 * and model responses. Entries can be expanded for full details.
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { Text } from "@/components/ui/text";
import {
  ArrowLeft,
  Terminal,
  Globe,
  FileEdit,
  Users,
  Brain,
  AlertTriangle,
  ShieldAlert,
  ShieldX,
  CheckCircle2,
  XCircle,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Clock,
} from "lucide-react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useColorScheme } from "@/lib/useColorScheme";
import { cn } from "@/lib/utils";
import apiClient from "@/lib/api/client";

interface EventEntry {
  _id: string;
  seq: number;
  timestamp: number;
  type: string;
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    exitCode?: number;
    durationMs?: number;
    tokenEstimate?: number;
  };
}

interface SessionInfo {
  status: string;
  task: string;
  result?: string;
  stats: {
    totalTokens: number;
    totalSteps: number;
    creditsCharged?: number;
    startedAt: string;
    completedAt?: string;
  };
}

const EVENT_ICONS: Record<string, React.ComponentType<any>> = {
  action: Terminal,
  observation: MessageSquare,
  error: XCircle,
  system_message: AlertTriangle,
  thinking: Brain,
  response: MessageSquare,
  complete: CheckCircle2,
  threat_detected: ShieldAlert,
  user_message: MessageSquare,
  plan_update: FileEdit,
  plan_progress: FileEdit,
  file_change: FileEdit,
  source_found: Globe,
};

const EVENT_COLORS: Record<string, string> = {
  action: "text-blue-500",
  observation: "text-green-500",
  error: "text-red-500",
  system_message: "text-yellow-500",
  thinking: "text-purple-500",
  response: "text-foreground",
  complete: "text-green-600",
  threat_detected: "text-red-600",
  user_message: "text-foreground",
  plan_update: "text-indigo-500",
  plan_progress: "text-indigo-500",
  file_change: "text-orange-500",
  source_found: "text-cyan-500",
};

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function EventCard({ entry }: { entry: EventEntry }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = EVENT_ICONS[entry.type] || MessageSquare;
  const color = EVENT_COLORS[entry.type] || "text-muted-foreground";

  const isThreat = entry.type === "threat_detected" || entry.content?.includes("THREAT");
  const isError = entry.type === "error";

  return (
    <Pressable
      onPress={() => setExpanded(!expanded)}
      className={cn(
        "mx-4 mb-2 p-3 rounded-lg border",
        isThreat ? "border-red-500/30 bg-red-500/5" :
        isError ? "border-red-500/20 bg-red-500/5" :
        "border-border bg-card"
      )}
    >
      <View className="flex-row items-start gap-2">
        <Icon size={14} className={cn(color, "mt-0.5")} />
        <View className="flex-1">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center gap-2 flex-1">
              <Text className={cn("text-xs font-semibold uppercase", color)}>
                {entry.type.replace(/_/g, " ")}
              </Text>
              {entry.metadata?.toolName && (
                <Text className="text-xs text-muted-foreground">
                  {entry.metadata.toolName}
                </Text>
              )}
            </View>
            <View className="flex-row items-center gap-1">
              {entry.metadata?.durationMs && (
                <Text className="text-xs text-muted-foreground">
                  {formatDuration(entry.metadata.durationMs)}
                </Text>
              )}
              <Text className="text-xs text-muted-foreground">
                {formatTimestamp(entry.timestamp)}
              </Text>
              {expanded ? (
                <ChevronUp size={12} className="text-muted-foreground" />
              ) : (
                <ChevronDown size={12} className="text-muted-foreground" />
              )}
            </View>
          </View>

          <Text className="text-sm text-foreground mt-1" numberOfLines={expanded ? undefined : 2}>
            {entry.content}
          </Text>

          {expanded && entry.metadata?.args && (
            <View className="mt-2 p-2 rounded bg-muted">
              <Text className="text-xs font-mono text-muted-foreground">
                {JSON.stringify(entry.metadata.args, null, 2)}
              </Text>
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

export default function SessionActivityScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const router = useRouter();
  const { colors } = useColorScheme();

  const [entries, setEntries] = useState<EventEntry[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadActivity = useCallback(async () => {
    if (!sessionId) return;
    try {
      // Use the agentId 'any' since the route validates session ownership
      const res = await apiClient.get(`/agents/any/sessions/${sessionId}/activity`);
      setEntries(res.data.entries || []);
      setSession(res.data.session || null);
    } catch (err) {
      // silent
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadActivity();
  }, [loadActivity]);

  const statusColor =
    session?.status === "completed" ? "text-green-500" :
    session?.status === "failed" ? "text-red-500" :
    session?.status === "running" ? "text-blue-500" :
    "text-muted-foreground";

  const threatCount = entries.filter(
    (e) => e.type === "threat_detected" || e.content?.includes("THREAT")
  ).length;
  const errorCount = entries.filter((e) => e.type === "error").length;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center gap-3 px-4 py-3 border-b border-border">
        <Pressable onPress={() => router.back()} className="active:opacity-70">
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground">
            Session Activity
          </Text>
          {session && (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {session.task}
            </Text>
          )}
        </View>
        {session && (
          <Text className={cn("text-xs font-semibold uppercase", statusColor)}>
            {session.status}
          </Text>
        )}
      </View>

      {/* Stats bar */}
      {session && (
        <View className="flex-row items-center gap-4 px-4 py-2 border-b border-border">
          <View className="flex-row items-center gap-1">
            <Clock size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">
              {session.stats.totalSteps} steps
            </Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            {entries.length} events
          </Text>
          {threatCount > 0 && (
            <View className="flex-row items-center gap-1">
              <ShieldX size={12} className="text-red-500" />
              <Text className="text-xs text-red-500">
                {threatCount} threats
              </Text>
            </View>
          )}
          {errorCount > 0 && (
            <View className="flex-row items-center gap-1">
              <XCircle size={12} className="text-red-500" />
              <Text className="text-xs text-red-500">
                {errorCount} errors
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Activity timeline */}
      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={colors.foreground} />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item._id || String(item.seq)}
          renderItem={({ item }) => <EventCard entry={item} />}
          contentContainerStyle={{ paddingVertical: 12 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center py-20">
              <Text className="text-muted-foreground">No activity recorded</Text>
            </View>
          }
        />
      )}
    </View>
  );
}
