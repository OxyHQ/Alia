/**
 * The model catalogue, as the app consumes it (`GET /catalogue`).
 *
 * Alia is a multi-provider assistant with no models of its own: the catalogue is
 * the real models Oxy serves, each `publisher/model`, plus two answers the SERVER
 * computes — `defaultModelId` (what a request with no `model` is answered with)
 * and `featuredIds` (what the picker shows first). Nothing here names a model;
 * the app never ships a model identifier.
 *
 * Parsing does not invent: an entry without an id or a name is dropped, a
 * response whose entries all fail to parse throws (an empty catalogue and an
 * unreadable one look identical below, and one of them means "offer nothing"),
 * and an effort level this client has no words for is dropped rather than drawn.
 */

import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';

/** The reasoning efforts a model may accept, cheapest first. */
export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

function isEffortLevel(value: unknown): value is EffortLevel {
  return (EFFORT_LEVELS as readonly unknown[]).includes(value);
}

export interface CatalogueEntry {
  /** `publisher/model`. */
  readonly id: string;
  readonly name: string;
  /** Who released the model — never the operator serving it. */
  readonly publisher: { readonly id: string; readonly name: string };
  readonly description: string | null;
  /** Tokens; `null` is unknown, never "none". */
  readonly contextWindow: number | null;
  readonly maxOutput: number | null;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly tools: boolean;
  /** The efforts the model accepts, cheapest first. Empty: the effort control is hidden. */
  readonly reasoningEfforts: readonly EffortLevel[];
  readonly pricing: { readonly inputPerMTok: string; readonly outputPerMTok: string } | null;
  readonly releasedAt: string | null;
  readonly featured: boolean;
}

export interface Catalogue {
  readonly entries: readonly CatalogueEntry[];
  /** What a request without `model` is answered with, or `null` if the server did not say. */
  readonly defaultModelId: string | null;
  /** What the picker shows first, in the server's order. */
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
  const efforts = Array.isArray(raw.reasoningEfforts) ? raw.reasoningEfforts : [];

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
    // Cheapest first whatever order the server sent, and only levels this
    // client can both name and send.
    reasoningEfforts: EFFORT_LEVELS.filter((level) => efforts.some((effort) => effort === level && isEffortLevel(effort))),
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

/**
 * The catalogue for the current caller.
 *
 * Unauthenticated on purpose — the picker renders signed out, and the route
 * takes optional auth. Keyed by user id because the server's default and
 * featured models can depend on who is asking (the default is the model the
 * user last used).
 */
export function useCatalogue() {
  const { user } = useOxy();
  return useQuery<Catalogue>({
    queryKey: queryKeys.catalogue.list(user?.id ?? null),
    queryFn: async () => parseCatalogue((await apiClient.get('/catalogue')).data),
    staleTime: 1000 * 60 * 5,
    retry: 2,
  });
}

export interface ModelSelection {
  /**
   * The id the picker shows as chosen: the stored choice, or the server's
   * default when there is none (or none the catalogue still lists). `null` only
   * while nothing is chosen and the catalogue has not said what the default is.
   */
  readonly shownId: string | null;
  /** What a request should carry as `model`, or `null` to omit it (server default). */
  readonly effectiveId: string | null;
  /** The catalogue entry that will answer, or `null` when unknown (loading, or a device model). */
  readonly entry: CatalogueEntry | null;
  /**
   * `requested`: the stored choice is sent. `default`: nothing is chosen.
   * `replaced`: the stored choice is no longer offered, so the default answers.
   */
  readonly source: 'requested' | 'default' | 'replaced';
}

/**
 * Resolve a stored selection against the catalogue.
 *
 *  - **Nothing chosen** (`null`) omits `model`: the server's default answers,
 *    and the picker shows `defaultModelId`.
 *  - **A model on one of the person's own devices** is sent while that device
 *    is connected; the catalogue does not list those.
 *  - **No catalogue yet** — loading, or the request failed — leaves the choice
 *    alone. Replacing on missing data would change the model under the user on
 *    any slow cold start.
 *  - **A model the catalogue no longer lists** is not sent (it would be
 *    refused); the default answers, and the picker says which.
 */
export function resolveSelection(
  requestedId: string | null,
  catalogue: Catalogue | undefined,
  localModelIds?: readonly string[],
): ModelSelection {
  const defaultId = catalogue?.defaultModelId ?? null;
  const defaultEntry = catalogue?.entries.find((entry) => entry.id === defaultId) ?? null;

  if (requestedId === null || requestedId === '') {
    return { shownId: defaultId, effectiveId: null, entry: defaultEntry, source: 'default' };
  }
  if (localModelIds?.includes(requestedId)) {
    return { shownId: requestedId, effectiveId: requestedId, entry: null, source: 'requested' };
  }
  if (catalogue === undefined) {
    return { shownId: requestedId, effectiveId: requestedId, entry: null, source: 'requested' };
  }
  const entry = catalogue.entries.find((candidate) => candidate.id === requestedId);
  if (entry !== undefined) {
    return { shownId: requestedId, effectiveId: requestedId, entry, source: 'requested' };
  }
  return { shownId: defaultId, effectiveId: null, entry: defaultEntry, source: 'replaced' };
}
