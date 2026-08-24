import { ChevronDown } from "lucide-react-native";
import { Pressable } from "react-native";
import { useRouter } from "expo-router";
import { toast } from "@oxyhq/bloom/toast";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  AUTOMATIC_SELECTION_ID,
  resolveSelection,
  useCatalogue,
  type CatalogueEntry,
} from "@/lib/hooks/use-catalogue";
import { presentation, useProductModes } from "@/lib/hooks/use-product-modes";
import { useLocalModelOptions } from "@/lib/hooks/use-local-runtimes";
import { LocalModelsInvite } from "@/components/local-models-invite";

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
}

/**
 * Compact model picker for the composer. Model identity stays catalogue-driven
 * and remains separate from the neighbouring effort control.
 */
export function ModelSelector({ selectedModel, onModelChange }: ModelSelectorProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: entries, isPending } = useCatalogue();
  const { data: modes } = useProductModes();

  const { options: localModels, ids: localModelIds } = useLocalModelOptions();
  const selection = resolveSelection(selectedModel, entries, localModelIds);
  const selectedLocal = localModels.find((model) => model.id === selection.effectiveId);
  const isAutomatic = selection.requestedId === AUTOMATIC_SELECTION_ID;

  const automaticMode = (modes ?? []).find(
    (mode) => mode.routing.kind === "default" && !mode.deepResearch,
  );
  const automaticLabel = automaticMode?.label ?? t("models.automatic.label");
  const modelLabel = isAutomatic
    ? automaticLabel
    // A local model has no catalogue entry to take a display name from, so the
    // tag the person knows it by is the label.
    : selectedLocal !== undefined
      ? selectedLocal.name
      : selection.entry === null
        ? t("models.selectModel")
        : presentation(selection.entry, modes).label;

  const offered = (entries ?? []).filter((entry) => entry.chatVisible && !entry.unavailable);
  const profiles = offered.filter((entry) => entry.kind === "routing_profile" && !entry.legacy);
  const models = offered.filter((entry) => entry.kind === "model" && !entry.legacy);
  const legacy = offered.filter((entry) => entry.legacy);

  const selectEntry = (entry: CatalogueEntry) => {
    if (entry.entitled === false) {
      toast.info(
        entry.requiredPlan === null
          ? t("subscribe.modelRequiresUpgrade")
          : t("subscribe.modelRequiresPlan", { plan: entry.requiredPlan }),
      );
      router.push("/(biglayout)/subscribe");
      return;
    }
    onModelChange(entry.id);
  };

  const renderEntry = (entry: CatalogueEntry) => {
    const label = presentation(entry, modes).label;
    return (
      <DropdownMenu.CheckboxItem
        key={entry.id}
        value={!isAutomatic && selection.effectiveId === entry.id ? "on" : "off"}
        onValueChange={() => selectEntry(entry)}
      >
        <DropdownMenu.ItemTitle>
          {`${entry.entitled === false ? "🔒 " : ""}${label}`}
        </DropdownMenu.ItemTitle>
      </DropdownMenu.CheckboxItem>
    );
  };

  return (
    <LocalModelsInvite>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Pressable
          accessibilityLabel={`${t("models.selectModel")}: ${modelLabel}`}
          accessibilityRole="button"
          className="h-9 flex-row items-center gap-1.5 rounded-full px-2.5 active:opacity-70 web:hover:bg-muted"
        >
          <Text className="max-w-32 text-sm font-medium text-foreground" numberOfLines={1}>
            {modelLabel}
          </Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenu.Trigger>

      <DropdownMenu.Content
        side="top"
        align="end"
        collisionPadding={8}
        className="w-72 rounded-2xl py-1.5 shadow-xl"
      >
        <DropdownMenu.Label className="px-2.5 font-normal">
          {t("models.selectModel")}
        </DropdownMenu.Label>
        <DropdownMenu.CheckboxItem
          key={AUTOMATIC_SELECTION_ID}
          value={isAutomatic ? "on" : "off"}
          onValueChange={() => onModelChange(AUTOMATIC_SELECTION_ID)}
        >
          <DropdownMenu.ItemTitle>{automaticLabel}</DropdownMenu.ItemTitle>
        </DropdownMenu.CheckboxItem>

        {profiles.length > 0 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Label className="px-2.5 font-normal">Modes</DropdownMenu.Label>
            {profiles.map(renderEntry)}
          </>
        )}

        {models.length > 0 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Label className="px-2.5 font-normal">Models</DropdownMenu.Label>
            {models.map(renderEntry)}
          </>
        )}

        {/* Models on the person's own devices — including devices that are not
            this one, which is the point: a phone cannot reach a laptop's
            localhost, so the laptop announced this list when it connected. */}
        {localModels.length > 0 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Label className="px-2.5 font-normal">
              {t("models.onYourDevices")}
            </DropdownMenu.Label>
            {localModels.map((model) => (
              <DropdownMenu.CheckboxItem
                key={model.id}
                value={!isAutomatic && selection.effectiveId === model.id ? "on" : "off"}
                // No plan gate: nobody's plan grants them their own machine.
                onValueChange={() => onModelChange(model.id)}
              >
                <DropdownMenu.ItemTitle>{`${model.name} · ${model.deviceLabel}`}</DropdownMenu.ItemTitle>
              </DropdownMenu.CheckboxItem>
            ))}
          </>
        )}

        {legacy.length > 0 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Label className="px-2.5 font-normal">Legacy</DropdownMenu.Label>
            {legacy.map(renderEntry)}
          </>
        )}

        {isPending && (
          <DropdownMenu.Item key="loading-models" disabled>
            <DropdownMenu.ItemTitle>{t("models.loadingModels")}</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        )}
        {!isPending && entries === undefined && (
          <DropdownMenu.Item key="models-unavailable" disabled>
            <DropdownMenu.ItemTitle>{t("models.catalogueUnavailable")}</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        )}

      </DropdownMenu.Content>
    </DropdownMenu.Root>
    </LocalModelsInvite>
  );
}
