import { ChevronDown, Lock } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Pressable, View, Platform } from "react-native";
import { Text } from "@/components/ui/text";
import { Fragment, useMemo } from "react";
import { useRouter } from "expo-router";
import { toast } from "@oxyhq/bloom/toast";
import { useTranslation } from "@/lib/hooks/use-translation";
import {
  AUTOMATIC_SELECTION_ID,
  resolveSelection,
  useCatalogue,
  type CapabilityAvailability,
  type CatalogueEntry,
  type TokenBound,
} from "@/lib/hooks/use-catalogue";
import { presentation, useProductModes, type ProductMode } from "@/lib/hooks/use-product-modes";

/**
 * The chat model picker, driven by `GET /catalogue` and `GET /catalogue/modes`.
 *
 * ## What a person sees, and why it is shaped this way
 *
 * A single flat list of rows, each carrying a description, a kind line and
 * seven capability pills, is a diagnostic view served as a product menu — you
 * cannot scan it, and everything on it competes for the same attention. So the
 * menu has a shape now:
 *
 *  1. **Automatic first**, on its own above a separator. It is not one of the
 *     offered entries — it is the choice to let the server choose — so it does
 *     not belong inside any group of them.
 *  2. **Sections by what an entry is FOR**, from the catalogue's own `category`.
 *  3. **Identity, then cost, then everything else.** A row leads with the
 *     product's word for the entry and, beside it in the secondary colour, what
 *     a message on it costs relative to the base rate. Those two answer the
 *     question a person opens this menu with; the description and the
 *     capability facts sit under them, quieter.
 *  4. **Retired entries behind a submenu** at the very end.
 *
 * ## The one grouping this menu cannot have
 *
 * Not by who makes the model. `publisher` and `model` are served `null` for
 * every catalogue entry, and `packages/api/src/__tests__/architectureGates.test.ts`
 * fails the build if a catalogue response names a provider or a provider model
 * id outside the licence-attribution field. Grouping by purpose is not second
 * best here; it is the axis the product actually has.
 *
 * ## Three things it must not do, all of them things earlier versions did
 * (epic #139 workstream 5, ADR 0003):
 *
 *  - **Present a routing profile as a model.** All thirteen `alia-*`
 *    identifiers are policies that pick a model per request, and a user has to
 *    be able to see which is which without decoding a name. Every row says how
 *    many models its entry picks among, in its own facts line.
 *  - **Report a capability it does not know.** The catalogue answers `always`,
 *    `sometimes`, `never` or `unknown`. A row lists what is claimed and names
 *    what is unknown, so absence from both is `never` and is never confused
 *    with "we did not measure it". Greying out a working feature is the bug
 *    this replaces.
 *  - **Hard-code the model list.** The catalogue is the list, its `category`
 *    values are the sections, and their order is the order the server sent. A
 *    seventh category server-side becomes a seventh section with no change
 *    here.
 */

interface ModelSelectorProps {
  /** The identifier the user chose. Resolved against the catalogue before use. */
  selectedModel: string;
  onModelChange: (modelId: string) => void;
}

/**
 * The Automatic row's icon.
 *
 * Every other row wears the `emoji` its catalogue entry carries. Automatic has
 * no catalogue entry — it is the choice not to pick one — so its icon is the
 * app's, and it lives here rather than in the modes response because it is
 * decoration, not a fact about routing.
 */
const AUTOMATIC_EMOJI = '✨';

const CAPABILITY_KEYS = ['tools', 'vision', 'audio', 'reasoning', 'structuredOutput'] as const;

type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

const CAPABILITY_LABEL_KEY: Record<CapabilityKey, string> = {
  tools: 'models.capabilities.tools',
  vision: 'models.capabilities.vision',
  audio: 'models.capabilities.audio',
  reasoning: 'models.capabilities.reasoning',
  structuredOutput: 'models.capabilities.structuredOutput',
};

type Translate = (key: string, params?: Record<string, unknown>) => string;

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
  if (count >= 1_000) return `${Number((count / 1_000).toFixed(1))}K`;
  return String(count);
}

/** A bound the catalogue could not compute is unknown, not zero and not absent. */
function tokenBoundLabel(bound: TokenBound | null, t: Translate): string | null {
  if (bound === null) return null;
  if (bound.guaranteed === bound.upTo) return formatTokens(bound.upTo);
  return `${formatTokens(bound.guaranteed)}–${formatTokens(bound.upTo)}`;
}

/**
 * What a message on this entry costs, relative to the base rate.
 *
 * The catalogue's `credit_multiplier`, which is also the key the server orders
 * the list by — so it is both the most decision-relevant number on a row and
 * the one that explains the order rows appear in. `null` when the server did
 * not say, and then nothing is rendered: a missing multiplier is not `1`.
 */
function costLabel(entry: CatalogueEntry): string | null {
  if (entry.creditMultiplier === null) return null;
  return `${entry.creditMultiplier}×`;
}

/**
 * The facts under a row, as one line rather than a grid of pills.
 *
 * Three clauses, and the middle one is why this is safe to compress:
 *
 *  - what the entry IS — a policy over N models, or one model;
 *  - what it CLAIMS — every `always` capability, and every `sometimes` one
 *    marked as such;
 *  - what is UNKNOWN — named, not omitted.
 *
 * A `never` capability appears in neither list, and that is the only thing an
 * absence can mean, because the unknown ones are spelled out. Dropping the
 * unknown clause is what would turn this into the bug ADR 0003 forbids.
 */
function factsLine(entry: CatalogueEntry, t: Translate): string {
  const parts: string[] = [];

  if (entry.kind === 'routing_profile') {
    parts.push(
      entry.selectsAmong === null
        ? t('models.routingProfile')
        : t('models.picksAmong', { count: entry.selectsAmong }),
    );
  } else {
    parts.push(t('models.concreteModel'));
  }

  const claimed: string[] = [];
  const unknown: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    const state: CapabilityAvailability = entry.capabilities[key];
    const label = t(CAPABILITY_LABEL_KEY[key]);
    if (state === 'always') claimed.push(label);
    if (state === 'sometimes') claimed.push(t('models.capabilitySometimes', { capability: label }));
    if (state === 'unknown') unknown.push(label.toLocaleLowerCase());
  }
  if (claimed.length > 0) parts.push(claimed.join(', '));

  const context = tokenBoundLabel(entry.capabilities.contextWindow, t);
  if (context !== null) parts.push(t('models.contextOf', { tokens: context }));

  const maxOutput = tokenBoundLabel(entry.capabilities.maxOutput, t);
  if (maxOutput !== null) parts.push(t('models.maxOutputOf', { tokens: maxOutput }));

  // A bound the catalogue could not compute is unknown in exactly the sense the
  // capability states are, so it joins them here rather than being dropped
  // silently — that is the difference between "no limit stated" and "no limit".
  if (entry.capabilities.contextWindow === null) unknown.push(t('models.capabilities.context').toLocaleLowerCase());
  if (entry.capabilities.maxOutput === null) unknown.push(t('models.capabilities.maxOutput').toLocaleLowerCase());

  if (unknown.length > 0) parts.push(t('models.unknownOf', { capabilities: unknown.join(', ') }));

  return parts.join(' · ');
}

/** A sunset date, when one has been announced and can be read. */
function sunsetLine(entry: CatalogueEntry, t: Translate): string | null {
  if (entry.sunsetAt === null) return null;
  const at = new Date(entry.sunsetAt);
  if (Number.isNaN(at.getTime())) return null;
  return t('models.retiringOn', { date: at.toLocaleDateString() });
}

/**
 * The six categories the routing table defines today
 * (`internal/providers/lib/alia-models.ts`, `ModelCategory`).
 *
 * A map of WORDS, not of what exists: the sections themselves are whatever the
 * server groups entries into, and a category missing from this map still gets
 * its own section, headed by its own name. Falling back to a shared "Other"
 * would merge two distinct purposes under one heading the day the server grows
 * a seventh, which is the failure that makes a hand-maintained map dangerous.
 */
const CATEGORY_LABEL_KEY: Record<string, string> = {
  general: 'models.categories.general',
  coding: 'models.categories.coding',
  vision: 'models.categories.vision',
  audio: 'models.categories.audio',
  voice: 'models.categories.voice',
  multimodal: 'models.categories.multimodal',
};

/** A section heading, from a catalogue `category`. */
function categoryLabel(category: string, t: Translate): string {
  if (category === '') return t('models.uncategorised');
  const key = CATEGORY_LABEL_KEY[category];
  if (key !== undefined) return t(key);
  return category.charAt(0).toLocaleUpperCase() + category.slice(1);
}

/** A small pill: a required plan, or an unavailability the server declared. */
function RowBadge({ label, tone }: { label: string; tone: 'plan' | 'muted' }) {
  return (
    <View
      className={`px-1.5 py-0.5 rounded-full ${tone === 'plan' ? 'bg-primary/10' : 'bg-muted'}`}
    >
      <Text
        className={`text-[10px] font-semibold ${tone === 'plan' ? 'text-primary' : 'text-muted-foreground'}`}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * The row a person reads before anything else.
 *
 * `name` carries the weight and `variant` sits beside it in the secondary
 * colour at normal weight — the hierarchy that lets a list of entries be
 * scanned by name with the differentiator still legible. Here the variant is
 * the relative cost, because that is the axis the product actually varies
 * along and the one the catalogue is ordered by.
 */
function IdentityLine({
  name,
  variant,
  emoji,
  locked,
  badges,
}: {
  name: string;
  variant: string | null;
  emoji: string | null;
  locked: boolean;
  badges: readonly { key: string; label: string; tone: 'plan' | 'muted' }[];
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      {emoji !== null && <Text className="text-sm">{emoji}</Text>}
      <View className="flex-row items-baseline gap-1">
        <Text className="text-sm font-medium text-foreground">{name}</Text>
        {variant !== null && (
          <Text className="text-sm font-normal text-muted-foreground">{variant}</Text>
        )}
      </View>
      {locked && <Lock size={11} className="text-muted-foreground" />}
      {badges.map((badge) => (
        <RowBadge key={badge.key} label={badge.label} tone={badge.tone} />
      ))}
    </View>
  );
}

/**
 * "Let Alia decide", rendered from the product's own mode when it has loaded.
 *
 * The row's BEHAVIOUR does not depend on the modes request: choosing it stores
 * {@link AUTOMATIC_SELECTION_ID}, which resolves to a request carrying no
 * `model` at all, and that is true whether or not `/catalogue/modes` answered.
 * Only its WORDS come from the server, so they fall back to the app's own when
 * they have to — a picker that hid its default option because a second request
 * was slow would be offering less than the product does.
 */
function AutomaticRow({
  mode,
  selected,
  onSelect,
}: {
  mode: ProductMode | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const label = mode?.label ?? t('models.automatic.label');
  const description = mode?.description ?? t('models.automatic.description');

  if (Platform.OS !== 'web') {
    return (
      <DropdownMenu.CheckboxItem
        key={AUTOMATIC_SELECTION_ID}
        value={selected ? 'on' : 'off'}
        onValueChange={onSelect}
      >
        <DropdownMenu.ItemIndicator />
        <DropdownMenu.ItemTitle>{`${AUTOMATIC_EMOJI} ${label}`}</DropdownMenu.ItemTitle>
        <DropdownMenu.ItemSubtitle>{description}</DropdownMenu.ItemSubtitle>
      </DropdownMenu.CheckboxItem>
    );
  }

  return (
    <DropdownMenu.CheckboxItem
      key={AUTOMATIC_SELECTION_ID}
      value={selected ? 'on' : 'off'}
      onValueChange={onSelect}
    >
      <View className="flex-col gap-0.5 flex-1 py-0.5">
        <IdentityLine name={label} variant={null} emoji={AUTOMATIC_EMOJI} locked={false} badges={[]} />
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
    </DropdownMenu.CheckboxItem>
  );
}

function EntryRow({
  entry,
  modes,
  selected,
  isLocked,
  onSelect,
}: {
  entry: CatalogueEntry;
  modes: readonly ProductMode[] | undefined;
  selected: boolean;
  isLocked: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const facts = factsLine(entry, t);
  const sunset = sunsetLine(entry, t);
  const cost = costLabel(entry);
  const { label, description } = presentation(entry, modes);

  const badges: { key: string; label: string; tone: 'plan' | 'muted' }[] = [];
  if (entry.requiredPlan !== null) {
    badges.push({ key: 'plan', label: entry.requiredPlan, tone: 'plan' });
  }
  if (entry.unavailable) {
    badges.push({ key: 'unavailable', label: t('models.unavailable'), tone: 'muted' });
  }

  if (Platform.OS !== 'web') {
    // The native menu is the system's, so a row is a title and a subtitle. The
    // section heading a web row gets from its group is folded into the subtitle
    // here rather than dropped: on native it is the only place the category can
    // be read.
    const subtitle = [
      description,
      categoryLabel(entry.category, t),
      facts,
      entry.unavailable ? t('models.unavailable') : null,
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
          {`${isLocked ? '🔒 ' : ''}${entry.emoji === null ? '' : `${entry.emoji} `}${label}${cost === null ? '' : ` ${cost}`}${entry.requiredPlan === null ? '' : ` (${entry.requiredPlan})`}`}
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
      <View className={`flex-col gap-0.5 flex-1 py-0.5 ${isLocked ? 'opacity-50' : ''}`}>
        <IdentityLine
          name={label}
          variant={cost}
          emoji={entry.emoji}
          locked={isLocked}
          badges={badges}
        />
        {description !== '' && (
          <Text className="text-xs text-muted-foreground">{description}</Text>
        )}
        <Text className="text-[11px] text-muted-foreground">{facts}</Text>
        {sunset !== null && <Text className="text-[10px] text-muted-foreground">{sunset}</Text>}
      </View>
    </DropdownMenu.CheckboxItem>
  );
}

/** A section's worth of rows, headed on web by what the entries are for. */
interface CategorySection {
  readonly category: string;
  readonly entries: readonly CatalogueEntry[];
}

/**
 * Group the offered entries by category, keeping the server's order.
 *
 * Order matters twice, and both come from the response rather than from a table
 * here: rows keep the order the server sent (ascending `credit_multiplier`), and
 * a section appears where its first entry does. So the cheapest thing in the
 * cheapest section is the first row under Automatic, without this file knowing
 * what any category is called.
 */
function groupByCategory(entries: readonly CatalogueEntry[]): CategorySection[] {
  const sections: CategorySection[] = [];
  const byCategory = new Map<string, CatalogueEntry[]>();
  for (const entry of entries) {
    const existing = byCategory.get(entry.category);
    if (existing === undefined) {
      const created: CatalogueEntry[] = [entry];
      byCategory.set(entry.category, created);
      sections.push({ category: entry.category, entries: created });
    } else {
      existing.push(entry);
    }
  }
  return sections;
}

export function ModelSelector({ selectedModel, onModelChange }: ModelSelectorProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { data: entries, isPending } = useCatalogue();
  const { data: modes, isPending: modesPending } = useProductModes();

  // The catalogue's own answer, in the catalogue's own vocabulary.
  //
  // Only an explicit `false` locks. `null` is "we do not know what this caller
  // may use" and it locks nothing: the server refuses a request outside the
  // plan with the code the upgrade dialog already handles, whereas a locked
  // picker with no data behind it hides working entries from a paying
  // customer. Comparing ids here against a second endpoint is what broke —
  // see `entitled` in `use-catalogue.ts`.
  const isLocked = (entry: CatalogueEntry) => entry.entitled === false;

  const selection = resolveSelection(selectedModel, entries);
  const isAutomatic = selection.requestedId === AUTOMATIC_SELECTION_ID;

  // The product mode with no profile behind it, which is what the Automatic row
  // is. Found by routing kind rather than by id, so the row follows the modes
  // table instead of hard-coding `mode:automatic` — and `null` when the table
  // has not loaded, which the row renders from its own words.
  const automaticMode = useMemo(
    () => (modes ?? []).find((mode) => mode.routing.kind === 'default' && !mode.deepResearch) ?? null,
    [modes],
  );

  const { sections, legacy, offeredCount } = useMemo(() => {
    const offered = (entries ?? []).filter((entry) => entry.chatVisible);
    return {
      sections: groupByCategory(offered.filter((entry) => !entry.legacy)),
      legacy: offered.filter((entry) => entry.legacy),
      offeredCount: offered.length,
    };
  }, [entries]);

  const handleSelect = (entry: CatalogueEntry) => {
    if (isLocked(entry)) {
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
        modes={modes}
        selected={!isAutomatic && entry.id === selection.effectiveId}
        isLocked={isLocked(entry)}
        onSelect={() => handleSelect(entry)}
      />
    ));

  /**
   * The pill in the header names the current choice — or says nothing about it.
   *
   * `selection.entry` is `null` only while the catalogue is unreadable, and the
   * stored identifier is NOT a name: it printed `profile:v1` into the header on
   * every cold load, which is an internal identifier presented as a product
   * name — the habit ADR 0003 exists to end, in the most visible place in the
   * app. The menu's own heading is the honest stand-in until the catalogue can
   * say what the choice is called.
   */
  const triggerLabel = isAutomatic
    ? (automaticMode?.label ?? t('models.automatic.label'))
    : selection.entry === null
      ? t('models.selectModel')
      : presentation(selection.entry, modes).label;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Pressable accessibilityLabel="Select model" accessibilityRole="button" className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted active:opacity-70">
          <Text className="text-sm font-medium text-foreground">{triggerLabel}</Text>
          <ChevronDown size={14} className="text-muted-foreground" />
        </Pressable>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" className="w-96">
        <DropdownMenu.Label className="text-xs text-muted-foreground font-normal px-2.5">{t('models.selectModel')}</DropdownMenu.Label>

        {/* Automatic and the offered entries come from two independent
            requests, so they load — and fail — independently. The row is held
            back only while its OWN request is in flight. */}
        {modesPending ? (
          <DropdownMenu.Item key="modes-loading" disabled>
            <DropdownMenu.ItemTitle>{t('models.loadingModes')}</DropdownMenu.ItemTitle>
          </DropdownMenu.Item>
        ) : (
          <AutomaticRow
            mode={automaticMode}
            selected={isAutomatic}
            onSelect={() => onModelChange(AUTOMATIC_SELECTION_ID)}
          />
        )}
        <DropdownMenu.Separator />

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
                    model:
                      selection.entry === null
                        ? (selection.effectiveId ?? selection.requestedId)
                        : presentation(selection.entry, modes).label,
                  })}
                </DropdownMenu.ItemTitle>
              </DropdownMenu.Item>
            )}
            {/* Both the heading and the group wrapper are web-only, because the
                native menu is the system's and its section behaviour is not
                something this codebase can verify — the same reason the
                previous headings were guarded. Nothing is lost on native:
                every row states its own category in its subtitle. */}
            {sections.map((section) => {
              const key = section.category === '' ? 'uncategorised' : section.category;
              const rows = renderRows(section.entries);
              if (Platform.OS !== 'web') return <Fragment key={key}>{rows}</Fragment>;
              return (
                <DropdownMenu.Group key={key}>
                  <DropdownMenu.Label className="text-xs text-muted-foreground font-normal px-2.5">
                    {categoryLabel(section.category, t)}
                  </DropdownMenu.Label>
                  {rows}
                </DropdownMenu.Group>
              );
            })}
            {legacy.length > 0 && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger key="legacy-models">
                    <DropdownMenu.ItemTitle>{t('models.legacyModels')}</DropdownMenu.ItemTitle>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent className="w-96">
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
