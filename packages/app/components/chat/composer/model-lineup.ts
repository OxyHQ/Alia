import { useCallback, useMemo } from "react";
import { useRouter } from "expo-router";
import { toast } from "@oxy.so/bloom/toast";
import type { ModelPickerModel, ModelPickerProvider } from "@oxy.so/bloom/composer-panel";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  AUTOMATIC_SELECTION_ID,
  resolveSelection,
  useCatalogue,
  type CatalogueEntry,
  type EffortLevel,
} from "@/lib/hooks/use-catalogue";
import {
  modeById,
  modeForProfile,
  presentation,
  useProductModes,
} from "@/lib/hooks/use-product-modes";
import { useLocalModelOptions } from "@/lib/hooks/use-local-runtimes";
import { effortFor, useModelStore } from "@/lib/stores/model-store";
import { AliaMark, DeviceMark, ModelsMark } from "./provider-marks";

/**
 * Alia's catalogue, in the shape Bloom's model menu takes.
 *
 * ## Why this is a translation layer and not a component
 *
 * `ComposerPill` draws the model chip and the panel behind it; what it takes is
 * `ReadonlyArray<string | ModelPickerModel>` — a flat lineup, and a
 * `onModelChange(modelId)` that reports the **id**. That identity contract is
 * the one `docs/chat-runtime.mdx` requires and the one Alia's own selector
 * already kept: a routing profile is chosen by its opaque identifier and by
 * nothing else, never by a display name, a slug or a position. So the id half
 * carries over exactly.
 *
 * Everything Alia's picker did BESIDES naming a model has to be re-expressed
 * through that seam, and this file is where each of those is answered:
 *
 *  - **The entitlement gate.** `onModelChange` is intercepted rather than
 *    forwarded. Bloom's menu reports the row it was pressed on and closes
 *    itself; because the pill's `model` is controlled from here, a press on a
 *    row the plan does not cover can raise the upgrade path and simply not
 *    change the value — the menu closes on a selection that never happened,
 *    which is what the old `selectEntry` did too.
 *  - **The lock, visibly.** A gated row keeps the `🔒 ` its own rows carried.
 *    A control whose refusal is only discoverable by pressing it is a control
 *    that reads as broken.
 *  - **Effort, which is a second axis and not a second picker.** Bloom draws it
 *    inside the model panel, under the lineup, and takes `effortLevels` plus an
 *    INDEX into them. Alia stores a LEVEL (`instant` | `medium` | `high` |
 *    `max`) and offers only the ones every route behind the chosen entry can
 *    honour — `capabilities.reasoningLevels`, which `use-catalogue.ts` says is
 *    commonly empty. So the levels handed over are the offered ones alone and
 *    the index is into THAT list, which means the "nearest position the model
 *    actually offers" rule the old slider enforced by hand is now structural:
 *    there is no position on the track that is not on offer.
 *  - **`null` effort, which is not a level.** Bloom's `effort` accepts `null`
 *    for "no stop chosen — the parameter is omitted and the model decides", and
 *    draws the thumb hollow for it. That is the common case in Alia's
 *    catalogue, and it is the one thing the absence of a choice must not be
 *    allowed to look like a choice.
 *
 * Upstream operator and model names never appear here: the label is
 * `presentation(entry, modes).label`, the same product-facing string the old
 * selector drew, which is what `scripts/check-picker-language.mjs` reads.
 */
export interface ComposerLineup {
  /** The lineup, or empty — which is how the pill is told to draw no model chip. */
  readonly models: readonly ModelPickerModel[];
  /**
   * The same rows, grouped for `ComposerPanel`'s provider rail: Alia's own
   * modes, the concrete models, then this account's machines. The groups are
   * Alia's, never an upstream operator's (README § producto).
   */
  readonly providers: readonly ModelPickerProvider[];
  /** The id the chip shows as chosen. */
  readonly model: string;
  /** A row was pressed. May decline, and declines by not changing the value. */
  readonly onModelChange: (modelId: string) => void;
  /** The offered levels' names, cheapest first. `[]` drops the effort half of the panel. */
  readonly effortLevels: readonly string[];
  /** An index into {@link effortLevels}, or `null` for "the model decides". */
  readonly effort: number | null;
  readonly onEffortChange: (index: number) => void;
}

/** No level on offer, as one array for the life of the module. */
const NO_LEVELS: readonly EffortLevel[] = [];

/** Where each level's name lives, so every control says the same words. */
const EFFORT_LABEL_KEY: Record<EffortLevel, string> = {
  instant: "effort.levels.instant",
  medium: "effort.levels.medium",
  high: "effort.levels.high",
  max: "effort.levels.max",
};

/**
 * The id a catalogue entry is SELECTED by.
 *
 * A routing profile that a product mode fronts is chosen by the mode's id, not
 * the profile's — `modeForProfile` is the mapping, and the old selector applied
 * it in three separate places. It is one function here because the lineup's
 * keys, the controlled value and the change handler have to agree, and three
 * copies of a mapping is three chances for two of them to disagree.
 */
function selectionIdOf(
  entry: CatalogueEntry,
  modes: Parameters<typeof modeForProfile>[1],
): string {
  return modeForProfile(entry.id, modes)?.id ?? entry.id;
}

export function useComposerLineup(
  selectedModel: string,
  onModelChange: (modelId: string) => void,
): ComposerLineup {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: entries } = useCatalogue();
  const { data: modes } = useProductModes();
  const { options: localModels, ids: localModelIds } = useLocalModelOptions();

  const storedEffort = useModelStore((state) => state.reasoningEffort);
  const setReasoningEffort = useModelStore((state) => state.setReasoningEffort);

  const selection = resolveSelection(selectedModel, entries, localModelIds, modes);
  const automaticMode = modeById("mode:auto", modes);

  /**
   * The lineup, in the order the sections used to run: the automatic choice,
   * then the product modes, then the concrete models, then this account's own
   * machines. Bloom's panel is one radio group with one heading, so the ORDER
   * is what is left of the grouping — see the note in the composer's own file
   * about what that costs.
   */
  const providers = useMemo<ModelPickerProvider[]>(() => {
    const offered = (entries ?? []).filter(
      (entry) => entry.chatVisible && !entry.unavailable,
    );
    const named = (entry: CatalogueEntry) =>
      `${entry.entitled === false ? "🔒 " : ""}${presentation(entry, modes).label}`;

    const aliaModes: ModelPickerModel[] = [
      {
        id: AUTOMATIC_SELECTION_ID,
        name: automaticMode?.label ?? t("models.automatic.label"),
      },
    ];
    for (const entry of offered) {
      if (
        entry.kind !== "routing_profile" ||
        entry.id === automaticMode?.routing.profileId ||
        modeForProfile(entry.id, modes) === null
      ) {
        continue;
      }
      aliaModes.push({ id: selectionIdOf(entry, modes), name: named(entry) });
    }
    const concrete = offered
      .filter((entry) => entry.kind === "model")
      .map((entry) => ({ id: selectionIdOf(entry, modes), name: named(entry) }));
    // No plan gate on these: nobody's plan grants them their own machine. The
    // device is part of the name because a phone can be offered a model that
    // is running on a laptop, and "which one" is the whole question then.
    const local = localModels.map((model) => ({
      id: model.id,
      name: `${model.name} · ${model.deviceLabel}`,
    }));

    return [
      { id: "alia", name: "Alia", logo: AliaMark, models: aliaModes },
      ...(concrete.length
        ? [{ id: "models", name: t("composer.modelsGroup"), logo: ModelsMark, models: concrete }]
        : []),
      ...(local.length
        ? [{ id: "device", name: t("composer.deviceGroup"), logo: DeviceMark, logoSize: 18 as const, models: local }]
        : []),
    ];
  }, [entries, modes, automaticMode, localModels, t]);

  const models = useMemo(
    () => providers.flatMap((provider) => provider.models),
    [providers],
  );

  /**
   * Press a row.
   *
   * A row the plan does not cover raises the upgrade path and returns WITHOUT
   * writing the selection, so the chip keeps naming the model that is actually
   * in force. Bloom closes its own panel either way, which is the behaviour the
   * old `DropdownMenu` had.
   */
  const handleModelChange = useCallback(
    (modelId: string) => {
      const entry = (entries ?? []).find(
        (candidate) => selectionIdOf(candidate, modes) === modelId,
      );
      if (entry !== undefined && entry.entitled === false) {
        toast.info(
          entry.requiredPlan === null
            ? t("subscribe.modelRequiresUpgrade")
            : t("subscribe.modelRequiresPlan", { plan: entry.requiredPlan }),
        );
        router.push("/(biglayout)/subscribe");
        return;
      }
      onModelChange(modelId);
    },
    [entries, modes, onModelChange, router, t],
  );

  /**
   * The effort axis, as the levels the CHOSEN entry can honour.
   *
   * Empty for most selections, and empty is a real answer rather than a
   * degenerate one: a routing profile fanning out over seventeen deployments
   * offers a level only if all seventeen can send it. Bloom drops the effort
   * half of the panel outright at `[]`, which is exactly right — the old
   * control rendered a dead slider whose `max` was zero instead.
   */
  // `?? NO_LEVELS` and not `?? []`: a fresh empty array per render is a fresh
  // identity, and this one is a memo dependency AND a prop Bloom is handed on
  // every keystroke. Empty is the common answer here, so the common case is
  // the one that should not churn.
  const offeredLevels = selection.entry?.capabilities.reasoningLevels ?? NO_LEVELS;
  const activeLevel = effortFor(storedEffort, offeredLevels);
  const effortLevels = useMemo(
    () => offeredLevels.map((level) => t(EFFORT_LABEL_KEY[level])),
    // The array identity changes with the selection, which is what should
    // re-derive the labels; `t` changes with the language.
    [offeredLevels, t],
  );
  const effortIndex = activeLevel === null ? null : offeredLevels.indexOf(activeLevel);

  const handleEffortChange = useCallback(
    (index: number) => {
      const level = offeredLevels[index];
      // Bloom's slider can only land on a position, and every position here is
      // on offer — but an index from a lineup that changed under the panel is
      // still a level nobody chose, and `null` is the honest reading of it.
      setReasoningEffort(level ?? null);
    },
    [offeredLevels, setReasoningEffort],
  );

  return {
    models,
    providers,
    model: selection.requestedId,
    onModelChange: handleModelChange,
    effortLevels,
    // `indexOf` cannot fail here (`effortFor` already proved membership), but
    // -1 would be a position on the track, so it is folded back into "none".
    effort: effortIndex === null || effortIndex < 0 ? null : effortIndex,
    onEffortChange: handleEffortChange,
  };
}
