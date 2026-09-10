import { useRef, type ReactNode } from "react";
import { View, Pressable, ScrollView, type View as ViewType } from "react-native";
import { ChevronRight, Globe } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/hooks/use-translation";
import { LottieLoader } from "@/components/lottie-loader";
import type { Source, ToolCallStatus } from "@/lib/thought-utils";
import { MONO_FONT, REF } from "./tokens";

/**
 * One execution row: a tool call, its state, and — expanded — what went in
 * and what came out.
 *
 * The markup follows `tool-step.raw.html` (Claude's tool step, the secondary
 * reference): a 20px icon column, the title button with its caret, and under
 * it the same 20px column holding a 1px timeline beside the expanded block —
 * `mx-2.5 mt-1 mb-2 rounded-lg border-[0.5px]`, two labelled code blocks
 * inside a 200px scroll. What the DOM did with selectors is explicit state
 * here:
 *
 *  - `group-has-[button:hover]` tinting the icon column when the row is
 *    hovered becomes the row's own `hover:` classes; the icon keeps its colour.
 *  - `aria-expanded` and the `timeline-expand` height animation become the
 *    `expanded` prop: the block is MOUNTED only while expanded, so nothing
 *    inside a collapsed row can hold focus.
 *  - the `ShimmerText` while a call runs becomes the loader in the icon
 *    column plus the running colour on the title.
 *
 * Status is read from the lifecycle, never from the row being last: a call
 * that never returned in a turn that is over reads as interrupted, and a call
 * whose result carries an error reads as an error, so an execution list never
 * says "done" about work that did not finish.
 */
export interface ToolStepProps {
  title: string;
  /** The call's argument summary, printed muted after the title. */
  description?: string;
  status: ToolCallStatus;
  /** The tool's icon, drawn at 20px in the leading column while the call is not running. */
  icon: ReactNode;
  /** The call's arguments as text; empty hides the block. */
  input: string;
  /** The call's result as text; empty hides the block. */
  output: string;
  /** The web sources a search step returned, drawn as domain chips under the block. */
  sources?: Source[];
  expanded: boolean;
  onToggle: () => void;
  /**
   * Open the full execution panel on this turn. Receives the control that was
   * pressed so the panel can hand focus back to it on close.
   */
  onOpenDetails?: (opener: unknown) => void;
}

/** How many domain chips a search step shows before it counts the rest. */
const CHIP_LIMIT = 3;

/** The reference's `bash` / `Salida` labels: a mono label for the input, a sans one for the output. */
function CodeBlock({ label, value, mono }: { label: string; value: string; mono: boolean }) {
  return (
    <View className={cn("flex-col gap-3 rounded-md p-3", REF.codeSurface)}>
      <View className="h-3 flex-row items-center justify-between">
        <Text
          className={cn("text-[11px] leading-3", REF.textSecondary, mono ? "font-normal" : "font-medium")}
          style={mono ? { fontFamily: MONO_FONT } : undefined}
        >
          {label}
        </Text>
      </View>
      <Text selectable className={cn("text-xs leading-relaxed", REF.textPrimary)} style={{ fontFamily: MONO_FONT }}>
        {value}
      </Text>
    </View>
  );
}

export function ToolStep({
  title,
  description,
  status,
  icon,
  input,
  output,
  sources,
  expanded,
  onToggle,
  onOpenDetails,
}: ToolStepProps) {
  const { t } = useTranslation();
  const detailsRef = useRef<ViewType>(null);
  const hasBlock = input.length > 0 || output.length > 0;
  const chips = sources ? sources.slice(0, CHIP_LIMIT) : [];
  const extra = sources ? Math.max(0, sources.length - CHIP_LIMIT) : 0;

  const titleColor =
    status === "error"
      ? "text-destructive"
      : status === "running"
        ? REF.textPrimary
        : REF.textTertiary;
  const statusWord =
    status === "error" ? t("thought.failed") : status === "interrupted" ? t("thought.cancelled") : null;

  return (
    <View className="rounded-lg">
      <View className="flex-row items-center py-1">
        {/* `w-[20px] flex justify-center shrink-0`: the icon column. */}
        <View className="w-[20px] shrink-0 items-center justify-center">
          {status === "running" ? <LottieLoader width={14} height={14} /> : icon}
        </View>
        <View className="min-w-0 flex-1">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={statusWord === null ? title : `${title}, ${statusWord}`}
            accessibilityState={{ expanded }}
            onPress={onToggle}
            className={cn("w-full flex-row items-center justify-between rounded-lg px-2.5", REF.rowHover)}
          >
            <View className="min-w-0 flex-1 flex-row items-center gap-2">
              <View className="min-w-0 flex-1 flex-row items-center gap-1">
                <Text numberOfLines={1} className={cn("min-w-0 shrink text-sm leading-5", titleColor)}>
                  {title}
                </Text>
                {description ? (
                  <Text numberOfLines={1} className={cn("min-w-0 shrink text-sm leading-5", REF.textTertiary)}>
                    {description}
                  </Text>
                ) : null}
                {/* `transition-transform` caret, 12px: rotated by state instead of by a class the DOM toggled. */}
                <View className="shrink-0 transition-transform" style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
                  <ChevronRight size={12} className={REF.textTertiary} />
                </View>
              </View>
            </View>
            <View className="shrink-0 flex-row items-center gap-1.5">
              {statusWord === null ? null : (
                <Text className={cn("text-xs leading-4", status === "error" ? "text-destructive" : REF.textTertiary)}>
                  {statusWord}
                </Text>
              )}
            </View>
          </Pressable>
        </View>
      </View>

      {expanded ? (
        <View className="flex-row">
          <View className="w-[20px] shrink-0 items-center">
            <View className={cn("h-full w-[1px]", REF.borderFill)} />
          </View>
          <View className="min-w-0 flex-1">
            {hasBlock ? (
              <View className={cn("mx-2.5 mt-1 mb-2 rounded-lg border-[0.5px]", REF.border, REF.surface)}>
                <ScrollView style={{ maxHeight: 200 }} contentContainerStyle={{ padding: 8, gap: 8 }} nestedScrollEnabled>
                  {input.length > 0 ? <CodeBlock label={t("thought.input")} value={input} mono /> : null}
                  {output.length > 0 ? <CodeBlock label={t("thought.output")} value={output} mono={false} /> : null}
                </ScrollView>
              </View>
            ) : null}
            {chips.length > 0 ? (
              <View className="mx-2.5 mb-2 flex-row flex-wrap gap-1.5">
                {chips.map((source) => (
                  <View key={source.url} className={cn("flex-row items-center gap-1 rounded-full px-2.5 py-1", REF.codeSurface)}>
                    <Globe size={10} className={REF.textTertiary} />
                    <Text className={cn("text-[10px] leading-3", REF.textTertiary)} numberOfLines={1}>
                      {source.domain}
                    </Text>
                  </View>
                ))}
                {extra > 0 ? (
                  <View className={cn("rounded-full px-2.5 py-1", REF.codeSurface)}>
                    <Text className={cn("text-[10px] leading-3", REF.textTertiary)}>+ {extra}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {onOpenDetails === undefined ? null : (
              <Pressable
                ref={detailsRef}
                accessibilityRole="button"
                accessibilityLabel={t("thought.viewDetails")}
                onPress={() => onOpenDetails(detailsRef.current)}
                className={cn("mx-2.5 mb-2 self-start rounded-lg px-2 py-1", REF.rowHover)}
              >
                <Text className={cn("text-xs leading-4", REF.textTertiary)}>{t("thought.viewDetails")}</Text>
              </Pressable>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
