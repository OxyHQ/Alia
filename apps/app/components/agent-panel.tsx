/**
 * AgentPanel — Right panel showing real-time agent activity.
 *
 * 4 tabs: Steps | Browser | Files | Sources
 * Follows the same pattern as ThoughtPanel for consistent UX.
 */

import { useState, useMemo, useEffect } from "react";
import { View, Pressable, ScrollView, Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Text } from "@/components/ui/text";
import {
  X,
  Globe,
  Terminal,
  FileText,
  ChevronRight,
  Monitor,
  FolderOpen,
  Loader,
  CheckCircle2,
  AlertCircle,
  Search,
  Code,
  Eye,
  Edit3,
  Users,
} from "lucide-react-native";
import { useUIStore } from "@/lib/stores/ui-store";
import {
  useAgentActivity,
  type AgentActivityEvent,
  type AgentSource,
} from "@/lib/hooks/use-agent-activity";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
} from "react-native-reanimated";

type Tab = "steps" | "browser" | "files" | "sources";

function TabToggle({
  value,
  onChange,
  sourceCount,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
  sourceCount: number;
}) {
  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: "steps", label: "Steps" },
    { key: "browser", label: "Browser" },
    { key: "files", label: "Files" },
    { key: "sources", label: "Sources", badge: sourceCount || undefined },
  ];

  return (
    <View className="flex-row bg-muted rounded-lg overflow-hidden">
      {tabs.map((tab) => (
        <Pressable
          key={tab.key}
          onPress={() => onChange(tab.key)}
          className={`flex-1 items-center px-2 py-1.5 flex-row justify-center gap-1 ${
            value === tab.key ? "bg-background" : ""
          }`}
        >
          <Text
            className={`text-xs font-medium ${
              value === tab.key
                ? "text-foreground"
                : "text-muted-foreground"
            }`}
          >
            {tab.label}
          </Text>
          {tab.badge ? (
            <View className="bg-primary rounded-full px-1.5 min-w-[18px] items-center">
              <Text className="text-[10px] text-primary-foreground font-bold">
                {tab.badge}
              </Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

function PulsingDot({ color }: { color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 800 }),
        withTiming(1, { duration: 800 })
      ),
      -1,
      false
    );
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[
        { width: 8, height: 8, borderRadius: 4, backgroundColor: color },
        style,
      ]}
    />
  );
}

function getStepIcon(event: AgentActivityEvent) {
  const toolName = event.metadata?.toolName || "";
  switch (event.type) {
    case "thinking":
      return <PulsingDot color="#a855f7" />;
    case "complete":
      return <CheckCircle2 size={14} color="#22c55e" />;
    case "error":
      return <AlertCircle size={14} color="#ef4444" />;
    case "tool_call":
      if (toolName === "shell") return <Terminal size={14} className="text-foreground" />;
      if (toolName === "browser") return <Globe size={14} className="text-foreground" />;
      if (toolName === "file_edit") return <Edit3 size={14} className="text-foreground" />;
      if (toolName === "plan") return <CheckCircle2 size={14} className="text-foreground" />;
      if (toolName === "delegate") return <Users size={14} className="text-foreground" />;
      return <Code size={14} className="text-foreground" />;
    case "tool_result":
      return <Eye size={14} className="text-muted-foreground" />;
    case "source_found":
      return <Search size={14} color="#3b82f6" />;
    case "response":
      return <FileText size={14} className="text-foreground" />;
    default:
      return <Globe size={14} className="text-muted-foreground" />;
  }
}

function getStepLabel(event: AgentActivityEvent): string {
  const toolName = event.metadata?.toolName || "";
  switch (event.type) {
    case "thinking":
      return "Thinking...";
    case "complete":
      return "Task completed";
    case "error":
      return "Error occurred";
    case "system":
      return event.content.slice(0, 60);
    case "tool_call": {
      const args = event.metadata?.args;
      if (toolName === "shell") return `Running: ${args?.command?.slice(0, 50) || "command"}`;
      if (toolName === "browser") return `Browser: ${args?.action || "action"} ${args?.url?.slice(0, 30) || args?.query?.slice(0, 30) || ""}`;
      if (toolName === "file_edit") return `${args?.action || "edit"}: ${args?.path?.slice(0, 40) || "file"}`;
      if (toolName === "plan") return args?.action === "complete" ? "Completing task" : "Updating plan";
      if (toolName === "delegate") return `Hiring @${args?.agent || "agent"}`;
      return `${toolName}(${event.content.slice(0, 40)})`;
    }
    case "tool_result":
      return event.content.slice(0, 80) || "Result received";
    case "source_found":
      return `Found: ${event.metadata?.title || event.metadata?.url || "source"}`;
    case "response":
      return event.content.slice(0, 80);
    default:
      return event.content.slice(0, 60);
  }
}

function StepsTab({ events, isActive }: { events: AgentActivityEvent[]; isActive: boolean }) {
  // Filter to meaningful events (skip system noise)
  const steps = useMemo(() => {
    return events.filter(
      (e) =>
        e.type === "tool_call" ||
        e.type === "tool_result" ||
        e.type === "error" ||
        e.type === "complete" ||
        e.type === "thinking" ||
        e.type === "source_found" ||
        e.type === "response"
    );
  }, [events]);

  if (steps.length === 0) {
    return (
      <View className="items-center justify-center py-8">
        {isActive ? (
          <>
            <PulsingDot color="#3b82f6" />
            <Text className="text-sm text-muted-foreground mt-3">
              Waiting for agent to start...
            </Text>
          </>
        ) : (
          <Text className="text-sm text-muted-foreground">No steps yet</Text>
        )}
      </View>
    );
  }

  return (
    <View className="gap-0">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        const isStepActive = isActive && isLast;

        return (
          <View key={`${step.timestamp}-${index}`} className="flex-row">
            {/* Timeline column */}
            <View className="items-center" style={{ width: 24 }}>
              <View className="h-3" />
              <View
                className="items-center justify-center"
                style={{ width: 20, height: 20 }}
              >
                {isStepActive && step.type === "tool_call" ? (
                  <PulsingDot color="#eab308" />
                ) : (
                  getStepIcon(step)
                )}
              </View>
              {!isLast && (
                <View
                  className="flex-1 border-l border-border"
                  style={{ minHeight: 16 }}
                />
              )}
            </View>

            {/* Content column */}
            <View className="flex-1 pl-2 pb-3" style={{ paddingTop: 12 }}>
              <Text
                className={`text-sm ${
                  step.type === "complete"
                    ? "text-green-500 font-medium"
                    : step.type === "error"
                    ? "text-red-400"
                    : isStepActive
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
                }`}
                numberOfLines={2}
              >
                {getStepLabel(step)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function BrowserTab({ screenshots }: { screenshots: Array<{ base64: string; url: string; timestamp: number }> }) {
  if (screenshots.length === 0) {
    return (
      <View className="items-center justify-center py-8">
        <Monitor size={24} className="text-muted-foreground mb-2" />
        <Text className="text-sm text-muted-foreground">
          No browser activity yet
        </Text>
      </View>
    );
  }

  const latest = screenshots[screenshots.length - 1];

  return (
    <View className="gap-3">
      {/* Latest screenshot */}
      <View className="rounded-lg overflow-hidden border border-border">
        <View className="bg-muted px-2 py-1 flex-row items-center gap-1">
          <Globe size={10} className="text-muted-foreground" />
          <Text className="text-[10px] text-muted-foreground flex-1" numberOfLines={1}>
            {latest.url}
          </Text>
        </View>
        <Animated.Image
          source={{ uri: `data:image/png;base64,${latest.base64}` }}
          style={{ width: "100%", height: 200 }}
          resizeMode="cover"
        />
      </View>

      {/* Thumbnails of previous screenshots */}
      {screenshots.length > 1 && (
        <View className="flex-row gap-2 flex-wrap">
          {screenshots.slice(0, -1).map((s, i) => (
            <View
              key={`ss-${i}`}
              className="rounded-md overflow-hidden border border-border"
            >
              <Animated.Image
                source={{ uri: `data:image/png;base64,${s.base64}` }}
                style={{ width: 80, height: 50 }}
                resizeMode="cover"
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function FilesTab({ files }: { files: string[] }) {
  if (files.length === 0) {
    return (
      <View className="items-center justify-center py-8">
        <FolderOpen size={24} className="text-muted-foreground mb-2" />
        <Text className="text-sm text-muted-foreground">
          No files created yet
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-1">
      <Text className="text-xs font-medium text-muted-foreground mb-1">
        Workspace files ({files.length})
      </Text>
      {files.map((file, i) => (
        <View
          key={`file-${i}`}
          className="flex-row items-center gap-2 px-3 py-2 rounded-lg bg-muted/50"
        >
          <FileText size={14} className="text-muted-foreground" />
          <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
            {file}
          </Text>
        </View>
      ))}
    </View>
  );
}

function SourcesTab({ sources }: { sources: AgentSource[] }) {
  if (sources.length === 0) {
    return (
      <View className="items-center justify-center py-8">
        <Search size={24} className="text-muted-foreground mb-2" />
        <Text className="text-sm text-muted-foreground">
          No sources found yet
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-2">
      <Text className="text-xs font-medium text-muted-foreground">
        Websites ({sources.length})
      </Text>
      {sources.map((source, index) => (
        <Pressable
          key={`${source.url}-${index}`}
          onPress={() => {
            if (Platform.OS === "web") {
              window.open(source.url, "_blank", "noopener,noreferrer");
            } else {
              WebBrowser.openBrowserAsync(source.url);
            }
          }}
          className="rounded-xl border border-border p-3 bg-background active:bg-muted"
        >
          <View className="flex-row items-center gap-2 mb-1">
            <Globe size={12} className="text-muted-foreground" />
            <Text
              className="text-xs text-muted-foreground"
              numberOfLines={1}
            >
              {source.domain}
            </Text>
            <View className="flex-1" />
            <ChevronRight size={12} className="text-muted-foreground" />
          </View>
          <Text
            className="text-sm font-medium text-foreground"
            numberOfLines={2}
          >
            {source.title || source.url}
          </Text>
          {source.snippet.length > 0 && (
            <Text
              className="text-xs text-muted-foreground mt-0.5"
              numberOfLines={2}
            >
              {source.snippet}
            </Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

export function AgentPanel() {
  const [activeTab, setActiveTab] = useState<Tab>("steps");
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const activeAgentSessionId = useUIStore((s) => s.activeAgentSessionId);
  const activeAgentId = useUIStore((s) => s.activeAgentId);

  const activity = useAgentActivity(activeAgentSessionId, activeAgentId);
  const isActive = !activity.isComplete && !activity.hasError;

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <View className="flex-row items-center gap-2">
          {isActive ? (
            <PulsingDot color="#3b82f6" />
          ) : activity.isComplete ? (
            <CheckCircle2 size={16} color="#22c55e" />
          ) : activity.hasError ? (
            <AlertCircle size={16} color="#ef4444" />
          ) : null}
          <Text className="text-base font-semibold text-foreground">
            {activity.isComplete
              ? "Task Complete"
              : activity.hasError
              ? "Task Failed"
              : "Agent Working"}
          </Text>
        </View>
        <Pressable
          className="p-1 rounded-lg active:opacity-70"
          onPress={() => setRightPanel(null)}
        >
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* Plan progress bar */}
      {activity.plan && activity.plan.total > 0 && (
        <View className="px-4 py-2 border-b border-border">
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-xs text-muted-foreground">
              {activity.plan.completed}/{activity.plan.total} steps
            </Text>
            <Text className="text-xs text-muted-foreground">
              {Math.round(
                (activity.plan.completed / activity.plan.total) * 100
              )}
              %
            </Text>
          </View>
          <View className="h-1.5 bg-muted rounded-full overflow-hidden">
            <View
              className="h-1.5 bg-primary rounded-full"
              style={{
                width: `${Math.round(
                  (activity.plan.completed / activity.plan.total) * 100
                )}%`,
              }}
            />
          </View>
        </View>
      )}

      {/* Approval request */}
      {activity.approvalRequest && (
        <View className="mx-4 mt-3 mb-1 rounded-xl border border-yellow-500/40 bg-yellow-500/10 p-3">
          <Text className="text-xs font-semibold text-yellow-600 mb-1">
            Approval required
          </Text>
          <Text className="text-xs text-foreground mb-2">
            {activity.approvalRequest.toolName}: {activity.approvalRequest.description}
          </Text>
          <View className="flex-row gap-2">
            <Pressable
              onPress={() => activity.respondApproval(activity.approvalRequest!.requestId, false)}
              className="px-3 py-1.5 rounded-lg border border-border bg-background"
            >
              <Text className="text-xs text-foreground">Deny</Text>
            </Pressable>
            <Pressable
              onPress={() => activity.respondApproval(activity.approvalRequest!.requestId, true)}
              className="px-3 py-1.5 rounded-lg bg-yellow-600"
            >
              <Text className="text-xs text-white">Approve</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Tab Toggle */}
      <View className="px-4 py-3">
        <TabToggle
          value={activeTab}
          onChange={setActiveTab}
          sourceCount={activity.sources.length}
        />
      </View>

      {/* Content */}
      <ScrollView
        className="flex-1 px-4"
        showsVerticalScrollIndicator={false}
      >
        {activeTab === "steps" ? (
          <StepsTab events={activity.events} isActive={isActive} />
        ) : activeTab === "browser" ? (
          <BrowserTab screenshots={activity.screenshots} />
        ) : activeTab === "files" ? (
          <FilesTab files={activity.files} />
        ) : (
          <SourcesTab sources={activity.sources} />
        )}
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Current action footer */}
      {activity.currentAction && isActive && (
        <View className="px-4 py-2 border-t border-border bg-muted/30">
          <View className="flex-row items-center gap-2">
            <Loader size={12} className="text-yellow-500" />
            <Text
              className="text-xs text-muted-foreground flex-1"
              numberOfLines={1}
            >
              <Text className="font-semibold">
                {activity.currentAction.toolName}
              </Text>{" "}
              {activity.currentAction.content.length > 60
                ? activity.currentAction.content.slice(0, 60) + "..."
                : activity.currentAction.content}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}
