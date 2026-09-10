import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Pressable, ScrollView, Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Text } from "@/components/ui/text";
import { Brain, CheckCircle2, X, Globe, XCircle, Ban, Clock } from "lucide-react-native";
import { useUIStore, type ThoughtTab } from "@/lib/stores/ui-store";
import { useTheme, type ThemeColors } from "@oxy.so/bloom/theme";
import { useTranslation } from "@/lib/hooks/use-translation";
import { cn } from "@/lib/utils";
import {
  extractSources,
  extractOutputs,
  buildSteps,
  buildAuditTimeline,
  mergeSources,
  researchSourcesToSources,
  turnLifecycle,
  isLiveLifecycle,
  toolCallStatus,
  toolCallText,
  type Source,
  type OutputFile,
  type ThoughtStep,
  type AuditEntry,
  type TurnLifecycle,
} from "@/lib/thought-utils";
import { getToolIcon } from "@/lib/tool-registry";
import { LottieLoader } from "@/components/lottie-loader";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  withSequence,
} from "react-native-reanimated";
import type { Message } from "@/lib/hooks/use-conversations";
import { ToolStep } from "@/components/execution/tool-step";
import { FilesAndSources } from "@/components/execution/files-and-sources";
import { restoreOpenerFocus } from "@/components/execution/focus-return";
import { REF } from "@/components/execution/tokens";

/** One array for "nothing selected", so the memos below hold across renders. */
const NO_MESSAGES: Message[] = [];


function TabToggle({ value, onChange }: { value: ThoughtTab; onChange: (t: ThoughtTab) => void }) {
  const { t } = useTranslation();
  const tabs: { key: ThoughtTab; label: string }[] = [
    { key: "steps", label: t("thought.steps") },
    { key: "sources", label: t("thought.sources") },
    { key: "activity", label: t("thought.activity") },
  ];

  return (
    <View className="flex-row bg-muted rounded-lg overflow-hidden" accessibilityRole="tablist">
      {tabs.map((tab) => (
        <Pressable
          key={tab.key}
          accessibilityRole="tab"
          accessibilityLabel={tab.label}
          accessibilityState={{ selected: value === tab.key }}
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

/**
 * The panel's own wording for every step that is not a tool. Tool steps keep
 * the label the registry gave them; these are lifecycle words, and they are
 * translated here rather than in `buildSteps` so the pure function stays free
 * of the locale.
 */
const STEP_LABEL_KEYS: Record<Exclude<ThoughtStep["type"], "tool">, string> = {
  thinking: "thought.thinking",
  writing: "thought.writing",
  waiting: "thought.waitingApproval",
  done: "thought.done",
  failed: "thought.failed",
  cancelled: "thought.cancelled",
};

/** A step that is a phase or an ending rather than a tool call. */
type PhaseStep = Omit<ThoughtStep, "type"> & { type: Exclude<ThoughtStep["type"], "tool"> };

/** The icon of a phase step. */
function PhaseIcon({ step, isActive }: { step: PhaseStep; isActive: boolean }) {
  const { colors } = useTheme();
  if (step.type === "thinking") {
    if (isActive) return <PulsingDot color="#a855f7" />;
    return <Brain size={14} color="#a855f7" />;
  }
  if (step.type === "writing") {
    return <PulsingDot color={colors.primary} />;
  }
  if (step.type === "waiting") {
    return <Clock size={14} color={colors.warning} />;
  }
  if (step.type === "done") {
    return <CheckCircle2 size={14} color={colors.success} />;
  }
  if (step.type === "failed") {
    return <XCircle size={14} color={colors.error} />;
  }
  return <Ban size={14} className="text-muted-foreground" />;
}

/**
 * A phase or ending, in the same 20px-column row as a tool step so the list
 * reads as one timeline. Not a control: there is nothing to expand.
 */
function PhaseRow({ step, isActive }: { step: PhaseStep; isActive: boolean }) {
  const { t } = useTranslation();
  const label = t(STEP_LABEL_KEYS[step.type]);
  return (
    <View className="flex-row items-center py-1" accessible accessibilityLabel={label}>
      <View className="w-[20px] shrink-0 items-center justify-center">
        <PhaseIcon step={step} isActive={isActive} />
      </View>
      <View className="min-w-0 flex-1 px-2.5">
        <Text
          className={cn(
            "text-sm leading-5",
            step.type === "done"
              ? "text-green-500 font-medium"
              : step.type === "failed"
                ? "text-red-500 font-medium"
                : isActive
                  ? "text-foreground font-medium"
                  : REF.textTertiary,
          )}
        >
          {label}
        </Text>
      </View>
    </View>
  );
}

/**
 * The turn's steps as execution rows: each tool call in a `ToolStep` whose
 * input and output open in place, the phases and the ending as plain rows.
 *
 * A tool step spins on ITS OWN state while the turn runs — not on being last
 * — so a finished tool after it cannot hide that it is still going, and a
 * call that never returned in a turn that is over sits still and says so.
 */
function StepsTab({ steps, lifecycle }: { steps: ThoughtStep[]; lifecycle: TurnLifecycle }) {
  const { t } = useTranslation();
  const live = isLiveLifecycle(lifecycle);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});

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
        const isActive = live && isLast;
        if (step.type !== "tool") {
          return <PhaseRow key={`${step.type}-${index}`} step={{ ...step, type: step.type }} isActive={isActive} />;
        }
        const inv = step.invocation;
        const key = inv?.toolCallId || `tool-${index}`;
        const ToolIcon = getToolIcon(step.toolName || "");
        const status = inv === undefined ? (live ? "running" : "done") : toolCallStatus(inv, live);
        return (
          <ToolStep
            key={key}
            title={step.label}
            status={status}
            icon={<ToolIcon size={14} className={status === "error" ? "text-destructive" : "text-foreground"} />}
            input={inv === undefined ? "" : toolCallText(inv.args)}
            output={inv === undefined ? "" : toolCallText(inv.result)}
            sources={step.sources}
            expanded={openRows[key] === true}
            onToggle={() => setOpenRows((rows) => ({ ...rows, [key]: rows[key] !== true }))}
          />
        );
      })}
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
  const { t } = useTranslation();
  if (entries.length === 0) {
    return (
      <View className="items-center justify-center py-8">
        <Text className="text-sm text-muted-foreground">{t("thought.noActivity")}</Text>
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
                ) : entry.status === 'interrupted' ? (
                  <Ban size={12} className="text-muted-foreground" />
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

/**
 * The panel has nothing to show for the selection, and the reason. Rendered
 * in place of the tabs' content so the three tabs never each say "none" about
 * a message whose data has simply not arrived.
 */
function EmptyState({ status }: { status: 'loading' | 'failed' | 'gone' }) {
  const { t } = useTranslation();
  const key = status === 'loading' ? 'thought.loading' : status === 'failed' ? 'thought.loadFailed' : 'thought.messageGone';
  return (
    <View className="items-center justify-center py-8">
      {status === 'loading' ? <LottieLoader width={24} height={24} /> : null}
      <Text className="text-sm text-muted-foreground">{t(key)}</Text>
    </View>
  );
}

/** Open a source where the platform reads the web. */
function openSource(source: Source): void {
  if (Platform.OS === 'web') {
    window.open(source.url, '_blank', 'noopener,noreferrer');
  } else {
    void WebBrowser.openBrowserAsync(source.url);
  }
}

/**
 * The execution panel: what the selected turn did, produced and read.
 *
 * It renders inside `ExecutionSurface`, which draws the aside's chrome — the
 * `rounded-3xl border` of the reference — and decides between the desktop
 * rail and the in-viewport popover; this component is the aside's content
 * and sizes to it. Closing hands focus back to whatever opened it.
 *
 * Everything shown comes from the selection's own scope and the lifecycle the
 * runtime stamps (#542, #543): a message not yet loaded is "loading", a load
 * that failed says so, a message cut out since is "gone", and none of them is
 * ever "no steps".
 */
export function ThoughtPanel() {
  const { t } = useTranslation();
  const activeTab = useUIStore((s) => s.thoughtTab);
  const setActiveTab = useUIStore((s) => s.setThoughtTab);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const thoughtMessageId = useUIStore((s) => s.thoughtMessageId);
  const scope = useUIStore((s) => s.thoughtScope);
  const canvasArtifacts = useUIStore((s) => s.canvasArtifacts);

  /**
   * The scope's messages are the conversation the selection was made in and
   * nothing else — a screen showing another conversation never gets to write
   * here (see `syncThoughtScope`), so a miss below is about THIS conversation:
   * still loading, failed to load, or a message that has since been cut out
   * of it by an edit or a regenerate.
   */
  const messages = scope?.messages ?? NO_MESSAGES;
  const message = useMemo(
    () => messages.find((m) => m.id === thoughtMessageId),
    [messages, thoughtMessageId]
  );

  const lifecycle = useMemo<TurnLifecycle>(() => {
    if (!message) return 'completed';
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return turnLifecycle(message, {
      isLoading: scope?.isLoading ?? false,
      isLastAssistant: lastAssistant?.id === message.id,
      failedTurn: scope?.failedTurn ?? null,
    });
  }, [message, messages, scope?.isLoading, scope?.failedTurn]);

  const steps = useMemo(
    () => (message ? buildSteps(message, lifecycle) : []),
    [message, lifecycle]
  );

  // A research answer's sources come from its persisted `deepResearch`
  // invocation after a reload and from the live progress event before one;
  // both are read so the tab is the same either way.
  const sources = useMemo(
    () =>
      message
        ? mergeSources(extractSources(message.toolInvocations), researchSourcesToSources(message.researchProgress?.sources))
        : [],
    [message]
  );

  const outputs = useMemo(() => (message ? extractOutputs(message.toolInvocations) : []), [message]);

  /**
   * An output opens in the canvas only while the canvas holds its artifact —
   * the streaming hook adds one per generated file under the invocation's
   * id, and nothing persists it. A reloaded thread lists the file by name and
   * offers no press, rather than a press that opens an empty canvas.
   */
  const openOutput = useCallback(
    (output: OutputFile): boolean => {
      if (!canvasArtifacts.some((artifact) => artifact.id === output.id)) return false;
      setRightPanel('canvas');
      return true;
    },
    [canvasArtifacts, setRightPanel],
  );

  const auditEntries = useMemo(
    () => buildAuditTimeline(messages, { isLoading: scope?.isLoading ?? false, failedTurn: scope?.failedTurn ?? null }),
    [messages, scope?.isLoading, scope?.failedTurn]
  );

  const close = useCallback(() => {
    setRightPanel(null);
    restoreOpenerFocus();
  }, [setRightPanel]);

  /**
   * Which of the three things a missing message means. A message that IS
   * here but whose conversation is still loading is shown as it is — the
   * live turn is exactly that — so only a miss consults the status.
   */
  const emptyState: 'loading' | 'failed' | 'gone' | null =
    message !== undefined ? null
      : scope === null || scope.status === 'loading' ? 'loading'
      : scope.status === 'failed' ? 'failed'
      : 'gone';

  const content =
    emptyState !== null ? (
      <EmptyState status={emptyState} />
    ) : activeTab === "steps" ? (
      <StepsTab steps={steps} lifecycle={lifecycle} />
    ) : activeTab === "sources" ? (
      <FilesAndSources outputs={outputs} sources={sources} onOpenOutput={openOutput} onOpenSource={openSource} />
    ) : (
      <ActivityTab entries={auditEntries} />
    );

  return (
    <View className={cn("w-full flex-shrink", REF.surface)} style={{ maxHeight: '100%' }}>
      {/* Header */}
      <View className={cn("flex-row items-center justify-between border-b px-4 py-3", REF.border)}>
        <Text className="text-base font-semibold text-foreground" accessibilityRole="header">
          {t("thought.title")}
        </Text>
        <Pressable
          className="p-1 rounded-lg active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={close}
        >
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      {/* Tab Toggle */}
      <View className="px-4 py-3">
        <TabToggle value={activeTab} onChange={setActiveTab} />
      </View>

      {/* Content: `overflow-x-hidden overflow-y-auto` — sized to what it holds, up to the aside's height. */}
      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1 }}
        className={activeTab === "sources" && emptyState === null ? "" : "px-4"}
        showsVerticalScrollIndicator={false}
      >
        {content}
        <View style={{ height: 16 }} />
      </ScrollView>
    </View>
  );
}
