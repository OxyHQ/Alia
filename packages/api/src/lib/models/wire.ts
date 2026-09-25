/**
 * The catalogue's wire shapes — `GET /catalogue` (Alia's own) and
 * `GET /v1/models` (OpenAI-compatible) — built from one list.
 */

import type { CatalogueModel, ReasoningEffort } from './catalogue.js';

export interface CatalogueEntryWire {
  readonly id: string;
  readonly object: 'model';
  readonly name: string;
  readonly publisher: { readonly id: string; readonly name: string };
  readonly description: string | null;
  readonly contextWindow: number | null;
  readonly maxOutput: number | null;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly tools: boolean;
  readonly reasoningEfforts: readonly ReasoningEffort[];
  /** USD per million tokens, as decimal strings; null when Oxy lists no token price. */
  readonly pricing: { readonly inputPerMTok: string; readonly outputPerMTok: string } | null;
  readonly releasedAt: string | null;
  readonly featured: boolean;
}

export interface CatalogueResponseWire {
  readonly object: 'list';
  readonly data: readonly CatalogueEntryWire[];
  /** The model a request that names none runs on, for this caller. */
  readonly defaultModelId: string | null;
  /** Featured model ids, in picker order. */
  readonly featuredIds: readonly string[];
}

export function toCatalogueEntry(model: CatalogueModel, featured: ReadonlySet<string>): CatalogueEntryWire {
  return {
    id: model.id,
    object: 'model',
    name: model.name,
    publisher: { id: model.publisher.id, name: model.publisher.name },
    description: model.description,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    tools: model.tools,
    reasoningEfforts: model.reasoningEfforts,
    pricing: model.pricing,
    releasedAt: model.releasedAt,
    featured: featured.has(model.id),
  };
}

/**
 * The whole `/catalogue` response. Featured models first (in picker order),
 * then the rest by publisher and name, so a client can render it as it comes.
 */
export function toCatalogueResponse(
  models: readonly CatalogueModel[],
  featuredIds: readonly string[],
  defaultModelId: string | null,
): CatalogueResponseWire {
  const present = new Set(models.map((model) => model.id));
  const featuredOrder = featuredIds.filter((id) => present.has(id));
  const featured = new Set(featuredOrder);
  const rank = new Map(featuredOrder.map((id, index) => [id, index]));
  const sorted = [...models].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined || rb !== undefined) return (ra ?? Number.MAX_SAFE_INTEGER) - (rb ?? Number.MAX_SAFE_INTEGER);
    return a.publisher.name.localeCompare(b.publisher.name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
  return {
    object: 'list',
    data: sorted.map((model) => toCatalogueEntry(model, featured)),
    defaultModelId: defaultModelId !== null && present.has(defaultModelId) ? defaultModelId : null,
    featuredIds: featuredOrder,
  };
}

/** One entry of `GET /v1/models`, in OpenAI's shape. */
export interface OpenAIModelWire {
  readonly id: string;
  readonly object: 'model';
  /** Unix seconds of the release date, or 0 when unknown. */
  readonly created: number;
  readonly owned_by: string;
}

export function toOpenAIModel(model: CatalogueModel): OpenAIModelWire {
  const released = model.releasedAt === null ? Number.NaN : Date.parse(model.releasedAt);
  return {
    id: model.id,
    object: 'model',
    created: Number.isFinite(released) ? Math.floor(released / 1000) : 0,
    owned_by: model.publisher.id,
  };
}
