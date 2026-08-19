import { ChevronDown } from "lucide-react-native";
import { Pressable, View } from "react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  resolveSelection,
  useCatalogue,
  type CatalogueEntry,
  type EffortLevel,
} from "@/lib/hooks/use-catalogue";
import { effortFor, useModelStore } from "@/lib/stores/model-store";

/**
 * How hard Alia should think — the second of the composer's three axes.
 *
 * ## Why it is its OWN control and not another row in the model menu
 *
 * The model menu answers "who replies". This answers "how hard they work on
 * it". Folding the second into the first is exactly the mistake that produced
 * `alia-v1-thinking`: an alias that shared a routing profile with
 * `alia-v1-pro-max` and differed only in its prompt, so a reasoning SETTING
 * wore a model's NAME and picking it looked like picking a better model. ADR
 * 0002 names that; keeping the axes apart is what stops it recurring.
 *
 * ## It is hidden unless every route can honour the level
 *
 * `capabilities.reasoningLevels` is an INTERSECTION computed server-side over
 * an entry's candidate routes, so a level listed there is one the request will
 * actually have carried whichever candidate answered. Two consequences, both
 * deliberate and both visible:
 *
 *  - a routing profile shows no control at all. Every profile fans out over ten
 *    to seventeen deployments and no level survives all of them, so a dial there
 *    would be a promise the fallback breaks silently.
 *  - a model that reasons shows only the levels IT has. Gemini 2.5 Pro cannot be
 *    told to stop thinking, so it offers three and not four.
 *
 * Fewer than two levels renders nothing: one option is not a choice, and a
 * disabled control that explains itself is still a control competing for
 * attention in a composer that already has three.
 */

/**
 * What each level is called, and what it says about cost.
 *
 * The descriptions name the trade rather than a number: the budget is per model
 * — Anthropic gets a token budget, Gemini 3 gets a level — so a single figure
 * here would be right for one provider and wrong for the rest. What is true
 * everywhere, and is what a person needs before choosing, is that the dearer
 * levels bill more because thinking tokens are output tokens.
 */
const LEVEL_COPY: Record<EffortLevel, { label: string; description: string }> = {
  instant: { label: "Instant", description: "Answer straight away. No thinking budget." },
  medium: { label: "Medium", description: "A little thought before answering." },
  high: { label: "High", description: "Works the problem through. Costs more." },
  max: { label: "Max", description: "The most thinking available. Slowest and dearest." },
};

/**
 * What the trigger says when nothing has been chosen.
 *
 * `null` is not "instant": it is the model's OWN default, and the request omits
 * the parameter entirely. Labelling it "Instant" would claim the request turns
 * thinking off, which it does not.
 */
const DEFAULT_LABEL = "Effort";

interface EffortSelectorProps {
  /** The identifier the composer is about to send, so the levels match the model. */
  selectedModel: string;
}

export function EffortSelector({ selectedModel }: EffortSelectorProps) {
  const { t } = useTranslation();
  const { data: entries } = useCatalogue();
  const reasoningEffort = useModelStore((s) => s.reasoningEffort);
  const setReasoningEffort = useModelStore((s) => s.setReasoningEffort);

  const selection = resolveSelection(selectedModel, entries);
  const levels = levelsFor(selection.entry);

  // One level is not a choice, and none is not a control. Both render nothing
  // rather than a disabled affordance — this is the "hide it" ChatGPT does.
  if (levels.length < 2) return null;

  // The stored preference, answered against what this entry can honour. The
  // same function the request uses, so the control cannot show `high` while the
  // body carries nothing.
  const active = effortFor(reasoningEffort, levels);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Pressable
          accessibilityLabel={t('effort.select')}
          accessibilityRole="button"
          className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted active:opacity-70"
        >
          <Text className="text-sm font-medium text-foreground">
            {active === null ? DEFAULT_LABEL : LEVEL_COPY[active].label}
          </Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" className="w-72">
        <DropdownMenu.Label className="text-xs text-muted-foreground font-normal px-2.5">
          {t('effort.select')}
        </DropdownMenu.Label>
        {levels.map((level) => (
          <DropdownMenu.CheckboxItem
            key={level}
            value={active === level ? 'on' : 'off'}
            onValueChange={() => setReasoningEffort(active === level ? null : level)}
          >
            <DropdownMenu.ItemTitle>{LEVEL_COPY[level].label}</DropdownMenu.ItemTitle>
            <DropdownMenu.ItemSubtitle>{LEVEL_COPY[level].description}</DropdownMenu.ItemSubtitle>
          </DropdownMenu.CheckboxItem>
        ))}
        <DropdownMenu.Separator />
        <View className="px-2.5 py-1.5">
          <Text className="text-[11px] text-muted-foreground">
            {t('effort.costNote')}
          </Text>
        </View>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/**
 * The levels an entry offers, or none when the catalogue cannot say.
 *
 * A null entry is the catalogue not having loaded — or a stored identifier the
 * product no longer offers — and neither is a reason to guess a level set. The
 * control simply does not appear, which is the same thing it does for every
 * entry that cannot reason.
 */
function levelsFor(entry: CatalogueEntry | null): readonly EffortLevel[] {
  return entry?.capabilities.reasoningLevels ?? [];
}
