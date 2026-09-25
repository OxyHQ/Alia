/**
 * The model catalogue, as the CLI consumes it (`GET /catalogue`).
 *
 * Alia owns no models: the catalogue lists the real ones the server can reach,
 * each named `publisher/model`, and says which one it uses when a request names
 * none (`defaultModelId`). The CLI ships NO model identifier of its own. An
 * empty choice means "let the server choose": the request omits `model`.
 *
 * ## Resolution (what a request carries)
 *
 * - Nothing chosen → omit `model` (server default).
 * - A `publisher/model` id the catalogue lists → send it.
 * - Text that uniquely matches one model (`--model sonnet`) → send that id.
 * - Anything else — withdrawn, ambiguous, or a legacy identifier from an older
 *   config file — → omit `model`. The server default is a working turn; a guess
 *   is a failed one.
 * - Catalogue unreadable → send a `publisher/model`-shaped choice as-is (the
 *   server stays the authority), and omit anything else.
 *
 * ## Why this is a copy rather than a shared module
 *
 * `packages/app`, `@alia.onl/sdk` and the VS Code extension parse the same
 * surface. `@alia-codea/cli` is a PUBLISHED package, so it cannot depend on an
 * unpublished workspace package. Parsing does not invent: an entry missing its
 * id or name is dropped, and a response whose entries all fail to parse throws
 * rather than reading as an empty catalogue.
 */

import { config } from './config.js';
import { accessToken } from './oxy-session.js';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface CatalogueModel {
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
  readonly pricing: { readonly inputPerMTok: string; readonly outputPerMTok: string } | null;
  readonly releasedAt: string | null;
  readonly featured: boolean;
}

export interface Catalogue {
  readonly models: readonly CatalogueModel[];
  /** The model the server uses when a request names none, or null if it did not say. */
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

function asTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const EFFORTS: readonly string[] = ['low', 'medium', 'high'];

function parseEntry(value: unknown): CatalogueModel | null {
  const raw = asObject(value);
  if (raw === null) return null;
  if (raw.object !== undefined && raw.object !== 'model') return null;
  const id = asText(raw.id);
  const name = asText(raw.name);
  if (id === null || name === null) return null;

  const publisherRaw = asObject(raw.publisher);
  const publisherId = asText(publisherRaw?.id) ?? id.split('/')[0] ?? id;
  const pricingRaw = asObject(raw.pricing);
  const inputPerMTok = asText(pricingRaw?.inputPerMTok);
  const outputPerMTok = asText(pricingRaw?.outputPerMTok);

  return {
    id,
    name,
    publisher: { id: publisherId, name: asText(publisherRaw?.name) ?? publisherId },
    description: asText(raw.description),
    contextWindow: asCount(raw.contextWindow),
    maxOutput: asCount(raw.maxOutput),
    inputModalities: asTextList(raw.inputModalities),
    outputModalities: asTextList(raw.outputModalities),
    tools: raw.tools === true,
    reasoningEfforts: asTextList(raw.reasoningEfforts).filter((e): e is ReasoningEffort =>
      EFFORTS.includes(e),
    ),
    pricing:
      inputPerMTok !== null && outputPerMTok !== null ? { inputPerMTok, outputPerMTok } : null,
    releasedAt: asText(raw.releasedAt),
    featured: raw.featured === true,
  };
}

/** Turn a `GET /catalogue` body into a catalogue, or throw if it cannot be read. */
export function parseCatalogue(payload: unknown): Catalogue {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (!Array.isArray(data)) throw new Error('The model catalogue response could not be read.');

  const models: CatalogueModel[] = [];
  for (const value of data) {
    const entry = parseEntry(value);
    if (entry !== null) models.push(entry);
  }
  if (data.length > 0 && models.length === 0) {
    throw new Error('The model catalogue response could not be read.');
  }
  return {
    models,
    defaultModelId: asText(body?.defaultModelId),
    featuredIds: asTextList(body?.featuredIds),
  };
}

/** Whether a string has the shape of a catalogue id (`publisher/model`). */
export function looksLikeModelId(value: string): boolean {
  return /^[^\s/]+\/\S+$/.test(value.trim());
}

/**
 * Every model a piece of text could mean: an exact id, else an exact name, else
 * every model whose id, name and publisher together contain all the words.
 */
export function searchModels(text: string, catalogue: Catalogue): CatalogueModel[] {
  const needle = text.trim().toLowerCase();
  if (needle === '') return [];

  const exact = catalogue.models.find((model) => model.id.toLowerCase() === needle);
  if (exact !== undefined) return [exact];

  const byName = catalogue.models.filter((model) => model.name.toLowerCase() === needle);
  if (byName.length > 0) return byName;

  const words = needle.split(/\s+/);
  return catalogue.models.filter((model) => {
    const haystack =
      `${model.id} ${model.name} ${model.publisher.id} ${model.publisher.name}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The `model` a request should carry for a choice, or `undefined` to omit it.
 * See the module docstring for the rules.
 */
export function resolveSelection(
  choice: string | null | undefined,
  catalogue: Catalogue | undefined,
): string | undefined {
  const text = choice?.trim() ?? '';
  if (text === '') return undefined;
  if (catalogue === undefined) return looksLikeModelId(text) ? text : undefined;
  const matches = searchModels(text, catalogue);
  return matches.length === 1 ? matches[0]?.id : undefined;
}

/** "128K", "1M" — a context window as a person reads it. */
export function formatContext(tokens: number | null): string | null {
  if (tokens === null) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export interface ModelGroup {
  readonly title: string;
  readonly models: readonly CatalogueModel[];
}

/**
 * Featured models first (in the server's order), then everything else grouped
 * by publisher, alphabetically by publisher and then by name.
 */
export function groupModels(catalogue: Catalogue): ModelGroup[] {
  const byId = new Map(catalogue.models.map((model) => [model.id, model]));
  const featuredOrder =
    catalogue.featuredIds.length > 0
      ? catalogue.featuredIds
      : catalogue.models.filter((model) => model.featured).map((model) => model.id);
  const featured = featuredOrder
    .map((id) => byId.get(id))
    .filter((model): model is CatalogueModel => model !== undefined);
  const featuredSet = new Set(featured.map((model) => model.id));

  const byPublisher = new Map<string, CatalogueModel[]>();
  for (const model of catalogue.models) {
    if (featuredSet.has(model.id)) continue;
    const list = byPublisher.get(model.publisher.name) ?? [];
    list.push(model);
    byPublisher.set(model.publisher.name, list);
  }

  const groups: ModelGroup[] = [];
  if (featured.length > 0) groups.push({ title: 'Featured', models: featured });
  for (const publisher of [...byPublisher.keys()].sort((a, b) => a.localeCompare(b))) {
    const models = (byPublisher.get(publisher) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ title: publisher, models });
  }
  return groups;
}

/**
 * The `/model` listing: every model, grouped, with its name, id and context
 * window, and markers for the current choice and the server default.
 */
export function formatModelList(catalogue: Catalogue, currentId: string): string {
  const lines: string[] = [];
  const effectiveId = currentId === '' ? catalogue.defaultModelId : currentId;
  for (const group of groupModels(catalogue)) {
    lines.push(`${group.title}:`);
    for (const model of group.models) {
      const marker = model.id === effectiveId ? '●' : ' ';
      const context = formatContext(model.contextWindow);
      const tags = [
        context === null ? null : `${context} ctx`,
        model.id === catalogue.defaultModelId ? 'default' : null,
      ].filter((tag): tag is string => tag !== null);
      const suffix = tags.length > 0 ? `  (${tags.join(', ')})` : '';
      lines.push(`  ${marker} ${model.name} — ${model.publisher.name}  ${model.id}${suffix}`);
    }
  }
  lines.push('');
  lines.push('Use /model <id or name> to switch, /model default for the server default.');
  return lines.join('\n');
}

/** How the current choice reads in the header: the model's name, or the default. */
export function labelForChoice(choice: string, catalogue: Catalogue | undefined): string {
  if (choice.trim() === '') {
    const fallback =
      catalogue?.defaultModelId == null
        ? undefined
        : catalogue.models.find((model) => model.id === catalogue.defaultModelId);
    return fallback === undefined ? 'Default model' : `Default (${fallback.name})`;
  }
  if (catalogue === undefined) return choice;
  const matches = searchModels(choice, catalogue);
  return matches.length === 1 && matches[0] !== undefined ? matches[0].name : choice;
}

let cached: Promise<Catalogue> | null = null;

/**
 * The catalogue, fetched at most once per process.
 *
 * A rejected promise is evicted, so one cold-start network failure does not
 * make the CLI permanently blind for the rest of its run.
 */
export function fetchCatalogue(): Promise<Catalogue> {
  if (cached !== null) return cached;
  const request = (async () => {
    // The catalogue takes optional auth: signed out it still lists the models.
    const token = accessToken();
    const response = await fetch(`${config.get('apiBaseUrl')}/catalogue`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`The model catalogue request failed (${response.status}).`);
    return parseCatalogue(await response.json());
  })();
  cached = request;
  request.catch(() => {
    cached = null;
  });
  return request;
}

/** The catalogue, or `undefined` if it cannot be read. Never throws. */
export async function tryCatalogue(): Promise<Catalogue | undefined> {
  try {
    return await fetchCatalogue();
  } catch {
    return undefined;
  }
}

/** The `model` a request should carry, or `undefined` to omit it. Never throws. */
export async function resolveModelId(choice: string): Promise<string | undefined> {
  if (choice.trim() === '') return undefined;
  return resolveSelection(choice, await tryCatalogue());
}

/** The header label for a choice. Never throws. */
export async function labelFor(choice: string): Promise<string> {
  return labelForChoice(choice, await tryCatalogue());
}
