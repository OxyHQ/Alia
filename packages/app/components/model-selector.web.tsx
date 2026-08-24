import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@oxyhq/bloom/dropdown-menu";
import { Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { ComposerGlyph } from "@/components/ui/prompt-input/composer-glyph";
import { useColorScheme } from "@/lib/useColorScheme";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  AUTOMATIC_SELECTION_ID,
  EFFORT_LEVELS,
  resolveSelection,
  useCatalogue,
  type CatalogueEntry,
  type EffortLevel,
} from "@/lib/hooks/use-catalogue";
import { useLocalModelOptions } from "@/lib/hooks/use-local-runtimes";
import { presentation, useProductModes } from "@/lib/hooks/use-product-modes";
import { effortFor, useModelStore } from "@/lib/stores/model-store";
import { useRouter } from "expo-router";
import { toast } from "@oxyhq/bloom/toast";
import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
}

const EFFORT_LABEL: Record<EffortLevel, string> = {
  instant: "Instant",
  medium: "Medium",
  high: "High",
  max: "Extra High",
};

const POWER_LABELS = [
  "Instant",
  "Medium",
  "High",
  "Extra High",
  "Pro",
] as const;

/** The reference inset its five ticks by 13px from the ends of a 196px rail. */
function sliderPosition(index: number): string {
  return `calc(${index * 25}% + ${13 - index * 6.5}px)`;
}

function RadioCheck() {
  return <ComposerGlyph name="check" size={16} />;
}

/**
 * Composer intelligence picker.
 *
 * This deliberately follows the supplied component rather than the old Alia
 * catalogue dropdown: a 171x36 effort trigger opens a 224px compact power
 * slider; Advanced swaps that panel for two lateral Model/Effort submenus.
 * Only the colour tokens are Alia/Bloom semantic tokens.
 */
export function ModelSelector({
  selectedModel,
  onModelChange,
}: ModelSelectorProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const router = useRouter();
  const { data: entries } = useCatalogue();
  const { data: modes } = useProductModes();
  const storedEffort = useModelStore((state) => state.reasoningEffort);
  const setReasoningEffort = useModelStore((state) => state.setReasoningEffort);
  const [advanced, setAdvanced] = useState(false);
  const [sliderActive, setSliderActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);

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
    : selectedLocal !== undefined
      // A local model has no catalogue entry to take a display name from, so the
      // tag the person knows it by is the label.
      ? selectedLocal.name
      : selection.entry === null
        ? t("models.selectModel")
        : presentation(selection.entry, modes).label;
  const offered = (entries ?? []).filter(
    (entry) => entry.chatVisible && !entry.unavailable,
  );

  const supportedEfforts = selection.entry?.capabilities.reasoningLevels ?? [];
  const activeEffort = effortFor(storedEffort, supportedEfforts);
  const activeIndex =
    activeEffort === null ? -1 : EFFORT_LEVELS.indexOf(activeEffort);
  // The model default is shown as the same neutral second-position marker the
  // reference uses, while its label remains truthful: Default, not Medium.
  const visualIndex = activeIndex < 0 ? 1 : activeIndex;
  const effortLabel =
    activeEffort === null ? "Default" : EFFORT_LABEL[activeEffort];

  const selectModel = (entry: CatalogueEntry) => {
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

  const setEffortByIndex = (index: number) => {
    const level = EFFORT_LEVELS[index];
    if (level !== undefined && supportedEfforts.includes(level)) {
      setReasoningEffort(level);
    }
  };

  const moveEffort = (direction: -1 | 1) => {
    const start =
      activeIndex < 0
        ? direction > 0
          ? -1
          : EFFORT_LEVELS.length
        : activeIndex;
    for (
      let index = start + direction;
      index >= 0 && index < EFFORT_LEVELS.length;
      index += direction
    ) {
      if (supportedEfforts.includes(EFFORT_LEVELS[index])) {
        setReasoningEffort(EFFORT_LEVELS[index]);
        return;
      }
    }
  };

  const setEffortFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = sliderRef.current?.getBoundingClientRect();
    if (!rect || supportedEfforts.length === 0) return;
    const index = Math.round(((event.clientX - rect.left) / rect.width) * 4);
    setEffortByIndex(Math.max(0, Math.min(EFFORT_LEVELS.length - 1, index)));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={`Power: ${effortLabel}`}>
        <Pressable
          accessibilityLabel={`Power: ${effortLabel}`}
          accessibilityRole="button"
          className="relative h-9 w-[171px] flex-row items-center justify-center rounded-full bg-muted px-9 active:opacity-70 web:hover:bg-muted/80"
        >
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {effortLabel}
          </Text>
          <span className="absolute right-3 flex h-4 w-4 items-center justify-center text-muted-foreground">
            <ComposerGlyph
              name="chevron-down"
              size={16}
              color={colors.mutedForeground}
            />
          </span>
        </Pressable>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="end"
        alignOffset={-26}
        sideOffset={4}
        // `text-foreground` on the panel, not on each row.
        //
        // Bloom colours a row's text through its TITLE slot, and
        // `floating/shared.tsx` `splitChildren` only fills that slot for a
        // STRING child: `typeof children === 'string' ? { title } : { body }`.
        // Every row here passes a `<span>`, so it lands in `body` and renders
        // inside `ROW_CLASS`, which carries no colour at all — leaving the text
        // at the browser default. Invisible in light mode, black-on-dark in dark.
        //
        // Not a Bloom bug: on native a `<Text>` does not inherit colour from a
        // `View`, so colouring the container would fix web only, which is why
        // Bloom colours the slot it owns and leaves custom children to the
        // caller. This is the caller doing it, once per panel, so the explicit
        // `text-muted-foreground` spans still win by specificity.
        className="w-[224px] min-w-[224px] max-w-[calc(100vw-24px)] rounded-[20px] px-0 py-2.5 text-foreground"
      >
        <div
          role="group"
          data-testid="composer-intelligence-picker-content"
          className="relative flex w-[min(224px,_calc(100vw_-_24px))] flex-col overflow-hidden transition-[height] duration-200 ease-out"
          style={{ height: advanced ? 112 : 76 }}
        >
          <div
            inert={advanced}
            aria-hidden={advanced}
            className={cn(
              "absolute inset-x-0 top-0 flex h-10 items-center px-3.5 transition-all duration-200",
              advanced
                ? "pointer-events-none -translate-y-2 opacity-0"
                : "translate-y-0 opacity-100",
            )}
          >
            <div
              ref={sliderRef}
              role="slider"
              tabIndex={advanced ? -1 : 0}
              aria-label="Power"
              aria-disabled={supportedEfforts.length === 0}
              aria-valuemin={0}
              aria-valuemax={4}
              aria-valuenow={activeIndex < 0 ? 0 : activeIndex}
              aria-valuetext={effortLabel}
              onPointerEnter={() => setSliderActive(true)}
              onPointerLeave={() => {
                if (!dragging) setSliderActive(false);
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging(true);
                setSliderActive(true);
                setEffortFromPointer(event);
              }}
              onPointerMove={(event) => {
                if (dragging) setEffortFromPointer(event);
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                setDragging(false);
              }}
              onPointerCancel={() => setDragging(false)}
              onFocus={() => setSliderActive(true)}
              onBlur={() => setSliderActive(false)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  moveEffort(-1);
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  moveEffort(1);
                }
              }}
              className={cn(
                "relative h-6 w-full touch-none rounded-full bg-muted-foreground/25 outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
                supportedEfforts.length === 0 && "cursor-not-allowed",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full bg-primary",
                  activeIndex < 0 && "opacity-65",
                )}
                style={{ width: sliderPosition(visualIndex) }}
              />
              {POWER_LABELS.map((label, index) => (
                <span
                  key={label}
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                    visualIndex >= index
                      ? "bg-primary-foreground/35"
                      : "bg-muted-foreground/65",
                  )}
                  style={{ left: sliderPosition(index) }}
                />
              ))}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-1/2 h-[30px] w-[30px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-background shadow-sm",
                  activeIndex < 0 && "opacity-90",
                )}
                style={{ left: sliderPosition(visualIndex) }}
              />
            </div>
          </div>

          <button
            type="button"
            role="menuitem"
            aria-expanded={advanced}
            aria-label={
              advanced ? "Show compact options" : "Show advanced options"
            }
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setAdvanced((value) => !value);
            }}
            className={cn(
              "absolute inset-x-0 flex h-9 w-full cursor-default items-center border-0 bg-transparent px-4 text-left text-sm text-popover-foreground outline-none transition-[top] duration-200 hover:bg-accent focus:bg-accent",
              advanced ? "top-0" : "top-10",
              !advanced && sliderActive && "pointer-events-none opacity-0",
            )}
          >
            <span className="flex items-center gap-1">
              <span>Advanced</span>
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center transition-transform",
                  advanced && "rotate-90",
                )}
              >
                <ComposerGlyph
                  name="chevron-right"
                  size={16}
                  color={colors.mutedForeground}
                />
              </span>
            </span>
          </button>
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-10 flex h-9 items-center justify-between px-4 text-xs text-muted-foreground transition-opacity duration-150",
              !advanced && sliderActive ? "opacity-100" : "opacity-0",
            )}
          >
            <span>Faster</span>
            <span>Smarter</span>
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-4 right-4 top-9 h-px bg-border transition-opacity duration-200",
              advanced ? "opacity-100" : "opacity-0",
            )}
          />

          <div
            inert={!advanced}
            aria-hidden={!advanced}
            className={cn(
              "absolute inset-x-0 top-9 h-[76px] pt-1 transition-all duration-200",
              advanced
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-2 opacity-0",
            )}
          >
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                accessibilityLabel={`Model, ${modelLabel}`}
                className="mx-2.5 h-9"
              >
                <span>Model</span>
                <span className="ml-auto max-w-24 truncate text-muted-foreground">
                  {modelLabel}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                label="Model"
                side="right"
                align="start"
                sideOffset={2}
                alignOffset={-10}
                className="w-[202px] min-w-[202px] max-w-[202px] rounded-[20px] py-2.5 text-foreground"
              >
                <DropdownMenuRadioGroup
                  value={
                    isAutomatic
                      ? AUTOMATIC_SELECTION_ID
                      : (selection.effectiveId ?? "")
                  }
                  onValueChange={(id) => {
                    if (id === AUTOMATIC_SELECTION_ID) onModelChange(id);
                    else if (localModelIds.includes(id)) {
                      // No plan gate: nobody's plan grants them their own machine.
                      onModelChange(id);
                    } else {
                      const entry = offered.find(
                        (candidate) => candidate.id === id,
                      );
                      if (entry) selectModel(entry);
                    }
                  }}
                >
                  <DropdownMenuRadioItem
                    value={AUTOMATIC_SELECTION_ID}
                    indicator={<RadioCheck />}
                    indicatorPosition="trailing"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {automaticLabel}
                    </span>
                  </DropdownMenuRadioItem>
                  {offered.map((entry) => (
                    <DropdownMenuRadioItem
                      key={entry.id}
                      value={entry.id}
                      accessibilityLabel={
                        entry.entitled === false
                          ? `${presentation(entry, modes).label}, requires upgrade`
                          : presentation(entry, modes).label
                      }
                      indicator={<RadioCheck />}
                      indicatorPosition="trailing"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {presentation(entry, modes).label}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                  {/* Models running on the person's own devices. Listed after the
                      catalogue and labelled by device, because with a laptop and a
                      desktop connected the same tag names two different answers. */}
                  {localModels.map((model) => (
                    <DropdownMenuRadioItem
                      key={model.id}
                      value={model.id}
                      accessibilityLabel={`${model.name}, on ${model.deviceLabel}`}
                      indicator={<RadioCheck />}
                      indicatorPosition="trailing"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {model.name}
                        <span className="text-muted-foreground"> · {model.deviceLabel}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                accessibilityLabel={`Effort, ${effortLabel}`}
                className="mx-2.5 h-9"
              >
                <span>Effort</span>
                <span className="ml-auto max-w-24 truncate text-muted-foreground">
                  {effortLabel}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                label="Effort"
                side="right"
                align="start"
                sideOffset={2}
                alignOffset={-10}
                className="w-[150px] min-w-[150px] max-w-[150px] rounded-[20px] py-2.5 text-foreground"
              >
                <DropdownMenuRadioGroup
                  value={activeEffort ?? ""}
                  onValueChange={(value) =>
                    setReasoningEffort(value as EffortLevel)
                  }
                >
                  {EFFORT_LEVELS.map((level) => (
                    <DropdownMenuRadioItem
                      key={level}
                      value={level}
                      disabled={!supportedEfforts.includes(level)}
                      indicator={<RadioCheck />}
                      indicatorPosition="trailing"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {EFFORT_LABEL[level]}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuRadioItem
                    value="pro"
                    disabled
                    accessibilityLabel="Pro, unavailable"
                    indicator={<RadioCheck />}
                    indicatorPosition="trailing"
                  >
                    <span className="min-w-0 flex-1 truncate">Pro</span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
