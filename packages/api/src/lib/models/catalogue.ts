/**
 * The model catalogue Alia offers: whatever Oxy lists, nothing curated here.
 *
 * Alia has no models of its own (ADR 0012). Every model a person can pick is a
 * `publisher/model` entry of Oxy's catalogue — `OxyInferenceClient.listModels()`,
 * which Kaana keeps in sync with what its providers actually serve — so a model
 * a provider retires disappears here without a deploy. This module only
 * NORMALIZES those entries into the shape the product needs and caches them.
 *
 * Nothing in this file names a model, a publisher or a price. The filters are
 * capability filters (text in → text out, tools), never lists.
 *
 * The serving operator (`servingProviders`) and deployment ids are never read:
 * the product shows the model and its publisher, not who hosts it.
 */

import { getOxyInferenceClient } from '../inference/oxy-inference.js';
import { log } from '../logger.js';

/** The effort levels a request may ask a reasoning model for. */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** USD per million tokens, as exact decimal strings. */
export interface ModelPricing {
  readonly inputPerMTok: string;
  readonly outputPerMTok: string;
}

/** One model, normalized from an Oxy catalogue entry. */
export interface CatalogueModel {
  /** `publisher/model` — what a client sends as `model`. */
  readonly id: string;
  readonly name: string;
  readonly publisher: { readonly id: string; readonly name: string };
  readonly description: string | null;
  readonly contextWindow: number | null;
  readonly maxOutput: number | null;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly tools: boolean;
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly pricing: ModelPricing | null;
  /** ISO date the publisher released it, when Oxy knows. */
  readonly releasedAt: string | null;
}

/** How long a fetched catalogue is served before Oxy is asked again. */
export const CATALOGUE_TTL_MS = 5 * 60 * 1000;

const PER_MILLION = 1_000_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * `amount` (a decimal string, per `per` units) scaled to per-million.
 *
 * Exact when the scale is a power of ten — the only scales a price list uses in
 * practice — by moving the decimal point on the digits rather than through a
 * float. Anything else falls back to floating point, which is still far inside
 * the precision a picker shows.
 */
export function scaleToPerMillion(amount: string, per: number): string | null {
  if (!/^\d+(\.\d+)?$/.test(amount) || !Number.isFinite(per) || per <= 0) return null;
  const factor = PER_MILLION / per;
  const exponent = Math.log10(factor);
  if (Number.isInteger(exponent)) {
    const [whole, fraction = ''] = amount.split('.');
    let digits = whole + fraction;
    let point = whole.length + exponent;
    if (point < 0) {
      digits = '0'.repeat(-point) + digits;
      point = 0;
    }
    if (point > digits.length) digits = digits + '0'.repeat(point - digits.length);
    const intPart = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
    const fracPart = digits.slice(point).replace(/0+$/, '');
    return fracPart === '' ? intPart : `${intPart}.${fracPart}`;
  }
  const scaled = Number(amount) * factor;
  return Number.isFinite(scaled) ? String(Number(scaled.toPrecision(12))) : null;
}

function pricingOf(raw: unknown): ModelPricing | null {
  const pricing = record(raw);
  if (pricing === null || !Array.isArray(pricing.unitPrices)) return null;
  const perMillion = (unit: string): string | null => {
    for (const entry of pricing.unitPrices as unknown[]) {
      const price = record(entry);
      if (price === null || price.unit !== unit) continue;
      if (typeof price.amount !== 'string' || typeof price.per !== 'number') continue;
      return scaleToPerMillion(price.amount, price.per);
    }
    return null;
  };
  const inputPerMTok = perMillion('input_tokens');
  const outputPerMTok = perMillion('output_tokens');
  return inputPerMTok === null || outputPerMTok === null ? null : { inputPerMTok, outputPerMTok };
}

/**
 * The effort levels a model accepts.
 *
 * `@oxy.so/core` 1.7 does not type `reasoningEfforts` yet (it lands in the next
 * core minor), so it is read defensively from the raw entry — top level or
 * under `capabilities`. Until Oxy sends it, a model that declares `reasoning`
 * is taken to accept every level: Kaana translates the level into each
 * provider's own parameter.
 */
function reasoningEffortsOf(entry: Record<string, unknown>, capabilities: Record<string, unknown> | null): ReasoningEffort[] {
  const declared = Array.isArray(entry.reasoningEfforts)
    ? entry.reasoningEfforts
    : Array.isArray(capabilities?.reasoningEfforts)
      ? capabilities.reasoningEfforts
      : null;
  if (declared !== null) return REASONING_EFFORTS.filter((level) => declared.includes(level));
  return capabilities?.reasoning === true ? [...REASONING_EFFORTS] : [];
}

/**
 * One Oxy catalogue entry, or `null` when it cannot be offered at all.
 *
 * Pure and defensive: the client types its answer but does not re-parse it,
 * and a newer Oxy may add or omit optional fields. An entry without a
 * `publisher/model` id, or one Oxy marks retired, is dropped.
 */
export function normalizeCatalogueEntry(raw: unknown): CatalogueModel | null {
  const entry = record(raw);
  if (entry === null) return null;
  const id = text(entry.modelId) ?? text(entry.id);
  if (id === null || !/^[^/\s]+\/[^\s]+$/.test(id)) return null;
  const deprecation = record(entry.deprecation);
  if (deprecation?.status === 'retired') return null;

  const publisherRecord = record(entry.publisher);
  const publisherId = text(publisherRecord?.slug) ?? text(entry.publisher) ?? id.slice(0, id.indexOf('/'));
  const publisherName = text(publisherRecord?.displayName) ?? publisherId;
  const capabilities = record(entry.capabilities);

  return {
    id,
    name: text(entry.displayName) ?? text(entry.name) ?? id.slice(id.indexOf('/') + 1),
    publisher: { id: publisherId, name: publisherName },
    description: text(entry.description),
    contextWindow: positiveInt(capabilities?.maxContextTokens),
    maxOutput: positiveInt(capabilities?.maxOutputTokens),
    inputModalities: stringList(capabilities?.inputModalities),
    outputModalities: stringList(capabilities?.outputModalities),
    tools: capabilities?.tools === true,
    reasoningEfforts: reasoningEffortsOf(entry, capabilities),
    pricing: pricingOf(entry.pricing),
    releasedAt: text(entry.releasedAt) ?? text(entry.releasedOn),
  };
}

/** Text in, text out, and tools: what Alia's chat (a tool loop) can run on. */
export function isChatUsable(model: CatalogueModel): boolean {
  return model.inputModalities.includes('text')
    && model.outputModalities.includes('text')
    && model.tools;
}

/** A model that can speak: audio out. */
export function isSpeechCapable(model: CatalogueModel): boolean {
  return model.outputModalities.includes('audio');
}

/** Normalize a whole listing, keeping the first entry per id. */
export function normalizeCatalogue(entries: readonly unknown[]): CatalogueModel[] {
  const byId = new Map<string, CatalogueModel>();
  for (const raw of entries) {
    const model = normalizeCatalogueEntry(raw);
    if (model !== null && !byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Raised when Oxy cannot be asked for the catalogue at all. */
export class CatalogueUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CatalogueUnavailableError';
  }
}

let cached: { readonly models: CatalogueModel[]; readonly fetchedAt: number } | null = null;
let inflight: Promise<CatalogueModel[]> | null = null;

async function fetchCatalogue(): Promise<CatalogueModel[]> {
  const client = getOxyInferenceClient();
  if (client === null) throw new CatalogueUnavailableError('Oxy inference is not configured for this deployment');
  const entries = await client.listModels({ signal: AbortSignal.timeout(15_000) });
  return normalizeCatalogue(entries as unknown[]);
}

/**
 * Every model Oxy lists for Alia, normalized, cached for {@link CATALOGUE_TTL_MS}.
 *
 * A failed refresh serves the last good catalogue rather than emptying the
 * picker; with nothing cached it throws {@link CatalogueUnavailableError}.
 */
export async function listCatalogueModels(now: number = Date.now()): Promise<CatalogueModel[]> {
  if (cached !== null && now - cached.fetchedAt < CATALOGUE_TTL_MS) return cached.models;
  inflight ??= fetchCatalogue()
    .then((models) => {
      cached = { models, fetchedAt: Date.now() };
      return models;
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return await inflight;
  } catch (error) {
    if (cached !== null) {
      log.models.warn({ err: error }, 'Catalogue refresh failed; serving the last good catalogue');
      return cached.models;
    }
    if (error instanceof CatalogueUnavailableError) throw error;
    throw new CatalogueUnavailableError('The model catalogue could not be loaded', { cause: error });
  }
}

/** The models a chat turn can run on. */
export async function listChatModels(): Promise<CatalogueModel[]> {
  return (await listCatalogueModels()).filter(isChatUsable);
}

/** One model by exact id, from the whole catalogue, or `null`. */
export async function findCatalogueModel(id: string): Promise<CatalogueModel | null> {
  return (await listCatalogueModels()).find((model) => model.id === id) ?? null;
}

/** Test seam: forget the cached catalogue. */
export function resetCatalogueCache(): void {
  cached = null;
  inflight = null;
}
