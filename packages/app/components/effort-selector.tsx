import { ChevronDown } from "lucide-react-native";
import { Pressable } from "react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  EFFORT_LEVELS,
  resolveSelection,
  useCatalogue,
  type EffortLevel,
} from "@/lib/hooks/use-catalogue";
import { effortFor, useModelStore } from "@/lib/stores/model-store";

const EFFORT_LABEL: Record<EffortLevel, string> = {
  instant: "Instant",
  medium: "Medium",
  high: "High",
  max: "Extra High",
};

export function EffortSelector({ selectedModel }: { selectedModel: string }) {
  const { t } = useTranslation();
  const { data: entries } = useCatalogue();
  const storedEffort = useModelStore((state) => state.reasoningEffort);
  const setReasoningEffort = useModelStore((state) => state.setReasoningEffort);
  const supported = resolveSelection(selectedModel, entries).entry?.capabilities.reasoningLevels ?? [];
  const active = effortFor(storedEffort, supported);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Pressable
          accessibilityLabel={t("effort.select")}
          accessibilityRole="button"
          className="h-9 flex-row items-center gap-1.5 rounded-full px-2.5 active:opacity-70"
        >
          <Text className="text-sm font-medium text-foreground">
            {active === null ? "Effort" : EFFORT_LABEL[active]}
          </Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="top" align="end" className="w-44 rounded-2xl py-1.5">
        {EFFORT_LEVELS.map((level) => (
          <DropdownMenu.CheckboxItem
            key={level}
            value={active === level ? "on" : "off"}
            disabled={!supported.includes(level)}
            onValueChange={() => setReasoningEffort(level)}
            className="rounded-xl px-2 py-2"
          >
            <DropdownMenu.ItemTitle>{EFFORT_LABEL[level]}</DropdownMenu.ItemTitle>
          </DropdownMenu.CheckboxItem>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
