import { LocalModelsInvite } from '@/components/local-models-invite';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@oxy.so/bloom/dropdown-menu';
import {
  AUTOMATIC_SELECTION_ID,
  resolveSelection,
  useCatalogue,
  type CatalogueEntry,
} from '@/lib/hooks/use-catalogue';
import { useLocalModelOptions } from '@/lib/hooks/use-local-runtimes';
import {
  modeById,
  modeForProfile,
  presentation,
  useProductModes,
} from '@/lib/hooks/use-product-modes';
import { useTranslation } from '@/lib/hooks/use-translation';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useRouter } from 'expo-router';
import { ChevronDown } from 'lucide-react-native';
import { Pressable } from 'react-native';
interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
}

/**
 * Universal Expo picker for the composer. This is the single implementation
 * used by native and web; product modes stay separate from the neighbouring
 * effort control.
 */
export function ModelSelector({
  selectedModel,
  onModelChange,
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: entries, isPending } = useCatalogue();
  const { data: modes } = useProductModes();

  const { options: localModels, ids: localModelIds } = useLocalModelOptions();
  const selection = resolveSelection(
    selectedModel,
    entries,
    localModelIds,
    modes,
  );
  const selectedLocal = localModels.find(
    (model) => model.id === selection.effectiveId,
  );
  const isAutomatic = selection.requestedId === AUTOMATIC_SELECTION_ID;

  const automaticMode = modeById("mode:auto", modes);
  const automaticLabel = automaticMode?.label ?? t("models.automatic.label");
  const modelLabel = isAutomatic
    ? automaticLabel
    : // A local model has no catalogue entry to take a display name from, so the
      // tag the person knows it by is the label.
      selectedLocal !== undefined
      ? selectedLocal.name
      : selection.entry === null
        ? t("models.selectModel")
        : presentation(selection.entry, modes).label;

  const offered = (entries ?? []).filter(
    (entry) => entry.chatVisible && !entry.unavailable,
  );
  const profiles = offered.filter(
    (entry) =>
      entry.kind === "routing_profile" &&
      entry.id !== automaticMode?.routing.profileId &&
      modeForProfile(entry.id, modes) !== null,
  );
  const models = offered.filter((entry) => entry.kind === "model");

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
    onModelChange(modeForProfile(entry.id, modes)?.id ?? entry.id);
  };

  const renderEntry = (entry: CatalogueEntry) => {
    const label = presentation(entry, modes).label;
    return (
      <DropdownMenuCheckboxItem
        key={entry.id}
        checked={!isAutomatic &&
          selection.effectiveId ===
            (modeForProfile(entry.id, modes)?.id ?? entry.id)}
        onCheckedChange={() => selectEntry(entry)}
      >

          {`${entry.entitled === false ? "🔒 " : ""}${label}`}

      </DropdownMenuCheckboxItem>
    );
  };

  return (
    <LocalModelsInvite>
      <DropdownMenu>
        <DropdownMenuTrigger label="Actions" asChild>
          <Pressable
            accessibilityLabel={`${t("models.selectModel")}: ${modelLabel}`}
            accessibilityRole="button"
            className="h-9 flex-row items-center gap-1.5 rounded-full px-2.5 active:opacity-70 web:hover:bg-muted"
          >
            <Text
              className="max-w-32 text-sm font-medium text-foreground"
              numberOfLines={1}
            >
              {modelLabel}
            </Text>
            <ChevronDown size={14} className="text-muted-foreground" />
          </Pressable>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="end"

          minWidth={288}
        >
          <DropdownMenuLabel className="px-2.5 font-normal">
            {t("models.selectModel")}
          </DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            key={AUTOMATIC_SELECTION_ID}
            checked={isAutomatic}
            onCheckedChange={() => onModelChange(AUTOMATIC_SELECTION_ID)}
          >
            {automaticLabel}
          </DropdownMenuCheckboxItem>

          {profiles.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2.5 font-normal">
                Modes
              </DropdownMenuLabel>
              {profiles.map(renderEntry)}
            </>
          )}

          {models.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2.5 font-normal">
                Models
              </DropdownMenuLabel>
              {models.map(renderEntry)}
            </>
          )}

          {/* Models on the person's own devices — including devices that are not
            this one, which is the point: a phone cannot reach a laptop's
            localhost, so the laptop announced this list when it connected. */}
          {localModels.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="px-2.5 font-normal">
                {t("models.onYourDevices")}
              </DropdownMenuLabel>
              {localModels.map((model) => (
                <DropdownMenuCheckboxItem
                  key={model.id}
                  checked={!isAutomatic && selection.effectiveId === model.id}
                  // No plan gate: nobody's plan grants them their own machine.
                  onCheckedChange={() => onModelChange(model.id)}
                >
                  {`${model.name} · ${model.deviceLabel}`}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}

          {isPending && (
            <DropdownMenuItem key="loading-models" disabled>

                {t("models.loadingModels")}

            </DropdownMenuItem>
          )}
          {!isPending && entries === undefined && (
            <DropdownMenuItem key="models-unavailable" disabled>

                {t("models.catalogueUnavailable")}

            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </LocalModelsInvite>
  );
}
