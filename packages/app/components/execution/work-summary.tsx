import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View, Pressable } from "react-native";
import { ChevronRight } from "lucide-react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/hooks/use-translation";
import { getToolIcon } from "@/lib/tool-registry";
import {
  buildSteps,
  formatElapsed,
  isLiveLifecycle,
  recordTurnEnd,
  recordedTurnEnd,
  toolCallStatus,
  toolCallText,
  type ThoughtStep,
  type TurnLifecycle,
} from "@/lib/thought-utils";
import type { ToolInvocation } from "@/lib/types/messages";
import { ToolStep } from "./tool-step";
import { REF } from "./tokens";

/**
 * The elapsed time of a turn, ticking once a second while it is live.
 *
 * `startedAt` is the send; the end is whichever the conversation knows: the
 * persisted stamp, the moment THIS row saw the turn settle, or the moment a
 * row that came before it did (`recordTurnEnd`). A turn whose start is
 * unknown has no elapsed time, and the label says "worked" without one
 * rather than inventing a number.
 */
function useElapsed(messageId: string, startedAt: number | null, endedAt: number | null, live: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  const [observedEnd, setObservedEnd] = useState<number | null>(() => recordedTurnEnd(messageId));
  const wasLive = useRef(live);

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // The transition from live to settled, seen here, is the end of the turn
  // for a message the server has not stamped yet.
  useEffect(() => {
    if (wasLive.current && !live && endedAt === null) {
      const at = Date.now();
      recordTurnEnd(messageId, at);
      setObservedEnd(at);
    }
    wasLive.current = live;
  }, [live, endedAt, messageId]);

  if (startedAt === null) return null;
  if (live) return Math.max(0, now - startedAt);
  const end = endedAt ?? observedEnd ?? recordedTurnEnd(messageId);
  return end === null ? null : Math.max(0, end - startedAt);
}

/** The reference's `ShimmerText`: the label breathes while the turn runs. */
function Shimmer({ active, children }: { active: boolean; children: ReactNode }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = active
      ? withRepeat(withSequence(withTiming(0.4, { duration: 700 }), withTiming(1, { duration: 700 })), -1, false)
      : withTiming(1, { duration: 150 });
  }, [active, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** A tool call's argument in one line — the query or the URL, as the old bullet rows showed it. */
function describeCall(inv: ToolInvocation): string | undefined {
  if (inv.args?.url) {
    const url = String(inv.args.url);
    return url.length > 40 ? `${url.slice(0, 40)}…` : url;
  }
  if (inv.args?.query) {
    const q = String(inv.args.query);
    return `"${q.length > 30 ? `${q.slice(0, 30)}…` : q}"`;
  }
  return undefined;
}

export interface WorkSummaryProps {
  messageId: string;
  /** The calls the turn made, minus any that drew their own card in the conversation. */
  invocations: ToolInvocation[];
  lifecycle: TurnLifecycle;
  /** Epoch ms of the send, or `null` when the conversation does not say. */
  startedAt: number | null;
  /** Epoch ms of the persisted end, or `null` for a turn the server has not stamped. */
  endedAt: number | null;
  /** Open the execution panel on this turn; receives the pressed control for focus return. */
  onOpenDetails?: (opener: unknown) => void;
}

/**
 * The compact row under an answer that used tools: "Worked for 10s", which
 * opens into the execution rows.
 *
 * The markup follows `work-summary.raw.html` (ChatGPT's work summary, the
 * primary reference): a `border-b pb-2` band in tertiary `text-base leading-5
 * tabular-nums select-none`, holding one button with a 20px caret that turns
 * `rotate-90` when open. The status hierarchy is the lifecycle's, never a
 * guess from the message's content (#543): a running turn reads "Working",
 * a settled one "Worked", a failed one "Failed after", a stopped one
 * "Stopped after" — with the elapsed time wherever it is known.
 *
 * It mounts expanded for a live turn, so a reader watching the answer sees the
 * calls as they happen, and collapsed for a persisted one; after that it only
 * moves when pressed. Nothing here masks a turn with no tools: the caller
 * renders it only when there is work to summarise.
 */
export function WorkSummary({ messageId, invocations, lifecycle, startedAt, endedAt, onOpenDetails }: WorkSummaryProps) {
  const { t } = useTranslation();
  const live = isLiveLifecycle(lifecycle);
  const [expanded, setExpanded] = useState(live);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const elapsed = useElapsed(messageId, startedAt, endedAt, live);

  const steps = useMemo<ThoughtStep[]>(
    () => buildSteps({ toolInvocations: invocations }, lifecycle).filter((step) => step.type === "tool"),
    [invocations, lifecycle],
  );

  const short = elapsed === null ? null : formatElapsed(elapsed);
  const long = elapsed === null ? null : formatElapsed(elapsed, true);
  const [label, accessibilityLabel] =
    lifecycle === "failed"
      ? short === null
        ? [t("thought.failed"), t("thought.failed")]
        : [t("thought.failedAfter", { elapsed: short }), t("thought.failedAfter", { elapsed: long })]
      : lifecycle === "cancelled"
        ? short === null
          ? [t("thought.cancelled"), t("thought.cancelled")]
          : [t("thought.stoppedAfter", { elapsed: short }), t("thought.stoppedAfter", { elapsed: long })]
        : live
          ? short === null
            ? [t("thought.working"), t("thought.working")]
            : [t("thought.workingFor", { elapsed: short }), t("thought.workingFor", { elapsed: long })]
          : short === null
            ? [t("thought.worked"), t("thought.worked")]
            : [t("thought.workedFor", { elapsed: short }), t("thought.workedFor", { elapsed: long })];

  const labelColor = lifecycle === "failed" ? "text-destructive" : cn(REF.textTertiary, REF.hoverTextPrimary);

  return (
    <View className={cn("border-b pb-2", REF.border)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded, busy: live }}
        onPress={() => setExpanded((open) => !open)}
        className="flex-row items-center gap-1 self-start"
      >
        <Shimmer active={live}>
          <Text className={cn("text-base leading-5 tabular-nums select-none", labelColor)}>{label}</Text>
        </Shimmer>
        <View className="transition-transform" style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
          <ChevronRight size={20} className={REF.textTertiary} />
        </View>
      </Pressable>

      {expanded ? (
        <View className="pt-1">
          {steps.map((step, index) => {
            const inv = step.invocation;
            if (inv === undefined) return null;
            const key = inv.toolCallId || `${messageId}-${index}`;
            const Icon = getToolIcon(inv.toolName);
            const status = toolCallStatus(inv, live);
            return (
              <ToolStep
                key={key}
                title={step.label}
                description={describeCall(inv)}
                status={status}
                icon={<Icon size={14} className={status === "error" ? "text-destructive" : REF.textTertiary} />}
                input={toolCallText(inv.args)}
                output={toolCallText(inv.result)}
                sources={step.sources}
                expanded={openRows[key] === true}
                onToggle={() => setOpenRows((rows) => ({ ...rows, [key]: rows[key] !== true }))}
                onOpenDetails={onOpenDetails}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
