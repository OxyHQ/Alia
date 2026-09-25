/**
 * The model catalogue, as the SDK consumes it (`GET /catalogue`).
 *
 * Alia has no models of its own: the catalogue lists the real models Oxy serves
 * (ids `publisher/model`), and the server decides which one a request with no
 * `model` gets (`defaultModelId`) and which ones a picker shows first
 * (`featuredIds`). This package therefore ships NO model identifier: a caller
 * that names no model sends no `model`, and the server answers with its default.
 *
 * ## Deliberately not React, and deliberately not react-query
 *
 * The SDK imports `@tanstack/react-query` in no module, so a consumer mounting
 * `<AliaChatSheet>` is not required to have a `QueryClientProvider`. Resolution
 * happens inside `send`, at the moment a request is about to name a model, and a
 * module-level cache keeps that from becoming a fetch per message.
 *
 * ## Parsing does not invent
 *
 * An entry without an id or a name is dropped, and a response whose entries all
 * fail to parse THROWS rather than reading as an empty catalogue: "no models"
 * and "we could not read the models" look identical to every caller below, and
 * one of them means "offer nothing".
 */

/** A reasoning effort a model accepts. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export interface CatalogueEntry {
  /** `publisher/model`. */
  readonly id: string;
  readonly name: string;
  readonly publisher: { readonly id: string; readonly name: string };
  readonly description: string | null;
  readonly contextWindow: number | null;
  readonly maxOutput: number | null;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly tools: boolean;
  /** The efforts the model accepts, cheapest first. Empty: send none. */
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly pricing: { readonly inputPerMTok: string; readonly outputPerMTok: string } | null;
  readonly releasedAt: string | null;
  readonly featured: boolean;
}

export interface Catalogue {
  readonly entries: readonly CatalogueEntry[];
  /** What a request without `model` is answered with, or `null` if the server did not say. */
  readonly defaultModelId: string | null;
  /** The ids a picker shows first, in order. */
  readonly featuredIds: readonly string[];
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function asTexts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseEntry(value: unknown): CatalogueEntry | null {
  const raw = asObject(value);
  if (raw === null) return null;

  const id = asText(raw.id);
  const name = asText(raw.name);
  if (id === null || name === null) return null;

  const publisher = asObject(raw.publisher);
  const publisherId = asText(publisher?.id) ?? id.split('/')[0] ?? id;
  const pricing = asObject(raw.pricing);
  const input = asText(pricing?.inputPerMTok);
  const output = asText(pricing?.outputPerMTok);

  return {
    id,
    name,
    publisher: { id: publisherId, name: asText(publisher?.name) ?? publisherId },
    description: asText(raw.description),
    contextWindow: asCount(raw.contextWindow),
    maxOutput: asCount(raw.maxOutput),
    inputModalities: asTexts(raw.inputModalities),
    outputModalities: asTexts(raw.outputModalities),
    tools: raw.tools === true,
    reasoningEfforts: REASONING_EFFORTS.filter((effort) =>
      asTexts(raw.reasoningEfforts).includes(effort),
    ),
    pricing: input !== null && output !== null ? { inputPerMTok: input, outputPerMTok: output } : null,
    releasedAt: asText(raw.releasedAt),
    featured: raw.featured === true,
  };
}

/** Turn a catalogue response into a {@link Catalogue}, or throw. */
export function parseCatalogue(payload: unknown): Catalogue {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (body === null || !Array.isArray(data)) {
    throw new Error('The model catalogue response could not be read.');
  }

  const entries: CatalogueEntry[] = [];
  for (const value of data) {
    const entry = parseEntry(value);
    if (entry !== null) entries.push(entry);
  }
  if (data.length > 0 && entries.length === 0) {
    throw new Error('The model catalogue response could not be read.');
  }
  return {
    entries,
    defaultModelId: asText(body.defaultModelId),
    featuredIds: asTexts(body.featuredIds),
  };
}

export interface ModelSelection {
  /** What the caller asked for; `undefined` is "the server's default". */
  readonly requestedId: string | undefined;
  /** What a request should carry as `model`; `undefined` means omit it. */
  readonly effectiveId: string | undefined;
  /** The entry the request will be answered by, when the catalogue says. */
  readonly entry: CatalogueEntry | null;
  /** `replaced` when the requested identifier is not one the catalogue offers. */
  readonly source: 'requested' | 'default' | 'replaced';
}

/**
 * Resolve a requested identifier against the catalogue.
 *
 *  - **Nothing requested** → omit `model`; the server's default answers.
 *  - **No catalogue — not loaded, or the request failed — leaves the choice
 *    alone.** Replacing on missing data would change the model under the user
 *    on any slow cold start.
 *  - **An identifier the catalogue no longer lists** is not sent (it would be
 *    refused); the request omits `model` and the server's default answers.
 */
export function resolveSelection(
  requestedId: string | null | undefined,
  catalogue: Catalogue | undefined,
): ModelSelection {
  const requested = requestedId === null || requestedId === '' ? undefined : requestedId;
  const defaultEntry = (): CatalogueEntry | null =>
    catalogue?.entries.find((entry) => entry.id === catalogue.defaultModelId) ?? null;

  if (requested === undefined) {
    return { requestedId: undefined, effectiveId: undefined, entry: defaultEntry(), source: 'default' };
  }
  if (catalogue === undefined) {
    return { requestedId: requested, effectiveId: requested, entry: null, source: 'requested' };
  }
  const entry = catalogue.entries.find((candidate) => candidate.id === requested);
  if (entry !== undefined) {
    return { requestedId: requested, effectiveId: requested, entry, source: 'requested' };
  }
  return { requestedId: requested, effectiveId: undefined, entry: defaultEntry(), source: 'replaced' };
}

/**
 * The catalogue for one API base URL, fetched at most once per URL.
 *
 * The promise is cached rather than the result, so concurrent callers share one
 * request. A REJECTED promise is evicted, because caching a failure would make a
 * single cold-start network blip permanent for the life of the process.
 */
const inFlight = new Map<string, Promise<Catalogue>>();

export function fetchCatalogue(apiUrl: string, accessToken?: string): Promise<Catalogue> {
  const cached = inFlight.get(apiUrl);
  if (cached !== undefined) return cached;

  const request = (async () => {
    const response = await fetch(`${apiUrl}/catalogue`, {
      headers: accessToken === undefined ? {} : { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`The model catalogue request failed (${response.status}).`);
    return parseCatalogue(await response.json());
  })();

  inFlight.set(apiUrl, request);
  request.catch(() => inFlight.delete(apiUrl));
  return request;
}

/** Drop the cache. Exported for consumers that switch API base URL or sign a different user in. */
export function clearCatalogueCache(): void {
  inFlight.clear();
}

/**
 * The `model` a request should carry, given what the caller asked for, or
 * `undefined` to omit it and let the server's default answer.
 *
 * Never throws: a catalogue that cannot be read leaves the requested identifier
 * alone, which is the same answer as "the catalogue has not loaded yet".
 */
export async function resolveModelId(
  apiUrl: string,
  requestedId: string | undefined,
  accessToken?: string,
): Promise<string | undefined> {
  if (requestedId === undefined || requestedId === '') return undefined;
  try {
    return resolveSelection(requestedId, await fetchCatalogue(apiUrl, accessToken)).effectiveId;
  } catch {
    return requestedId;
  }
}
