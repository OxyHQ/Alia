/**
 * The model catalogue, as the VS Code extension consumes it (`GET /catalogue`).
 *
 * Alia owns no models: the catalogue lists the real ones the server can reach,
 * each named `publisher/model`, and says which one it uses when a request names
 * none (`defaultModelId`). This extension therefore ships NO model identifier
 * of its own. The `codea.model` setting defaults to empty, and empty means "let
 * the server choose" — the request omits `model` entirely.
 *
 * ## Resolution
 *
 * - Nothing configured → omit `model` (server default).
 * - Configured and the loaded catalogue lists it → send it.
 * - Configured but no longer listed → omit `model`. Sending a withdrawn id
 *   would be a failed turn; the server default is a working one.
 * - Catalogue unreadable → send the configured id as-is (or omit it if empty).
 *   The server stays the authority and says so if the id is wrong.
 *
 * ## Why this is a copy rather than a shared module
 *
 * `packages/app`, `@alia.onl/sdk` and `@alia-codea/cli` parse the same surface.
 * The SDK ships as raw source and the CLI is published, so neither can depend on
 * an unpublished workspace package; a shared module only some consumers can use
 * would be a further copy with extra ceremony.
 *
 * Parsing does not invent: an entry missing its id or name is dropped, and a
 * response whose entries all fail to parse throws rather than reading as an
 * empty catalogue.
 */

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface CataloguePublisher {
  readonly id: string;
  readonly name: string;
}

export interface CatalogueModel {
  readonly id: string;
  readonly name: string;
  readonly publisher: CataloguePublisher;
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

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

function parseEntry(value: unknown): CatalogueModel | null {
  const raw = asObject(value);
  if (raw === null) return null;
  if (raw.object !== undefined && raw.object !== 'model') return null;
  const id = asText(raw.id);
  if (id === null) return null;
  const name = asText(raw.name);
  if (name === null) return null;

  const publisherRaw = asObject(raw.publisher);
  const publisherId = asText(publisherRaw?.id) ?? id.split('/')[0];
  const publisher = { id: publisherId, name: asText(publisherRaw?.name) ?? publisherId };

  const pricingRaw = asObject(raw.pricing);
  const inputPerMTok = asText(pricingRaw?.inputPerMTok);
  const outputPerMTok = asText(pricingRaw?.outputPerMTok);

  return {
    id,
    name,
    publisher,
    description: asText(raw.description),
    contextWindow: asCount(raw.contextWindow),
    maxOutput: asCount(raw.maxOutput),
    inputModalities: asTextList(raw.inputModalities),
    outputModalities: asTextList(raw.outputModalities),
    tools: raw.tools === true,
    reasoningEfforts: asTextList(raw.reasoningEfforts).filter((e): e is ReasoningEffort =>
      (EFFORTS as readonly string[]).includes(e),
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

/**
 * The id a request should carry for a configured choice, or `undefined` to omit
 * `model` and let the server use its default. See the module docstring.
 */
export function resolveSelection(
  configured: string | null | undefined,
  catalogue: Catalogue | undefined,
): string | undefined {
  const id = configured?.trim() ?? '';
  if (id === '') return undefined;
  if (catalogue === undefined) return id;
  return catalogue.models.some((model) => model.id === id) ? id : undefined;
}

/** One row of the webview picker. */
export interface PickerModel {
  readonly id: string;
  /** "Name — Publisher". */
  readonly label: string;
  readonly description: string;
}

export interface PickerGroup {
  readonly title: string;
  readonly models: readonly PickerModel[];
}

export interface PickerCatalogue {
  readonly groups: readonly PickerGroup[];
  /** Words for the empty choice: the server default, named when the catalogue says which. */
  readonly defaultLabel: string;
}

function pickerRow(model: CatalogueModel): PickerModel {
  const context =
    model.contextWindow === null ? null : `${Math.round(model.contextWindow / 1000)}K context`;
  const description = [model.description, context].filter((part) => part !== null).join(' · ');
  return { id: model.id, label: `${model.name} — ${model.publisher.name}`, description };
}

/**
 * What the picker shows: featured models first (in the server's order), then
 * every other model grouped by publisher, alphabetically by publisher and name.
 */
export function pickerCatalogue(catalogue: Catalogue): PickerCatalogue {
  const byId = new Map(catalogue.models.map((model) => [model.id, model]));
  const featuredOrder = catalogue.featuredIds.length > 0
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

  const groups: PickerGroup[] = [];
  if (featured.length > 0) groups.push({ title: 'Featured', models: featured.map(pickerRow) });
  for (const publisher of [...byPublisher.keys()].sort((a, b) => a.localeCompare(b))) {
    const models = byPublisher.get(publisher)!.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ title: publisher, models: models.map(pickerRow) });
  }

  const fallback = catalogue.defaultModelId === null ? undefined : byId.get(catalogue.defaultModelId);
  const defaultLabel = fallback === undefined ? 'Default' : `Default (${fallback.name})`;
  return { groups, defaultLabel };
}

const cache = new Map<string, Promise<Catalogue>>();

/**
 * The catalogue for one API base URL, fetched at most once per URL.
 *
 * A rejected promise is evicted: an extension host lives for days, so caching a
 * failure would outlast the outage that caused it by a very long way.
 */
function fetchCatalogue(apiBaseUrl: string, accessToken?: string): Promise<Catalogue> {
  const cached = cache.get(apiBaseUrl);
  if (cached !== undefined) return cached;

  const request = (async () => {
    const response = await fetch(`${apiBaseUrl}/catalogue`, {
      headers: accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`The model catalogue request failed (${response.status}).`);
    return parseCatalogue(await response.json());
  })();

  cache.set(apiBaseUrl, request);
  request.catch(() => cache.delete(apiBaseUrl));
  return request;
}

/**
 * What the webview picker should show. Empty groups on failure rather than a
 * built-in list: the picker then offers only the server default.
 */
export async function fetchPickerCatalogue(
  apiBaseUrl: string,
  accessToken?: string,
): Promise<PickerCatalogue> {
  try {
    return pickerCatalogue(await fetchCatalogue(apiBaseUrl, accessToken));
  } catch {
    return { groups: [], defaultLabel: 'Default' };
  }
}

/**
 * The `model` a request should carry, or `undefined` to omit it. Never throws:
 * an unreadable catalogue leaves the configured id alone.
 */
export async function resolveModelId(
  apiBaseUrl: string,
  configured: string | null | undefined,
  accessToken?: string,
): Promise<string | undefined> {
  if ((configured?.trim() ?? '') === '') return undefined;
  try {
    return resolveSelection(configured, await fetchCatalogue(apiBaseUrl, accessToken));
  } catch {
    return resolveSelection(configured, undefined);
  }
}
