import { useCallback, useMemo } from "react";
import type { ModelPickerModel, ModelPickerProvider } from "@oxy.so/bloom/composer-panel";
import { useTranslation } from "@/lib/hooks/use-translation";
import { useCatalogue, type CatalogueEntry, type EffortLevel } from "@/lib/hooks/use-catalogue";
import { useLocalModelOptions } from "@/lib/hooks/use-local-runtimes";
import { useModelSelection } from "@/lib/hooks/use-model-selection";
import { effortFor, useModelStore } from "@/lib/stores/model-store";
import { DeviceMark, FeaturedMark } from "./provider-marks";

/**
 * Alia's catalogue, in the shape Bloom's model picker takes.
 *
 * Alia has no models of its own, so the picker is the real models Oxy serves,
 * grouped the way every multi-provider assistant groups them — by the publisher
 * that released them. Bloom's `ModelPicker` turns one `ModelPickerProvider` per
 * group into its provider rail, searches every group at once (by model and by
 * publisher name) and draws the effort chip on the selected row, so this file
 * only has to build the groups:
 *
 *  1. **Featured** — the server's `featuredIds`, in its order, then the models
 *     this person pinned. Computed server-side; nothing here picks a model.
 *  2. **One group per publisher**, alphabetically, newest release first.
 *  3. **This account's machines** (models on the person's own devices).
 *
 * A featured or pinned model is ALSO in its publisher's group. Bloom keys a row
 * by its id, and a search lists every group's rows at once, so the first
 * group's rows carry a prefixed id ({@link FEATURED_PREFIX}) that this file
 * strips before anything else sees it.
 *
 * Effort is the chosen model's own `reasoningEfforts`: `[]` drops the effort
 * half of the panel, and `null` — no stop chosen — is the model's own default.
 */
export interface ComposerLineup {
  /**
   * The groups for `ComposerPanel`'s provider rail. Empty until the catalogue
   * (or a device) offers something, which is how the picker is hidden.
   */
  readonly providers: readonly ModelPickerProvider[];
  /** The row id the chip shows as chosen. */
  readonly model: string;
  readonly onModelChange: (rowId: string) => void;
  /** The chosen model's effort names, cheapest first. `[]` drops the effort half of the panel. */
  readonly effortLevels: readonly string[];
  /** An index into {@link effortLevels}, or `null` for "the model decides". */
  readonly effort: number | null;
  readonly onEffortChange: (index: number) => void;
  /** The chosen model, for the add menu's pin row; `null` while nothing is resolved. */
  readonly current: { readonly id: string; readonly name: string; readonly pinned: boolean } | null;
  readonly togglePinned: () => void;
}

/** Marks a row in the first group; never part of a model id (`publisher/model`). */
const FEATURED_PREFIX = "#featured:";

/** The row id a Bloom press reports, back to the model id it stands for. */
export function modelIdOfRow(rowId: string): string {
  return rowId.startsWith(FEATURED_PREFIX) ? rowId.slice(FEATURED_PREFIX.length) : rowId;
}

/** No level on offer, as one array for the life of the module. */
const NO_LEVELS: readonly EffortLevel[] = [];

/** Where each level's name lives, so every control says the same words. */
const EFFORT_LABEL_KEY: Record<EffortLevel, string> = {
  low: "effort.levels.low",
  medium: "effort.levels.medium",
  high: "effort.levels.high",
};

/** Newest release first; undated models after the dated ones, by name. */
function byRelease(a: CatalogueEntry, b: CatalogueEntry): number {
  const at = a.releasedAt ?? "";
  const bt = b.releasedAt ?? "";
  if (at !== bt) return at < bt ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/**
 * The picker's groups, pure so the order is testable without rendering.
 */
export function buildProviders(
  entries: readonly CatalogueEntry[],
  featuredIds: readonly string[],
  pinnedIds: readonly string[],
  localModels: readonly { id: string; name: string; deviceLabel: string }[],
  labels: { featured: string; device: string },
): ModelPickerProvider[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const localById = new Map(localModels.map((model) => [model.id, model]));
  const row = (entry: CatalogueEntry): ModelPickerModel => ({ id: entry.id, name: entry.name });
  const localRow = (model: { id: string; name: string; deviceLabel: string }): ModelPickerModel => ({
    id: model.id,
    // The device is part of the name because a phone can be offered a model
    // running on a laptop, and "which one" is the whole question then.
    name: `${model.name} · ${model.deviceLabel}`,
  });

  const firstIds: string[] = [];
  for (const id of [...featuredIds, ...pinnedIds]) {
    if (!firstIds.includes(id) && (byId.has(id) || localById.has(id))) firstIds.push(id);
  }
  const first = firstIds.map((id) => {
    const entry = byId.get(id);
    const base = entry !== undefined ? row(entry) : localRow(localById.get(id)!);
    return { ...base, id: `${FEATURED_PREFIX}${id}` };
  });

  const publishers = new Map<string, { name: string; entries: CatalogueEntry[] }>();
  for (const entry of entries) {
    const group = publishers.get(entry.publisher.id) ?? { name: entry.publisher.name, entries: [] };
    group.entries.push(entry);
    publishers.set(entry.publisher.id, group);
  }
  const byPublisher = [...publishers.entries()]
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .map(([id, group]) => ({
      id: `publisher:${id}`,
      name: group.name,
      models: [...group.entries].sort(byRelease).map(row),
    }));

  return [
    ...(first.length > 0 ? [{ id: "featured", name: labels.featured, logo: FeaturedMark, models: first }] : []),
    ...byPublisher,
    ...(localModels.length > 0
      ? [{ id: "device", name: labels.device, logo: DeviceMark, logoSize: 18 as const, models: localModels.map(localRow) }]
      : []),
  ];
}

/**
 * The picker's groups for the current account — the same lineup the composer
 * draws, for a screen that picks a model outside a composer (an agent's).
 */
export function useModelProviders(): readonly ModelPickerProvider[] {
  const { t } = useTranslation();
  const { data: catalogue } = useCatalogue();
  const { options: localModels } = useLocalModelOptions();
  const pinnedModels = useModelStore((state) => state.pinnedModels);
  return useMemo(
    () =>
      buildProviders(
        catalogue?.entries ?? [],
        catalogue?.featuredIds ?? [],
        pinnedModels,
        localModels,
        { featured: t("composer.featuredGroup"), device: t("composer.deviceGroup") },
      ),
    [catalogue, pinnedModels, localModels, t],
  );
}

export function useComposerLineup(
  selectedModel: string | null,
  onModelChange: (modelId: string | null) => void,
): ComposerLineup {
  const { t } = useTranslation();
  const { options: localModels } = useLocalModelOptions();
  const selection = useModelSelection(selectedModel);
  const providers = useModelProviders();

  const storedEffort = useModelStore((state) => state.reasoningEffort);
  const setReasoningEffort = useModelStore((state) => state.setReasoningEffort);
  const pinnedModels = useModelStore((state) => state.pinnedModels);
  const togglePinnedModel = useModelStore((state) => state.togglePinnedModel);

  /**
   * The row the chip shows: the first group's copy when the model is in it,
   * which is also where the rail opens.
   */
  const shownId = selection.shownId;
  const model = useMemo(() => {
    if (shownId === null) return "";
    const featuredRow = `${FEATURED_PREFIX}${shownId}`;
    return providers[0]?.id === "featured" && providers[0].models.some((row) => row.id === featuredRow)
      ? featuredRow
      : shownId;
  }, [providers, shownId]);

  const handleModelChange = useCallback(
    (rowId: string) => onModelChange(modelIdOfRow(rowId)),
    [onModelChange],
  );

  // `?? NO_LEVELS` and not `?? []`: a fresh empty array per render is a fresh
  // identity, and this one is a memo dependency AND a prop Bloom is handed on
  // every keystroke.
  const offeredLevels = selection.entry?.reasoningEfforts ?? NO_LEVELS;
  const activeLevel = effortFor(storedEffort, offeredLevels);
  const effortLevels = useMemo(
    () => offeredLevels.map((level) => t(EFFORT_LABEL_KEY[level])),
    [offeredLevels, t],
  );
  const effortIndex = activeLevel === null ? -1 : offeredLevels.indexOf(activeLevel);

  const handleEffortChange = useCallback(
    (index: number) => setReasoningEffort(offeredLevels[index] ?? null),
    [offeredLevels, setReasoningEffort],
  );

  const currentName =
    selection.entry?.name ??
    localModels.find((option) => option.id === shownId)?.name ??
    null;
  const current =
    shownId === null || currentName === null
      ? null
      : { id: shownId, name: currentName, pinned: pinnedModels.includes(shownId) };

  const togglePinned = useCallback(() => {
    if (shownId !== null) togglePinnedModel(shownId);
  }, [shownId, togglePinnedModel]);

  return {
    providers,
    model,
    onModelChange: handleModelChange,
    effortLevels,
    effort: effortIndex < 0 ? null : effortIndex,
    onEffortChange: handleEffortChange,
    current,
    togglePinned,
  };
}
