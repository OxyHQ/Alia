/**
 * How hard a model may think — the effort axis.
 *
 * ## Product-side on purpose
 *
 * The four levels are PRODUCT vocabulary: they are what a person picks, they
 * are published on `GET /catalogue`, and they outlive whichever service ends up
 * resolving a route. The per-model payloads sit beside them rather than in
 * `internal/providers/` because ADR 0001 moves that tree to Kaana and gate 1 of
 * `__tests__/architectureGates.test.ts` only ever lets product imports of it
 * SHRINK — an effort axis rooted there would have been eight new lines on a
 * list whose whole direction of travel is down.
 *
 * Nothing here imports the provider tree. The check that this table describes
 * routes that really exist is made in the test, against the routing table read
 * through `lib/gateway-client.ts`, which is the seam that already owns that
 * question.
 *
 * ## Why this file exists at all
 *
 * Reasoning used to be a BOOLEAN (`thinkingMode`) whose only live effect
 * anywhere was a paragraph in the system prompt. The two provider hooks that
 * were supposed to carry it — `experimental_thinking` and
 * `experimental_providerMetadata` in `lib/chat/model-config.ts` — are AI SDK
 * **v4** option names, this service runs `ai@6`, and neither string occurs
 * anywhere in the installed package. `baseConfig` was typed `any` with an
 * eslint-disable, so `tsc` had nothing to say. The flag reached no provider,
 * in any of the nineteen, for the whole life of the v6 migration.
 *
 * A four-level control on top of that would have been an interface promising a
 * reasoning budget nobody transmits. So the levels and the payloads are defined
 * together, here, and the rule the rest of the code enforces is that a level is
 * OFFERED only where it can be SENT.
 *
 * ## Authored per model, never parsed from an id
 *
 * Keyed by `publisher/model` — the identity, not the deployment id — for the
 * same reason `model-publishers.ts` is authored: an id does not say whether a
 * model reasons. `deepseek-chat` and `deepseek-reasoner` differ by one word,
 * `o1` carries no token at all, and `gemini-2.5-flash` reasons while
 * `gemini-2.5-flash-preview-tts` is a speech model. There is no parse that
 * answers this, only knowledge.
 *
 * `capabilitiesThinking` in `db/schema/providers.ts` is not that knowledge: it
 * is a column nothing outside `db/providers/modelConfigRepository.ts` reads,
 * and a boolean cannot say which LEVELS a model offers.
 *
 * ## Only three provider clients can carry a reasoning option
 *
 * `chat-core.ts` `getAIModel` builds a first-party client for exactly
 * `google`, `openai` and `anthropic`; every other provider is `createOpenAI`
 * pointed at a different `baseURL`. An OpenAI-compatible endpoint accepts the
 * OpenAI request SHAPE, which is not a promise that it honours
 * `reasoning_effort` — and a parameter accepted and ignored is precisely the
 * failure this file replaces, wearing a different key.
 *
 * So a route carries reasoning only when its provider is one of those three
 * AND is also the model's publisher. Both halves are checked rather than
 * assumed: `__tests__/reasoning-effort-table.test.ts` asserts the mapping table never
 * serves a foreign publisher over a first-party client, so the day someone adds
 * `createMapping('openai', 'meta', …)` that test fails instead of this file
 * quietly sending Meta a key OpenAI defined.
 *
 * The cost of that strictness is real and is stated rather than hidden: the
 * `gpt-5*` and `claude-*-4.6` families reach users only through DigitalOcean
 * today, so they carry no reasoning option and offer no levels. Widening it is
 * a KEY question (first-party OpenAI/Anthropic credentials for those models),
 * not a code question.
 */

/**
 * What a person picks on the effort control.
 *
 * Four levels, ordered cheapest to dearest, and the product's own words rather
 * than any provider's: `instant` is not OpenAI's `minimal` and `max` is not
 * Anthropic's ceiling. The translation is per model, below, and every offered
 * level maps to a DISTINCT payload — a level that sent what its neighbour sends
 * would be a label with no behaviour behind it.
 */
export const EFFORT_LEVELS = ['instant', 'medium', 'high', 'max'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

/** Is this string one of the four levels? */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && EFFORT_LEVEL_SET.has(value);
}

/**
 * The object handed to `providerOptions[<publisher>]` for one level.
 *
 * `unknown` values rather than a union of the three provider shapes: this
 * module's contract is that the SHAPE matches whatever the installed provider
 * package parses, and that is asserted against the package on disk in
 * `__tests__/reasoning-effort-table.test.ts` instead of restated as a type here, where
 * it would be a second copy of the SDK's schema free to drift from it.
 */
export type ReasoningPayload = Readonly<Record<string, unknown>>;

interface LevelSpec {
  /** What goes under `providerOptions[<publisher>]` for this level. */
  readonly payload: ReasoningPayload;
  /**
   * Room left for the ANSWER at this level — not the total output allowance.
   *
   * The distinction is not cosmetic and was found by reading the bytes the
   * provider POSTs: `@ai-sdk/anthropic` computes
   * `max_tokens = maxOutputTokens + budget_tokens`, so whatever is set here has
   * the thinking budget ADDED to it. Passing the model's full 8192 ceiling
   * therefore asks for 14336 on a model that caps at 8192, which Anthropic
   * refuses outright — the feature would 400 at exactly the level a person
   * chose it for.
   *
   * So each level declares the remainder: `ceiling - budget`, which lands the
   * provider's sum exactly on the ceiling. Present only where a provider
   * imposes that relationship; Gemini's budget is independent of its output
   * allowance and declares nothing.
   */
  readonly maxOutputTokens?: number;
}

interface ModelReasoning {
  /**
   * The levels this model offers, and exactly what each one sends.
   *
   * Partial on purpose. A model that cannot be told to stop thinking offers no
   * `instant`, and one that offers no gradation offers no `max`. Painting a
   * level a model does not have is the whole failure mode this file exists to
   * prevent, so absence is expressible and is the default.
   */
  readonly levels: Readonly<Partial<Record<EffortLevel, LevelSpec>>>;
}

/**
 * Anthropic's total output allowance, thinking and answer together.
 *
 * `model-capabilities-data.ts` records `maxOutputTokens: 8192` for both
 * anthropic-published models in the routing table, and thinking tokens are
 * billed and counted as OUTPUT tokens, so the budget and the answer share this
 * one allowance. `max` therefore stops at 6144 rather than 8192: it has to
 * leave room to answer with.
 */
const ANTHROPIC_OUTPUT_CEILING = 8192;

/**
 * The three budgets, shared by Anthropic and Gemini 2.5 so the levels mean the
 * same amount of thinking wherever they are honoured.
 *
 * 2048 is above Anthropic's documented 1024 minimum with room to spare; the
 * others double and treble it. Against 8192 output tokens, `max` spends three
 * quarters of the allowance thinking and leaves a quarter to answer with, which
 * is the point at which raising it further starts truncating replies rather
 * than improving them.
 */
const BUDGET_MEDIUM = 2048;
const BUDGET_HIGH = 4096;
const BUDGET_MAX = 6144;

/**
 * The most reasoning tokens any single level can buy.
 *
 * Read by `lib/credits-manager.ts` to state the worst case a level can cost,
 * and asserted against the table below rather than typed twice.
 */
export const MAX_REASONING_BUDGET_TOKENS = BUDGET_MAX;

/** Enabled thinking, plus the answer room the provider will add the budget to. */
function anthropicThinking(budgetTokens: number): LevelSpec {
  return {
    payload: { thinking: { type: 'enabled', budgetTokens } },
    maxOutputTokens: ANTHROPIC_OUTPUT_CEILING - budgetTokens,
  };
}

function geminiBudget(thinkingBudget: number): LevelSpec {
  // `includeThoughts` asks for the summary of the thinking, which is what makes
  // the spend visible to the person who asked for it. It rides with a budget
  // and never alone: the branch that used to set it unconditionally asked every
  // Gemini request for thought summaries whether or not reasoning was wanted.
  return { payload: { thinkingConfig: { thinkingBudget, includeThoughts: true } } };
}

function geminiLevel(thinkingLevel: string): LevelSpec {
  return { payload: { thinkingConfig: { thinkingLevel, includeThoughts: true } } };
}

function openAIEffort(reasoningEffort: string): LevelSpec {
  return { payload: { reasoningEffort } };
}

/**
 * Which models reason, at which levels, and what each level sends.
 *
 * Keyed `publisher/model`. Every key here must also appear as a
 * `createMapping(<provider>, <publisher>, <model>, …)` row whose provider is
 * first-party for that publisher, or the entry describes a route that does not
 * exist — `__tests__/reasoning-effort-table.test.ts` fails on an entry no mapping can
 * reach, which is the direction that would otherwise offer a level silently
 * served by nobody.
 */
const MODEL_REASONING: Readonly<Record<string, ModelReasoning>> = {
  /**
   * Anthropic extended thinking: an explicit budget, or an explicit refusal.
   *
   * All four levels, because `{type: 'disabled'}` is a real instruction rather
   * than an omission — Claude 4.6 and newer may otherwise think adaptively, so
   * "instant" has to SAY not to rather than stay quiet and hope.
   */
  'anthropic/claude-sonnet-4': {
    levels: {
      instant: { payload: { thinking: { type: 'disabled' } } },
      medium: anthropicThinking(BUDGET_MEDIUM),
      high: anthropicThinking(BUDGET_HIGH),
      max: anthropicThinking(BUDGET_MAX),
    },
  },
  'anthropic/claude-opus-4': {
    levels: {
      instant: { payload: { thinking: { type: 'disabled' } } },
      medium: anthropicThinking(BUDGET_MEDIUM),
      high: anthropicThinking(BUDGET_HIGH),
      max: anthropicThinking(BUDGET_MAX),
    },
  },

  /**
   * Gemini 2.5: a numeric budget, and only Flash can be told to spend nothing.
   *
   * Pro's budget has a floor above zero, so it offers no `instant` — three
   * levels rather than a fourth that would round down to "the least thinking it
   * will do anyway" and read to a person as "off".
   */
  'google/gemini-2.5-flash': {
    levels: {
      instant: geminiBudget(0),
      medium: geminiBudget(BUDGET_MEDIUM),
      high: geminiBudget(BUDGET_HIGH),
      max: geminiBudget(BUDGET_MAX),
    },
  },
  'google/gemini-2.5-pro': {
    levels: {
      medium: geminiBudget(BUDGET_MEDIUM),
      high: geminiBudget(BUDGET_HIGH),
      max: geminiBudget(BUDGET_MAX),
    },
  },

  /**
   * Gemini 3: a LEVEL, not a budget.
   *
   * The installed provider carries both `thinkingBudget` and `thinkingLevel`,
   * with the Gemini 3 documentation cited beside the second — so these send the
   * level. Using the budget here would be sending Gemini 2.5's parameter to a
   * Gemini 3 model because both happen to typecheck.
   */
  'google/gemini-3-flash-preview': {
    levels: {
      instant: geminiLevel('minimal'),
      medium: geminiLevel('low'),
      high: geminiLevel('medium'),
      max: geminiLevel('high'),
    },
  },
  'google/gemini-3-pro-preview': {
    levels: {
      instant: geminiLevel('minimal'),
      medium: geminiLevel('low'),
      high: geminiLevel('medium'),
      max: geminiLevel('high'),
    },
  },

  /**
   * o1 reasons or it does not answer — there is no "off", so no `instant`.
   *
   * Three of the seven values the installed provider's enum accepts. The other
   * four (`none`, `minimal`, `xhigh`, `max`) are newer-model values this one
   * predates, and sending a value the enum permits but the model refuses is a
   * 400 dressed as a feature.
   */
  'openai/o1': {
    levels: {
      medium: openAIEffort('low'),
      high: openAIEffort('medium'),
      max: openAIEffort('high'),
    },
  },
};

/**
 * The providers whose client reads a reasoning option, and the publisher each
 * one is first-party for.
 *
 * Derived from `lib/chat-core.ts` `getAIModel`, which builds
 * `createGoogleGenerativeAI`, `createOpenAI` and `createAnthropic` for exactly
 * these three and reaches every other provider through `createOpenAI` with a
 * foreign `baseURL`.
 */
const FIRST_PARTY_CLIENTS: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  google: 'google',
  openai: 'openai',
};

/** The `publisher/model` identity, which is the key this table is written in. */
export function reasoningKey(publisher: string, model: string): string {
  return `${publisher}/${model}`;
}

/**
 * The levels a single ROUTE can honour — a route being one
 * `{provider, publisher, model}` row of the mapping table.
 *
 * Empty for every route that cannot carry the option, which is most of them,
 * and that emptiness is what stops a level being offered for an entry whose
 * fallback could land somewhere it means nothing.
 */
export function reasoningLevelsFor(
  provider: string,
  publisher: string,
  model: string,
): readonly EffortLevel[] {
  const entry = lookup(provider, publisher, model);
  if (!entry) return [];
  return EFFORT_LEVELS.filter((level) => entry.levels[level] !== undefined);
}

/**
 * What one route sends for one level, or `null` when it can send nothing.
 *
 * `null` rather than an empty object, so the caller writes NO `providerOptions`
 * key at all instead of an empty one — an empty `{anthropic: {}}` is a
 * different request from the one that omits it, and it is the request nobody
 * asked for.
 */
export function reasoningPayloadFor(
  provider: string,
  publisher: string,
  model: string,
  level: EffortLevel,
): { readonly providerKey: string; readonly payload: ReasoningPayload; readonly maxOutputTokens: number | null } | null {
  const spec = lookup(provider, publisher, model)?.levels[level];
  if (!spec) return null;
  return {
    providerKey: provider,
    payload: spec.payload,
    maxOutputTokens: spec.maxOutputTokens ?? null,
  };
}

/**
 * The one read of both tables, and the one place they are guarded.
 *
 * `Object.hasOwn` rather than a truthiness check, on both: `provider`,
 * `publisher` and `model` are open strings that arrive from a routing table
 * this module does not own, and an object literal answers `constructor`,
 * `__proto__`, `toString`, `valueOf` and `hasOwnProperty` with inherited values
 * its author never wrote. `FIRST_PARTY_CLIENTS['constructor']` would return a
 * FUNCTION, which is not `undefined` and therefore survives every `??` and `!x`
 * guard — the shape `__tests__/prototype-keyed-lookups.test.ts` exists to
 * refuse. `levels[level]` needs no guard because `EffortLevel` is a closed
 * union the compiler constrains, and `isEffortLevel` is what narrows a request
 * string into it.
 */
function lookup(provider: string, publisher: string, model: string): ModelReasoning | null {
  if (!Object.hasOwn(FIRST_PARTY_CLIENTS, provider)) return null;
  if (FIRST_PARTY_CLIENTS[provider] !== publisher) return null;
  const key = reasoningKey(publisher, model);
  if (!Object.hasOwn(MODEL_REASONING, key)) return null;
  return MODEL_REASONING[key];
}

/** Every identity this table describes, for the tests that check it against the routing table. */
export function reasoningKeys(): readonly string[] {
  return Object.keys(MODEL_REASONING);
}
