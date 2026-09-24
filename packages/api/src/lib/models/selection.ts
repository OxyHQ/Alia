/**
 * The live side of automatic selection: the pure rules of
 * `auto-selection.ts`, fed by Oxy's catalogue and Alia's own usage.
 *
 * - Featured models are recomputed at most once a day (usage over the last
 *   30 days moves slowly) and always re-filtered against the CURRENT catalogue,
 *   so a model a provider retired never stays featured for the rest of the day.
 * - Utility and speech models follow the catalogue cache directly.
 * - A person's default reads their own most recent turn.
 *
 * Usage reads fail OPEN: without analytics the rules fall back to the cold
 * start (cheapest featured model), never to "no model".
 */

import { getDb } from '../../db/index.js';
import {
  aggregateModelTurnsSince,
  findLastUsedModel,
} from '../../db/usage/chatAnalyticsRepository.js';
import { log } from '../logger.js';
import {
  selectDefaultModelId,
  selectFeatured,
  selectSpeechModelId,
  selectUtilityModelId,
  type ModelUsage,
} from './auto-selection.js';
import { listCatalogueModels, listChatModels } from './catalogue.js';

/** Featured and usage ranking are recomputed daily. */
export const FEATURED_TTL_MS = 24 * 60 * 60 * 1000;
/** The usage window that ranks featured models. */
export const USAGE_WINDOW_DAYS = 30;

/** No model in the catalogue can serve the requested kind of call. */
export class NoModelAvailableError extends Error {
  constructor(readonly purpose: 'chat' | 'utility' | 'speech') {
    super(`No ${purpose} model is available in the catalogue`);
    this.name = 'NoModelAvailableError';
  }
}

let usageCache: { readonly usage: ModelUsage[]; readonly featured: string[]; readonly at: number } | null = null;

async function readUsage(): Promise<ModelUsage[]> {
  try {
    const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return await aggregateModelTurnsSince(getDb(), since);
  } catch (error) {
    log.models.warn({ err: error }, 'Model usage unavailable; ranking falls back to a cold start');
    return [];
  }
}

async function usageAndFeatured(): Promise<{ usage: ModelUsage[]; featured: string[] }> {
  const models = await listChatModels();
  const current = new Set(models.map((model) => model.id));
  if (usageCache === null || Date.now() - usageCache.at >= FEATURED_TTL_MS) {
    const usage = await readUsage();
    usageCache = { usage, featured: selectFeatured(models, usage), at: Date.now() };
  }
  let featured = usageCache.featured.filter((id) => current.has(id));
  // The catalogue changed under the daily cache enough to empty it: recompute
  // from the ranking we already hold rather than wait a day.
  if (featured.length === 0 && models.length > 0) {
    featured = selectFeatured(models, usageCache.usage);
  }
  return { usage: usageCache.usage, featured };
}

/** The featured model ids, in picker order. */
export async function getFeaturedModelIds(): Promise<string[]> {
  return (await usageAndFeatured()).featured;
}

async function lastUsedModelOf(oxyUserId: string): Promise<string | null> {
  try {
    return await findLastUsedModel(getDb(), oxyUserId);
  } catch (error) {
    log.models.warn({ err: error }, 'Last-used model unavailable');
    return null;
  }
}

/**
 * The model a request that names none runs on, for this person (or for an
 * anonymous caller when `oxyUserId` is null).
 */
export async function getDefaultModelId(oxyUserId: string | null | undefined): Promise<string> {
  const [models, { usage, featured }, lastUsed] = await Promise.all([
    listChatModels(),
    usageAndFeatured(),
    oxyUserId ? lastUsedModelOf(oxyUserId) : Promise.resolve(null),
  ]);
  const id = selectDefaultModelId({ models, featuredIds: featured, usage, lastUsedModelId: lastUsed });
  if (id === null) throw new NoModelAvailableError('chat');
  return id;
}

/** The model for Alia's own background calls (titles, summaries, planning…). */
export async function getUtilityModelId(): Promise<string> {
  const id = selectUtilityModelId(await listChatModels());
  if (id === null) throw new NoModelAvailableError('utility');
  return id;
}

/** The model for spoken answers. */
export async function getSpeechModelId(): Promise<string> {
  const id = selectSpeechModelId(await listCatalogueModels());
  if (id === null) throw new NoModelAvailableError('speech');
  return id;
}

/** Test seam. */
export function resetModelSelectionCache(): void {
  usageCache = null;
}
