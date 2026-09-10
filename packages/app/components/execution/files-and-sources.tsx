import { useState, type ReactNode } from "react";
import { View, Pressable } from "react-native";
import { ChevronRight, FileText, Globe } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/hooks/use-translation";
import type { OutputFile, Source } from "@/lib/thought-utils";
import { REF } from "./tokens";

/**
 * "Files and sources": what a turn produced and what it read, in two
 * collapsible sections.
 *
 * The markup follows `files-and-sources.raw.html` (ChatGPT's popover, the
 * primary reference): each section is `relative px-1 py-2`, the second one
 * carries the `absolute inset-x-5 top-0 border-t` hairline, a header row is
 * `flex items-center justify-between pe-2` whose toggle is `gap-1.5 rounded-sm
 * px-4 py-1 text-sm font-normal` with a 12px caret, and a row is `rounded-xl
 * gap-2 px-2 py-1.5 text-sm` inside an `px-2` item with a 20px icon slot.
 * What the DOM did with selectors is explicit here:
 *
 *  - the caret's `opacity-0 group-hover:opacity-100` reveal has no pointer to
 *    wait for on a phone, so it is always drawn, muted;
 *  - the three-span filename measuring grid is `numberOfLines={1}` plus the
 *    full name as the row's accessible label;
 *  - `height: auto` / `margin-top: 2px` on the list wrapper is the section's
 *    `expanded` state, and a collapsed list is unmounted.
 *
 * The extract's "Create file or site" and "Add source" buttons are not here:
 * nothing in Alia answers them, and a control that does nothing is what #539
 * took out. An output row is a button only when the canvas holds its artifact
 * to open; otherwise it is a labelled row and says so to assistive tech.
 *
 * An empty section stays, with its header and one muted line, so the tab can
 * never look like it failed to load and never hides that a persisted turn
 * produced nothing (#542).
 */
export interface FilesAndSourcesProps {
  outputs: OutputFile[];
  sources: Source[];
  /**
   * Whether the canvas can show an output, and — called from a press — open
   * it. Returns `true` for an output it can open, so the row is a control
   * only then; absent means no output is.
   */
  onOpenOutput?: (output: OutputFile) => boolean;
  onOpenSource: (source: Source) => void;
}

function SectionHeader({ title, expanded, onToggle }: { title: string; expanded: boolean; onToggle: () => void }) {
  return (
    <View className="flex-row items-center justify-between pe-2">
      <View className="min-w-0">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          className="min-w-0 flex-row items-center gap-1.5 rounded-sm px-4 py-1"
        >
          <Text numberOfLines={1} className={cn("text-sm font-normal leading-5", REF.textSecondary)}>
            {title}
          </Text>
          <View className="transition-transform" style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
            <ChevronRight size={12} className={REF.textTertiary} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

/** One row: the 20px icon slot and the name, truncated on screen and whole for assistive tech. */
function Row({
  icon,
  name,
  secondary,
  accessibilityLabel,
  onPress,
}: {
  icon: ReactNode;
  name: string;
  secondary?: string;
  accessibilityLabel: string;
  onPress?: () => void;
}) {
  const content = (
    <>
      <View className="h-5 w-5 shrink-0 items-center justify-center">{icon}</View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className={cn("text-sm leading-5", REF.textPrimary)}>
          {name}
        </Text>
        {secondary ? (
          <Text numberOfLines={1} className={cn("text-xs leading-4", REF.textTertiary)}>
            {secondary}
          </Text>
        ) : null}
      </View>
    </>
  );
  const rowClass = "w-full min-w-0 flex-row items-center gap-2 rounded-xl px-2 py-1.5";
  return (
    <View className="px-2">
      {onPress === undefined ? (
        <View accessible accessibilityLabel={accessibilityLabel} className={rowClass}>
          {content}
        </View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} className={cn(rowClass, REF.rowHover)}>
          {content}
        </Pressable>
      )}
    </View>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <View className="px-4 py-1.5">
      <Text className={cn("text-sm leading-5", REF.textTertiary)}>{text}</Text>
    </View>
  );
}

export function FilesAndSources({ outputs, sources, onOpenOutput, onOpenSource }: FilesAndSourcesProps) {
  const { t } = useTranslation();
  const [outputsOpen, setOutputsOpen] = useState(true);
  const [sourcesOpen, setSourcesOpen] = useState(true);

  return (
    <View className="pt-1">
      <View className="relative px-1 py-2">
        <SectionHeader title={t("thought.outputs")} expanded={outputsOpen} onToggle={() => setOutputsOpen((open) => !open)} />
        {outputsOpen ? (
          <View className="relative overflow-hidden" style={{ marginTop: 2 }}>
            {outputs.length === 0 ? (
              <EmptyLine text={t("thought.noOutputs")} />
            ) : (
              outputs.map((output) => {
                // A row is a control only when the canvas can actually show
                // the file — the caller says so per output, so a persisted
                // turn whose artifact is gone lists the name without a dead
                // button under it.
                const open = onOpenOutput !== undefined && onOpenOutput(output) ? onOpenOutput : undefined;
                return (
                  <Row
                    key={output.id}
                    // The reference draws its document icon in `rgb(2, 133, 255)`, a
                    // colour of its own rather than a theme token; kept as measured.
                    icon={<FileText size={20} color="#0285ff" />}
                    name={output.name}
                    accessibilityLabel={open === undefined ? output.name : t("thought.openOutput", { name: output.name })}
                    onPress={open === undefined ? undefined : () => open(output)}
                  />
                );
              })
            )}
          </View>
        ) : null}
      </View>

      <View className="relative px-1 py-2">
        <View aria-hidden className={cn("absolute inset-x-5 top-0 border-t", REF.border)} />
        <SectionHeader title={t("thought.sources")} expanded={sourcesOpen} onToggle={() => setSourcesOpen((open) => !open)} />
        {sourcesOpen ? (
          <View className="relative overflow-hidden" style={{ marginTop: 2 }}>
            {sources.length === 0 ? (
              <EmptyLine text={t("thought.noSources")} />
            ) : (
              sources.map((source, index) => (
                <Row
                  key={source.url}
                  icon={<Globe size={16} className={REF.textTertiary} />}
                  name={source.title}
                  secondary={source.domain}
                  accessibilityLabel={t("thought.sourceLabel", { n: index + 1, title: source.title })}
                  onPress={() => onOpenSource(source)}
                />
              ))
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}
