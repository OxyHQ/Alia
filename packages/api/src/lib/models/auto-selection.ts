/**
 * Automatic model selection — pure functions over the catalogue and usage.
 *
 * Nothing here is a list somebody maintains (ADR 0012). Which models are
 * featured, which one a person starts on, which one writes titles and which
 * one speaks are all DERIVED from two inputs:
 *
 *  - the catalogue Oxy serves (`lib/models/catalogue.ts`): capabilities,
 *    release dates and prices, as the providers publish them;
 *  - what Alia's own users actually ran (`chat_analytics.model`).
 *
 * Every function is deterministic for its inputs (ties break on the id), so a
 * test can pin the rule rather than today's catalogue.
 */

import { isChatUsable, isSpeechCapable, type CatalogueModel } from './catalogue.js';

/** Turns run on one model over the usage window. */
export interface ModelUsage {
  readonly modelId: string;
  readonly turns: number;
}

/** How many models the picker's initial view features. */
export const FEATURED_LIMIT = 12;

/** The context a utility model needs to summarise a conversation. */
export const UTILITY_MIN_CONTEXT = 32_000;

/**
 * A blended per-million price, or `Infinity` when unpriced.
 *
 * Input and output summed: the ordering only has to be stable and monotone in
 * both prices, and an unpriced model is never the "cheapest".
 */
export function blendedPrice(model: CatalogueModel): number {
  if (model.pricing === null) return Number.POSITIVE_INFINITY;
  const total = Number(model.pricing.inputPerMTok) + Number(model.pricing.outputPerMTok);
  return Number.isFinite(total) ? total : Number.POSITIVE_INFINITY;
}

function byPriceThenId(a: CatalogueModel, b: CatalogueModel): number {
  const delta = blendedPrice(a) - blendedPrice(b);
  if (delta !== 0 && !Number.isNaN(delta)) return delta < 0 ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/** Newest first; an undated model sorts after every dated one. */
function byReleaseDesc(a: CatalogueModel, b: CatalogueModel): number {
  const ta = a.releasedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(a.releasedAt) || Number.NEGATIVE_INFINITY;
  const tb = b.releasedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(b.releasedAt) || Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.id.localeCompare(b.id);
}

function usageMap(usage: readonly ModelUsage[]): Map<string, number> {
  const turns = new Map<string, number>();
  for (const row of usage) turns.set(row.modelId, (turns.get(row.modelId) ?? 0) + row.turns);
  return turns;
}

/**
 * The featured models: per publisher, its newest chat-usable model; publishers
 * ranked by how much Alia's users ran ANY of their models.
 *
 * Ranked by publisher usage rather than by the featured model's own usage,
 * because a model released yesterday has no usage yet and must still lead its
 * publisher's slot. Ties (a cold start) fall back to recency, then id.
 */
export function selectFeatured(
  models: readonly CatalogueModel[],
  usage: readonly ModelUsage[],
  limit: number = FEATURED_LIMIT,
): string[] {
  const turns = usageMap(usage);
  const newestByPublisher = new Map<string, CatalogueModel>();
  const publisherTurns = new Map<string, number>();

  for (const model of models) {
    if (!isChatUsable(model)) continue;
    const publisher = model.publisher.id;
    publisherTurns.set(publisher, (publisherTurns.get(publisher) ?? 0) + (turns.get(model.id) ?? 0));
    const current = newestByPublisher.get(publisher);
    if (current === undefined || byReleaseDesc(model, current) < 0) newestByPublisher.set(publisher, model);
  }

  return [...newestByPublisher.values()]
    .sort((a, b) => {
      const delta = (publisherTurns.get(b.publisher.id) ?? 0) - (publisherTurns.get(a.publisher.id) ?? 0);
      return delta !== 0 ? delta : byReleaseDesc(a, b);
    })
    .slice(0, Math.max(0, limit))
    .map((model) => model.id);
}

/**
 * The model a turn runs on when the request names none.
 *
 *  1. the person's own last-used model, while it is still chat-usable;
 *  2. else the featured model Alia's users ran most;
 *  3. else (a cold start with no usage) the cheapest featured model;
 *  4. else the cheapest chat-usable model at all.
 *
 * `null` only when the catalogue offers nothing a chat can run on.
 */
export function selectDefaultModelId(input: {
  readonly models: readonly CatalogueModel[];
  readonly featuredIds: readonly string[];
  readonly usage: readonly ModelUsage[];
  readonly lastUsedModelId?: string | null;
}): string | null {
  const chat = input.models.filter(isChatUsable);
  const byId = new Map(chat.map((model) => [model.id, model]));
  if (input.lastUsedModelId != null && byId.has(input.lastUsedModelId)) return input.lastUsedModelId;

  const featured = input.featuredIds.flatMap((id) => {
    const model = byId.get(id);
    return model === undefined ? [] : [model];
  });
  const turns = usageMap(input.usage);
  const mostUsed = featured
    .filter((model) => (turns.get(model.id) ?? 0) > 0)
    .sort((a, b) => (turns.get(b.id) ?? 0) - (turns.get(a.id) ?? 0) || a.id.localeCompare(b.id))[0];
  if (mostUsed !== undefined) return mostUsed.id;

  const cheapestFeatured = [...featured].sort(byPriceThenId)[0];
  if (cheapestFeatured !== undefined) return cheapestFeatured.id;

  return [...chat].sort(byPriceThenId)[0]?.id ?? null;
}

/**
 * The model for Alia's own background calls — titles, summaries, compaction,
 * suggestions, planning, verification: the cheapest chat-usable model with at
 * least {@link UTILITY_MIN_CONTEXT} tokens of context. A model whose context
 * Oxy does not report is only used when no model reports one.
 */
export function selectUtilityModelId(models: readonly CatalogueModel[]): string | null {
  const chat = models.filter(isChatUsable);
  const roomy = chat.filter((model) => (model.contextWindow ?? 0) >= UTILITY_MIN_CONTEXT);
  const pool = roomy.length > 0 ? roomy : chat.filter((model) => model.contextWindow === null);
  return [...pool].sort(byPriceThenId)[0]?.id ?? null;
}

/** The cheapest model that produces audio, for spoken answers. */
export function selectSpeechModelId(models: readonly CatalogueModel[]): string | null {
  return [...models.filter(isSpeechCapable)].sort(byPriceThenId)[0]?.id ?? null;
}
