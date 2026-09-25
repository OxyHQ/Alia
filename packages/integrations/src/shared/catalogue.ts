/**
 * The model catalogue, as the bots consume it (`GET /catalogue`).
 *
 * Alia has no models of its own: the catalogue lists the real models the
 * server can route to, each named `publisher/model`, and reports which one the
 * server uses when a request names none (`defaultModelId`). Nothing in this
 * service names a model. A person's choice is stored as the id they picked, and
 * every request goes through {@link resolveRequestModel}:
 *
 *  - a chosen model the loaded catalogue lists is sent;
 *  - no choice, or a choice the catalogue no longer lists, sends NO `model`, so
 *    the server's own default applies — a withdrawn model degrades to the
 *    default rather than to an error;
 *  - when the catalogue could not be read at all, the chosen id is sent as-is
 *    (the server is the authority on whether it still exists).
 *
 * A stored value that is not a `publisher/model` id — a retired `mode:*`,
 * `route:*`, `profile:*` or legacy `alia-*` identifier — reads as unset.
 *
 * The bots call it server-to-server, with no `Origin` header and no user bearer
 * token; `GET /catalogue` is `optionalAuth`, so no credential is sent.
 */

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** A catalogue entry, in the fields a bot renders or decides on. */
export interface CatalogueModel {
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
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly pricing: { readonly inputPerMTok: string; readonly outputPerMTok: string } | null;
  readonly releasedAt: string | null;
  readonly featured: boolean;
}

export interface Catalogue {
  readonly models: readonly CatalogueModel[];
  /** The model the server uses when a request names none. May be absent from `models`. */
  readonly defaultModelId: string;
  readonly featuredIds: readonly string[];
}

type JsonObject = Record<string, unknown>;

const UNREADABLE = 'The model catalogue response could not be read.';
const REASONING_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A `publisher/model` id: two or more non-empty, whitespace-free segments. */
function isModelId(value: string): boolean {
  return /^[^\s/]+(?:\/[^\s/]+)+$/.test(value);
}

function parseEntry(value: unknown): CatalogueModel | null {
  const raw = asObject(value);
  if (raw === null || raw.object !== 'model') return null;
  const id = asText(raw.id);
  const name = asText(raw.name);
  const publisher = asObject(raw.publisher);
  const publisherId = publisher === null ? null : asText(publisher.id);
  const publisherName = publisher === null ? null : asText(publisher.name);
  if (id === null || !isModelId(id) || name === null || name.trim() === '') return null;
  if (publisherId === null || publisherName === null) return null;

  const pricing = asObject(raw.pricing);
  const inputPerMTok = pricing === null ? null : asText(pricing.inputPerMTok);
  const outputPerMTok = pricing === null ? null : asText(pricing.outputPerMTok);

  return {
    id,
    name,
    publisher: { id: publisherId, name: publisherName },
    description: asText(raw.description),
    contextWindow: asCount(raw.contextWindow),
    maxOutput: asCount(raw.maxOutput),
    inputModalities: asTextList(raw.inputModalities),
    outputModalities: asTextList(raw.outputModalities),
    tools: raw.tools === true,
    reasoningEfforts: asTextList(raw.reasoningEfforts).filter(
      (effort): effort is ReasoningEffort => REASONING_EFFORTS.has(effort),
    ),
    pricing: inputPerMTok !== null && outputPerMTok !== null ? { inputPerMTok, outputPerMTok } : null,
    releasedAt: asText(raw.releasedAt),
    featured: raw.featured === true,
  };
}

/**
 * Turn a catalogue response into a {@link Catalogue}, or throw.
 *
 * Throwing beats returning an empty list because "no models" and "we failed to
 * read the models" are indistinguishable to the caller, and one of them means a
 * `/model` listing that silently offers nothing. A single malformed entry is
 * dropped; every entry malformed is a shape break.
 */
export function parseCatalogue(payload: unknown): Catalogue {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (body === null || !Array.isArray(data)) throw new Error(UNREADABLE);
  const defaultModelId = asText(body.defaultModelId);
  if (defaultModelId === null || defaultModelId === '') throw new Error(UNREADABLE);

  const models: CatalogueModel[] = [];
  const seen = new Set<string>();
  for (const value of data) {
    const entry = parseEntry(value);
    if (entry === null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(entry);
  }
  if (data.length > 0 && models.length === 0) throw new Error(UNREADABLE);

  return { models, defaultModelId, featuredIds: asTextList(body.featuredIds) };
}

/**
 * A stored choice, normalised: the `publisher/model` id, or `null` for unset.
 * Anything else — empty, or a retired `mode:*` / `route:*` / `profile:*` /
 * `alia-*` identifier — reads as unset.
 */
export function storedChoice(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isModelId(trimmed) ? trimmed : null;
}

export function findModel(catalogue: Catalogue, id: string): CatalogueModel | null {
  return catalogue.models.find((model) => model.id === id) ?? null;
}

/**
 * The `model` a request carries, or `undefined` to omit it (server default).
 * `catalogue` is `null` when it could not be read.
 */
export function resolveRequestModel(
  chosen: string | null | undefined,
  catalogue: Catalogue | null,
): string | undefined {
  const id = storedChoice(chosen);
  if (id === null) return undefined;
  if (catalogue === null) return id;
  return findModel(catalogue, id) === null ? undefined : id;
}

/**
 * Every model, featured first (in `featuredIds` order, then any entry flagged
 * `featured` the list missed), then the rest in catalogue order.
 */
export function modelsForListing(catalogue: Catalogue): CatalogueModel[] {
  const featured: CatalogueModel[] = [];
  const taken = new Set<string>();
  for (const id of catalogue.featuredIds) {
    const model = findModel(catalogue, id);
    if (model !== null && !taken.has(id)) {
      featured.push(model);
      taken.add(id);
    }
  }
  for (const model of catalogue.models) {
    if (model.featured && !taken.has(model.id)) {
      featured.push(model);
      taken.add(model.id);
    }
  }
  return [...featured, ...catalogue.models.filter((model) => !taken.has(model.id))];
}

export function isFeatured(catalogue: Catalogue, model: CatalogueModel): boolean {
  return model.featured || catalogue.featuredIds.includes(model.id);
}

/**
 * Models matching free text, case-insensitively, over id, name and publisher
 * name. An exact id match comes first, then exact name matches, then the rest
 * in listing order (featured first). Empty text matches nothing.
 */
export function searchModels(catalogue: Catalogue, text: string): CatalogueModel[] {
  const wanted = text.trim().toLowerCase();
  if (wanted === '') return [];
  const rank = (model: CatalogueModel): number => {
    if (model.id.toLowerCase() === wanted) return 0;
    if (model.name.toLowerCase() === wanted) return 1;
    return 2;
  };
  return modelsForListing(catalogue)
    .filter((model) =>
      model.id.toLowerCase().includes(wanted)
      || model.name.toLowerCase().includes(wanted)
      || model.publisher.name.toLowerCase().includes(wanted),
    )
    .map((model, index) => ({ model, index, rank: rank(model) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
}

/** What a person reads for the server default: `Default (<name>)`. */
export function defaultLabel(catalogue: Catalogue): string {
  const model = findModel(catalogue, catalogue.defaultModelId);
  return `Default (${model === null ? catalogue.defaultModelId : model.name})`;
}

/**
 * What a person's current model is called. A choice the catalogue does not
 * list is not what requests use (they omit `model`), so it reads as the default.
 */
export function currentModelLabel(
  chosen: string | null | undefined,
  catalogue: Catalogue,
): string {
  const id = resolveRequestModel(chosen, catalogue);
  const model = id === undefined ? null : findModel(catalogue, id);
  return model === null ? defaultLabel(catalogue) : model.name;
}

/** What a `/model <text>` command asks for. */
export type ModelCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'select'; readonly model: CatalogueModel }
  | { readonly kind: 'matches'; readonly query: string; readonly models: readonly CatalogueModel[] }
  | { readonly kind: 'none'; readonly query: string };

const RESET_WORDS: ReadonlySet<string> = new Set(['default', 'reset']);

/**
 * Resolve the argument of a `/model` command: nothing lists; `default`/`reset`
 * clears; an exact id (case-insensitive) or a single match selects; several
 * matches are listed; none says so.
 */
export function resolveModelCommand(argument: string | null | undefined, catalogue: Catalogue): ModelCommand {
  const text = (argument ?? '').trim();
  if (text === '') return { kind: 'list' };
  if (RESET_WORDS.has(text.toLowerCase())) return { kind: 'reset' };
  const matches = searchModels(catalogue, text);
  const first = matches[0];
  if (first === undefined) return { kind: 'none', query: text };
  if (first.id.toLowerCase() === text.toLowerCase() || matches.length === 1) {
    return { kind: 'select', model: first };
  }
  return { kind: 'matches', query: text, models: matches };
}

/**
 * Join lines under a character budget. When not every line fits, as many as fit
 * are kept and `more(n)` (the count left out) is appended — the budget accounts
 * for it.
 */
export function fitLines(
  lines: readonly string[],
  maxChars: number,
  more: (omitted: number) => string,
  separator = '\n',
): string {
  const all = lines.join(separator);
  if (all.length <= maxChars) return all;
  for (let kept = lines.length - 1; kept >= 0; kept -= 1) {
    const tail = more(lines.length - kept);
    const text = [...lines.slice(0, kept), tail].join(separator);
    if (text.length <= maxChars) return text;
  }
  return more(lines.length).slice(0, maxChars);
}
