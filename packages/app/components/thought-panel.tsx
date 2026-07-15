import { useState, useMemo } from "react";
import { View, Pressable, ScrollView, Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Text } from "@/components/ui/text";
import { Brain, CheckCircle2, X, Globe, ChevronRight } from "lucide-react-native";
import { useUIStore } from "@/lib/stores/ui-store";
import { useTheme, type ThemeColors } from "@oxyhq/bloom/theme";
import { useTranslation } from "@/lib/hooks/use-translation";
import { extractSources, buildSteps, buildAuditTimeline, type Source, type ThoughtStep, type AuditEntry } from "@/lib/thought-utils";
import { getToolIcon } from "@/lib/tool-registry";
import { LottieLoader } from "@/components/lottie-loader";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
} from "react-native-reanimated";
import { useEffect } from "react";

type Tab = "steps" | "sources" | "activity";

function TabToggle({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  const { t } = useTranslation();
  const tabs: { key: Tab; label: string }[] = [
    { key: "steps", label: t("thought.steps") },
    { key: "sources", label: t("thought.sources") },
    { key: "activity", label: "Activity" },
  ];

  return (
    <View className="flex-row bg-muted rounded-lg overflow-hidden">
      {tabs.map((tab) => (
        <Pressable
          key={tab.key}
          onPress={() => onChange(tab.key)}
          className={`flex-1 items-center px-3 py-1.5 ${value === tab.key ? "bg-background" : ""}`}
        >
          <Text
            className={`text-xs font-medium ${value === tab.key ? "text-foreground" : "text-muted-foreground"}`}
          >
            {tab.label}
          </Text>
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
      style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }, style]}
    />
  );
}

function StepIcon({ step, isActive }: { step: ThoughtStep; isActive: boolean }) {
  const { colors } = useTheme();
  if (step.type === "thinking") {
    if (isActive) return <PulsingDot color="#a855f7" />;
    return <Brain size={14} color="#a855f7" />;
  }
  if (step.type === "done") {
    return <CheckCircle2 size={14} color={colors.success} />;
  }
  // tool step
  const ToolIcon = getToolIcon(step.toolName || "");
  if (isActive && step.state !== "result") {
    return <LottieLoader width={14} height={14} />;
  }
  return <ToolIcon size={14} className="text-foreground" />;
}

function StepsTab({ steps, isStreaming }: { steps: ThoughtStep[]; isStreaming: boolean }) {
  const { t } = useTranslation();

  if (steps.length === 0) {
    return (
      <View className="items-center justify-center py-8">
        <Text className="text-sm text-muted-foreground">{t("thought.noSteps")}</Text>
      </View>
    );
  }

  return (
    <View className="gap-0">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        const isActive = isStreaming && isLast;
        const showSources = step.sources && step.sources.length > 0;
        const displayedSources = showSources ? step.sources!.slice(0, 3) : [];
        const extraCount = showSources ? Math.max(0, step.sources!.length - 3) : 0;

        return (
          <View key={index} className="flex-row">
            {/* Timeline column */}
            <View className="items-center" style={{ width: 24 }}>
              <View className="h-3" />
              <View className="items-center justify-center" style={{ width: 20, height: 20 }}>
                <StepIcon step={step} isActive={isActive} />
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
                  step.type === "done"
                    ? "text-green-500 font-medium"
                    : isActive
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
                }`}
              >
                {step.label}
              </Text>

              {/* Source badges for search steps */}
              {showSources && (
                <View className="flex-row flex-wrap gap-1.5 mt-1.5">
                  {displayedSources.map((s, si) => (
                    <View
                      key={si}
                      className="rounded-full bg-muted px-2.5 py-1 flex-row items-center gap-1"
                    >
                      <Globe size={10} className="text-muted-foreground" />
                      <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
                        {s.domain}
                      </Text>
                    </View>
                  ))}
                  {extraCount > 0 && (
                    <View className="rounded-full bg-muted px-2.5 py-1">
                      <Text className="text-[10px] text-muted-foreground">
                        + {extraCount} more
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function SourcesTab({ sources }: { sources: Source[] }) {
  const { t } = useTranslation();

  if (sources.length === 0) {
    return (
      <View className="items-center justify-center py-8">
        <Text className="text-sm text-muted-foreground">{t("thought.noSources")}</Text>
      </View>
    );
  }

  return (
    <View className="gap-2">
      <Text className="text-xs font-medium text-muted-foreground">
        {t("thought.websites")}
      </Text>
      {sources.map((source, index) => (
        <Pressable
          key={index}
          onPress={() => {
            if (Platform.OS === 'web') {
              window.open(source.url, '_blank', 'noopener,noreferrer');
            } else {
              WebBrowser.openBrowserAsync(source.url);
            }
          }}
          className="rounded-xl border border-border p-3 bg-background active:bg-muted"
        >
          <View className="flex-row items-center gap-2 mb-1">
            <Globe size={12} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {source.domain}
            </Text>
            <View className="flex-1" />
            <ChevronRight size={12} className="text-muted-foreground" />
          </View>
          <Text className="text-sm font-medium text-foreground" numberOfLines={2}>
            {source.title}
          </Text>
          {source.snippet.length > 0 && (
            <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={2}>
              {source.snippet}
            </Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}

function AuditIcon({ entry, colors }: { entry: AuditEntry; colors: ThemeColors }) {
  if (entry.type === 'tool_call' && entry.toolName) {
    const Icon = getToolIcon(entry.toolName);
    return <Icon size={12} className="text-foreground" />;
  }
  if (entry.type === 'research_phase') return <Brain size={12} color="#8b5cf6" />;
  if (entry.type === 'agent_delegation') return <Brain size={12} color="#f97316" />;
  if (entry.type === 'plan_approved') return <CheckCircle2 size={12} color={colors.success} />;
  if (entry.type === 'artifact_generated') return <CheckCircle2 size={12} color={colors.info} />;
  return <Globe size={12} className="text-muted-foreground" />;
}

function ActivityTab({ entries }: { entries: AuditEntry[] }) {
  const { colors } = useTheme();
  if (entries.length === 0) {
    return (
      <View className="items-center justify-center py-8">
        <Text className="text-sm text-muted-foreground">No actions recorded yet</Text>
      </View>
    );
  }

  return (
    <View className="gap-0">
      {entries.map((entry, index) => {
        const isLast = index === entries.length - 1;
        return (
          <View key={entry.id} className="flex-row">
            {/* Timeline column */}
            <View className="items-center" style={{ width: 24 }}>
              <View className="h-3" />
              <View className="items-center justify-center" style={{ width: 20, height: 20 }}>
                {entry.status === 'in_progress' ? (
                  <PulsingDot color={colors.warning} />
                ) : (
                  <AuditIcon entry={entry} colors={colors} />
                )}
              </View>
              {!isLast && (
                <View
                  className="flex-1 border-l border-border"
                  style={{ minHeight: 16 }}
                />
              )}
            </View>

            {/* Content */}
            <View className="flex-1 pl-2 pb-3" style={{ paddingTop: 12 }}>
              <Text
                className={`text-sm ${
                  entry.status === 'in_progress'
                    ? "text-foreground font-medium"
                    : "text-muted-foreground"
                }`}
                numberOfLines={1}
              >
                {entry.label}
              </Text>
              {entry.description ? (
                <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={1}>
                  {entry.description}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function ThoughtPanel() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("steps");
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const thoughtMessageId = useUIStore((s) => s.thoughtMessageId);
  const thoughtMessages = useUIStore((s) => s.thoughtMessages);

  const message = useMemo(
    () => thoughtMessages.find((m) => m.id === thoughtMessageId),
    [thoughtMessages, thoughtMessageId]
  );

  const isStreaming = useMemo(() => {
    if (!message || !thoughtMessages.length) return false;
    const lastMsg = thoughtMessages[thoughtMessages.length - 1];
    return lastMsg?.id === message.id && lastMsg?.role === "assistant" && !message.content;
  }, [message, thoughtMessages]);

  const steps = useMemo(
    () => (message ? buildSteps(message, isStreaming) : []),
    [message, isStreaming]
  );

  const sources = useMemo(
    () => (message ? extractSources(message.toolInvocations) : []),
    [message]
  );

  const auditEntries = useMemo(
    () => buildAuditTimeline(thoughtMessages),
    [thoughtMessages]
  );

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Text className="text-base font-semibold text-foreground">
          {t("thought.title")}
        </Text>
        <Pressable
          className="p-1 rounded-lg active:opacity-70"
          onPress={() => setRightPanel(null)}
        >
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* Tab Toggle */}
      <View className="px-4 py-3">
        <TabToggle value={activeTab} onChange={setActiveTab} />
      </View>

      {/* Content */}
      <ScrollView className="flex-1 px-4" showsVerticalScrollIndicator={false}>
        {activeTab === "steps" ? (
          <StepsTab steps={steps} isStreaming={isStreaming} />
        ) : activeTab === "sources" ? (
          <SourcesTab sources={sources} />
        ) : (
          <ActivityTab entries={auditEntries} />
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}
