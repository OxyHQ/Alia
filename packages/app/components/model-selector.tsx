import { ChevronDown, Lock } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Pressable, View, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { useMemo } from "react";
import { useRouter } from "expo-router";
import { useEntitlements } from "@/lib/hooks/use-billing";
import { toast } from "@oxyhq/bloom/toast";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  resolveSelection,
  useCatalogue,
  type CapabilityAvailability,
  type CatalogueEntry,
  type TokenBound,
} from "@/lib/hooks/use-catalogue";

/**
 * The chat model picker, driven by `GET /catalogue`.
 *
 * Three things it must not do, all of them things the previous version did
 * (epic #139 workstream 5, ADR 0003):
 *
 *  - **Present a routing profile as a model.** All thirteen `alia-*`
 *    identifiers are policies that pick a model per request, and a user has to
 *    be able to see which is which without decoding a name. Each row states its
 *    kind; on web the two kinds are also listed under separate headings.
 *  - **Report a capability it does not know.** The catalogue answers `always`,
 *    `sometimes`, `never` or `unknown`, and `unknown` is rendered as unknown.
 *    Greying out a working feature is the bug this replaces: the old picker
 *    read `supportsVision` off the alias, which says `false` for an identifier
 *    whose candidates include four models that do vision.
 *  - **Hard-code the model list.** The catalogue is the list. The only
 *    identifier this file knows is the one the user last chose.
 */

interface ModelSelectorProps {
  /** The identifier the user chose. Resolved against the catalogue before use. */
  selectedModel: string;
  onModelChange: (modelId: string) => void;
}

const CAPABILITY_KEYS = ['tools', 'vision', 'audio', 'reasoning', 'structuredOutput'] as const;

type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

const CAPABILITY_LABEL_KEY: Record<CapabilityKey, string> = {
  tools: 'models.capabilities.tools',
  vision: 'models.capabilities.vision',
  audio: 'models.capabilities.audio',
  reasoning: 'models.capabilities.reasoning',
  structuredOutput: 'models.capabilities.structuredOutput',
};

const AVAILABILITY_LABEL_KEY: Record<CapabilityAvailability, string> = {
  always: 'models.availability.always',
  sometimes: 'models.availability.sometimes',
  never: 'models.availability.never',
  unknown: 'models.availability.unknown',
};

/**
 * Every state gets its own treatment, and `unknown` gets one that reads as a
 * question rather than as a refusal — a dashed outline rather than the dimmed
 * fill `never` carries. The word beside it says the same thing, so the
 * distinction survives for anyone who does not see the difference.
 */
const AVAILABILITY_SURFACE: Record<CapabilityAvailability, string> = {
  always: 'bg-primary/10',
  sometimes: 'bg-muted',
  never: 'bg-muted',
  unknown: 'border border-dashed border-border',
};

const AVAILABILITY_TEXT: Record<CapabilityAvailability, string> = {
  always: 'text-primary',
  sometimes: 'text-foreground',
  never: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
};

type Translate = (key: string, params?: Record<string, unknown>) => string;

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  if (count >= 1_000) return `${Number((count / 1_000).toFixed(1))}K`;
  return String(count);
}

/** A bound the catalogue could not compute is unknown, not zero and not absent. */
function tokenBoundLabel(bound: TokenBound | null, t: Translate): string {
  if (bound === null) return t(AVAILABILITY_LABEL_KEY.unknown);
  if (bound.guaranteed === bound.upTo) return formatTokens(bound.upTo);
  return `${formatTokens(bound.guaranteed)}–${formatTokens(bound.upTo)}`;
}

interface Chip {
  readonly key: string;
  readonly label: string;
  readonly state: CapabilityAvailability;
}

/** The seven figures workstream 5 asks for, each carrying its own certainty. */
function capabilityChips(entry: CatalogueEntry, t: Translate): Chip[] {
  const chips: Chip[] = CAPABILITY_KEYS.map((key) => {
    const state = entry.capabilities[key];
    return {
      key,
      label: `${t(CAPABILITY_LABEL_KEY[key])}: ${t(AVAILABILITY_LABEL_KEY[state])}`,
      state,
    };
  });
  chips.push({
    key: 'contextWindow',
    label: `${t('models.capabilities.context')}: ${tokenBoundLabel(entry.capabilities.contextWindow, t)}`,
    state: entry.capabilities.contextWindow === null ? 'unknown' : 'always',
  });
  chips.push({
    key: 'maxOutput',
    label: `${t('models.capabilities.maxOutput')}: ${tokenBoundLabel(entry.capabilities.maxOutput, t)}`,
    state: entry.capabilities.maxOutput === null ? 'unknown' : 'always',
  });
  return chips;
}

/**
 * What the entry IS, in one line.
 *
 * A profile says it chooses, and says how widely. A model shows the identity
 * the catalogue carries and nothing else: publisher attribution does not exist
 * in Alia's data, so an entry with no publisher is rendered without one rather
 * than with a guess.
 */
function kindLine(entry: CatalogueEntry, t: Translate): string {
  if (entry.kind === 'routing_profile') {
    return entry.selectsAmong === null
      ? t('models.routingProfile')
      : t('models.routingProfileSelects', { count: entry.selectsAmong });
  }
  if (entry.publisher !== null && entry.model !== null) return `${entry.publisher}/${entry.model}`;
  return entry.model ?? t('models.concreteModel');
}

/** A sunset date, when one has been announced and can be read. */
function sunsetLine(entry: CatalogueEntry, t: Translate): string | null {
  if (entry.sunsetAt === null) return null;
  const at = new Date(entry.sunsetAt);
  if (Number.isNaN(at.getTime())) return null;
  return t('models.retiringOn', { date: at.toLocaleDateString() });
}

function CapabilityChipView({ chip }: { chip: Chip }) {
  return (
    <View className={`rounded-full px-1.5 py-0.5 ${AVAILABILITY_SURFACE[chip.state]}`}>
      <Text className={`text-[10px] ${AVAILABILITY_TEXT[chip.state]}`}>{chip.label}</Text>
    </View>
  );
}

function EntryRow({
  entry,
  selected,
  isLocked,
  onSelect,
}: {
  entry: CatalogueEntry;
  selected: boolean;
  isLocked: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const chips = capabilityChips(entry, t);
  const kind = kindLine(entry, t);
  const sunset = sunsetLine(entry, t);

  if (Platform.OS !== 'web') {
    // The native menu is the system's, so a row is a title and a subtitle. The
    // kind and the capability states go into the subtitle rather than being
    // dropped: they are the part a user cannot infer from the name.
    const subtitle = [
      entry.description,
      kind,
      entry.unavailable ? t('models.unavailable') : null,
      ...chips.map((chip) => chip.label),
      sunset,
    ]
      .filter((part): part is string => part !== null && part !== '')
      .join(' · ');
    return (
      <DropdownMenu.CheckboxItem
        key={entry.id}
        value={selected ? 'on' : 'off'}
        onValueChange={onSelect}
      >
        <DropdownMenu.ItemIndicator />
        <DropdownMenu.ItemTitle>
          {`${isLocked ? '🔒 ' : ''}${entry.emoji === null ? '' : `${entry.emoji} `}${entry.displayName}${entry.requiredPlan === null ? '' : ` (${entry.requiredPlan})`}`}
        </DropdownMenu.ItemTitle>
        <DropdownMenu.ItemSubtitle>{subtitle}</DropdownMenu.ItemSubtitle>
      </DropdownMenu.CheckboxItem>
    );
  }

  return (
    <DropdownMenu.CheckboxItem
      key={entry.id}
      value={selected ? 'on' : 'off'}
      onValueChange={onSelect}
    >
      <View className={`flex-col gap-1 flex-1 ${isLocked ? 'opacity-50' : ''}`}>
        <View className="flex-row items-center gap-1.5">
          {entry.emoji !== null && <Text className="text-sm">{entry.emoji}</Text>}
          <Text className="text-sm font-medium text-foreground">{entry.displayName}</Text>
          {isLocked && <Lock size={11} className="text-muted-foreground" />}
          {entry.requiredPlan !== null && (
            <View className="bg-primary/10 px-1.5 py-0.5 rounded-full">
              <Text className="text-[10px] font-semibold text-primary">{entry.requiredPlan}</Text>
            </View>
          )}
          {entry.unavailable && (
            <View className="bg-muted px-1.5 py-0.5 rounded-full">
              <Text className="text-[10px] font-semibold text-muted-foreground">
                {t('models.unavailable')}
              </Text>
            </View>
          )}
        </View>
        {entry.description !== '' && (
          <Text className="text-xs text-muted-foreground">{entry.description}</Text>
        )}
        <Text className="text-[11px] text-muted-foreground">{kind}</Text>
        <View className="flex-row flex-wrap gap-1">
          {chips.map((chip) => (
            <CapabilityChipView key={chip.key} chip={chip} />
          ))}
        </View>
        {sunset !== null && <Text className="text-[10px] text-muted-foreground">{sunset}</Text>}
      </View>
    </DropdownMenu.CheckboxItem>
  );
}

export function ModelSelector({ selectedModel, onModelChange }: ModelSelectorProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: entries, isPending } = useCatalogue();
  const { data: entitlements } = useEntitlements();

  // `null` is "we do not know what this caller may use", and it does not lock
  // anything: the server refuses a request outside the plan with the code the
  // upgrade dialog already handles, whereas a locked picker with no data behind
  // it hides working entries from a paying customer.
  const allowedIds = useMemo(
    () => (entitlements === undefined ? null : new Set(entitlements.allowedModelIds)),
    [entitlements],
  );
  const isLocked = (id: string) => allowedIds !== null && !allowedIds.has(id);

  const selection = resolveSelection(selectedModel, entries);

  const { profiles, models, legacy, offeredCount } = useMemo(() => {
    const offered = (entries ?? []).filter((entry) => entry.chatVisible);
    const current = offered.filter((entry) => !entry.legacy);
    return {
      profiles: current.filter((entry) => entry.kind === 'routing_profile'),
      models: current.filter((entry) => entry.kind === 'model'),
      legacy: offered.filter((entry) => entry.legacy),
      offeredCount: offered.length,
    };
  }, [entries]);

  const handleSelect = (entry: CatalogueEntry) => {
    if (isLocked(entry.id)) {
      toast.info(
        entry.requiredPlan === null
          ? t('subscribe.modelRequiresUpgrade')
          : t('subscribe.modelRequiresPlan', { plan: entry.requiredPlan }),
      );
      router.push('/(biglayout)/subscribe');
      return;
    }
    onModelChange(entry.id);
  };

  const renderRows = (list: readonly CatalogueEntry[]) =>
    list.map((entry) => (
      <EntryRow
        key={entry.id}
        entry={entry}
        selected={entry.id === selection.effectiveId}
        isLocked={isLocked(entry.id)}
        onSelect={() => handleSelect(entry)}
      />
    ));

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Pressable accessibilityLabel="Select model" accessibilityRole="button" className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted active:opacity-70">
          <Text className="text-sm font-medium text-foreground">
            {selection.entry?.displayName ?? selection.effectiveId}
          </Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" className="w-80">
        <DropdownMenu.Label className="text-xs text-muted-foreground font-normal px-2.5">{t('models.selectModel')}</DropdownMenu.Label>
        {isPending ? (
          <DropdownMenu.Item key="loading" disabled>
            <DropdownMenu.ItemTitle>{t('models.loadingModels')}</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        ) : entries === undefined ? (
          <DropdownMenu.Item key="unavailable" disabled>
            <DropdownMenu.ItemTitle>{t('models.catalogueUnavailable')}</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        ) : offeredCount === 0 ? (
          <DropdownMenu.Item key="empty" disabled>
            <DropdownMenu.ItemTitle>{t('models.noModels')}</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        ) : (
          <>
            {selection.source === 'replaced' && (
              <DropdownMenu.Item key="replaced" disabled>
                <DropdownMenu.ItemTitle>
                  {t('models.selectionReplaced', {
                    model: selection.entry?.displayName ?? selection.effectiveId,
                  })}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            )}
            {/* The headings are web-only because the native menu is the
                system's and its section behaviour is not something this
                codebase can verify. Nothing is lost: every native row states
                its own kind in its subtitle. */}
            {profiles.length > 0 && (
              <>
                {Platform.OS === 'web' && (
                  <DropdownMenu.Label className="text-xs text-muted-foreground font-normal px-2.5">
                    {t('models.routingProfilesSection')}
                  </DropdownMenu.Label>
                )}
                {renderRows(profiles)}
              </>
            )}
            {models.length > 0 && (
              <>
                {Platform.OS === 'web' && (
                  <DropdownMenu.Label className="text-xs text-muted-foreground font-normal px-2.5">
                    {t('models.modelsSection')}
                  </DropdownMenu.Label>
                )}
                {renderRows(models)}
              </>
            )}
            {legacy.length > 0 && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger key="legacy-models">
                    <DropdownMenu.ItemTitle>{t('models.legacyModels')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent className="w-80">
                    {renderRows(legacy)}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>
              </>
            )}
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
