/**
 * The models a workflow node may ask for (`GET /catalogue`).
 *
 * Alia has no models of its own: the catalogue lists real models, each
 * identified as `publisher/model`, and names the one the server uses when a
 * request carries no `model` (`defaultModelId`). Nothing here names a model —
 * every row the picker offers comes from that response.
 *
 * A node that has no explicit choice stores NO `model` at all, and the server
 * answers it with its own default. Workflows saved before real models carried
 * product-mode or routing-profile identifiers; those are not `publisher/model`
 * ids, so {@link storedModelId} reads them as "no choice" (the server migration
 * rewrites them too, this is the defensive half).
 */

import { useQuery } from '@tanstack/react-query';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4150';

/**
 * The picker value standing for "no explicit choice".
 *
 * A Radix `Select.Item` cannot hold the empty string, so the default row needs a
 * value of its own. It is never stored: choosing it removes `model` from the node.
 */
export const DEFAULT_MODEL = 'default';

export interface CatalogueModel {
  readonly id: string;
  readonly name: string;
  readonly publisher: { readonly id: string; readonly name: string };
  readonly description: string | null;
  readonly contextWindow: number | null;
  readonly featured: boolean;
}

export interface Catalogue {
  readonly models: readonly CatalogueModel[];
  /** What the server answers a request that names no model with; `null` if it did not say. */
  readonly defaultModelId: string | null;
  readonly featuredIds: readonly string[];
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Whether a value has the shape of a catalogue id: `publisher/model`. */
export function isModelId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1 && value.trim() === value && !/\s/.test(value);
}

/**
 * Turn a catalogue response into models, or throw.
 *
 * Throwing beats returning an empty list: "the product offers nothing" and "we
 * could not read the answer" must not look the same. A single malformed entry is
 * dropped; a response whose entries ALL fail to parse is unreadable.
 */
export function parseCatalogue(payload: unknown): Catalogue {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (body === null || !Array.isArray(data)) throw new Error('The model catalogue response could not be read.');

  const models: CatalogueModel[] = [];
  for (const value of data) {
    const raw = asObject(value);
    if (raw === null || raw.object !== 'model') continue;
    const id = asText(raw.id);
    const name = asText(raw.name);
    const publisher = asObject(raw.publisher);
    const publisherId = publisher === null ? null : asText(publisher.id);
    const publisherName = publisher === null ? null : asText(publisher.name);
    if (!isModelId(id) || name === null || publisherId === null || publisherName === null) continue;
    models.push({
      id,
      name,
      publisher: { id: publisherId, name: publisherName },
      description: asText(raw.description),
      contextWindow: asCount(raw.contextWindow),
      featured: raw.featured === true,
    });
  }
  if (data.length > 0 && models.length === 0) {
    throw new Error('The model catalogue response could not be read.');
  }

  const defaultModelId = isModelId(body.defaultModelId) ? body.defaultModelId : null;
  const featuredIds = Array.isArray(body.featuredIds) ? body.featuredIds.filter(isModelId) : [];
  return { models, defaultModelId, featuredIds };
}

export interface ModelGroup {
  /** `null` for the featured group, otherwise the publisher's name. */
  readonly label: string | null;
  readonly key: string;
  readonly models: readonly CatalogueModel[];
}

/**
 * The picker's rows: featured models first (in the catalogue's `featuredIds`
 * order, else its own order), then every other model grouped by publisher,
 * publishers alphabetically. A featured model is not repeated in its publisher.
 */
export function groupModels(catalogue: Catalogue): ModelGroup[] {
  const byId = new Map(catalogue.models.map((model) => [model.id, model]));
  const featuredOrder =
    catalogue.featuredIds.length > 0
      ? catalogue.featuredIds
      : catalogue.models.filter((model) => model.featured).map((model) => model.id);
  const featured: CatalogueModel[] = [];
  const featuredSet = new Set<string>();
  for (const id of featuredOrder) {
    const model = byId.get(id);
    if (model === undefined || featuredSet.has(id)) continue;
    featured.push(model);
    featuredSet.add(id);
  }

  const publishers = new Map<string, { name: string; models: CatalogueModel[] }>();
  for (const model of catalogue.models) {
    if (featuredSet.has(model.id)) continue;
    const group = publishers.get(model.publisher.id) ?? { name: model.publisher.name, models: [] };
    group.models.push(model);
    publishers.set(model.publisher.id, group);
  }

  const groups: ModelGroup[] = [];
  if (featured.length > 0) groups.push({ label: null, key: 'featured', models: featured });
  const sorted = [...publishers.entries()].sort(([, a], [, b]) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  for (const [id, group] of sorted) groups.push({ label: group.name, key: id, models: group.models });
  return groups;
}

/**
 * The model a node explicitly asks for, or `undefined` for the server default.
 *
 * Anything that is not a `publisher/model` id — an empty string, or a retired
 * product-mode or routing-profile identifier from an older workflow — is no
 * choice at all.
 */
export function storedModelId(value: unknown): string | undefined {
  return isModelId(value) ? value : undefined;
}

/** Compact context-window size, e.g. `200K`, `1M`. */
export function formatContextWindow(tokens: number | null): string | null {
  if (tokens === null) return null;
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/**
 * The words for what a node is set to: the model's name, "Default (<name>)"
 * when the node names none, or `null` while the catalogue has not loaded.
 * A stored id the catalogue no longer lists is shown as the id itself — it is a
 * real model id, and hiding it would hide a choice the node still carries.
 */
export function labelForNode(modelId: unknown, catalogue: Catalogue | undefined): string | null {
  const id = storedModelId(modelId);
  if (catalogue === undefined) return id ?? null;
  if (id === undefined) return defaultLabel(catalogue);
  return catalogue.models.find((model) => model.id === id)?.name ?? id;
}

/** "Default" plus, when the server said which, the default model's name. */
export function defaultLabel(catalogue: Catalogue | undefined): string {
  const id = catalogue?.defaultModelId ?? null;
  if (id === null) return 'Default';
  const name = catalogue?.models.find((model) => model.id === id)?.name ?? id;
  return `Default (${name})`;
}

/**
 * The catalogue, unauthenticated: `GET /catalogue` is `optionalAuth`, and this
 * app shows the same list to everybody.
 */
export function useCatalogue() {
  return useQuery<Catalogue>({
    queryKey: ['catalogue'],
    queryFn: async () => {
      const response = await fetch(`${API_URL}/catalogue`);
      if (!response.ok) throw new Error(`The model catalogue request failed (${response.status}).`);
      return parseCatalogue(await response.json());
    },
    staleTime: 1000 * 60 * 60,
    retry: 2,
  });
}

/**
 * Nodes with every retired or malformed `model` removed, so a workflow saved
 * before real models reads — and is sent back — as asking for the server default.
 */
export function withStoredModels<T extends { data: { model?: string } }>(nodes: readonly T[]): T[] {
  return nodes.map((node) => {
    if (node.data.model === undefined || storedModelId(node.data.model) !== undefined) return node;
    const data = { ...node.data };
    delete data.model;
    return { ...node, data };
  });
}
