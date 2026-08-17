/**
 * The model catalogue, as the SDK consumes it (`GET /catalogue`, epic #139
 * workstream 5).
 *
 * Every surface used to hardcode an `alia-*` identifier as its default —
 * `useAliaChat` sent `alia-v1`, `useTTS` and `useVoiceRoom` sent `alia-v1-voice`
 * — which meant a retired identifier became a 400 in a consumer's app with
 * nothing the consumer could do about it, since the string was baked into the
 * package they installed. This module is how the SDK asks the server what it
 * offers instead.
 *
 * ## Deliberately not React, and deliberately not react-query
 *
 * `packages/app` reads the same surface through `useCatalogue`, a react-query
 * hook. The SDK cannot copy that: it declares `@tanstack/react-query` as a
 * dependency but imports it in **zero** modules today — measured — so a consumer
 * mounting `<AliaChatSheet>` is not required to have a `QueryClientProvider`
 * anywhere above it. Introducing one here would turn "the model default came
 * from the server" into a breaking change for every consumer, which is a bad
 * trade for a fallback.
 *
 * Resolution therefore happens where it matters — inside `send`, at the moment a
 * request is about to name a model — rather than at render. A module-level cache
 * keeps that from becoming a fetch per message.
 *
 * ## The parsing rules are the app's, because the contract is the same one
 *
 * Two rules, both about not inventing (see `packages/app/lib/hooks/use-catalogue.ts`,
 * which states them at length):
 *
 *  - An entry whose `object` is neither known value is DROPPED. Defaulting it to
 *    either kind would break ADR 0003 invariant 1 in one direction or the other.
 *  - A response whose entries all fail to parse THROWS rather than reading as an
 *    empty catalogue, because "no models" and "we could not read the models"
 *    look identical to every caller below and one of them means "offer nothing".
 *
 * This file is a second implementation of that contract rather than a shared
 * one, and that is forced rather than chosen: `@alia.onl/sdk` ships as raw
 * source, so it cannot depend on an unpublished workspace package — a consumer's
 * Metro would fail to resolve it. The three Node-side clients (Codea, Cowork,
 * the CLI) share one instead.
 */

/** A product-owned policy that picks a model per request, or a reference to one named model. */
export type CatalogueEntryKind = 'routing_profile' | 'model';

export interface CatalogueEntry {
  readonly id: string;
  readonly kind: CatalogueEntryKind;
  readonly displayName: string;
  readonly description: string;
  /** Product policy: whether a chat picker surfaces this entry. */
  readonly chatVisible: boolean;
  /** The server states this as a claim; an entry that omits it is not called unavailable. */
  readonly unavailable: boolean;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseEntry(value: unknown): CatalogueEntry | null {
  const raw = asObject(value);
  if (raw === null) return null;

  const id = asText(raw.id);
  const displayName = asText(raw.display_name);
  if (id === null || displayName === null) return null;

  if (raw.object !== 'model' && raw.object !== 'routing_profile') return null;
  const availability = asObject(raw.availability) ?? {};

  return {
    id,
    kind: raw.object,
    displayName,
    description: asText(raw.description) ?? '',
    chatVisible: raw.chat_visible === true,
    unavailable: availability.status === 'unavailable',
  };
}

/** Turn a catalogue response into entries, or throw. */
export function parseCatalogue(payload: unknown): CatalogueEntry[] {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (!Array.isArray(data)) throw new Error('The model catalogue response could not be read.');

  const entries: CatalogueEntry[] = [];
  for (const value of data) {
    const entry = parseEntry(value);
    if (entry !== null) entries.push(entry);
  }
  if (data.length > 0 && entries.length === 0) {
    throw new Error('The model catalogue response could not be read.');
  }
  return entries;
}

export interface ModelSelection {
  /** What the caller asked for, which is what a picker keeps showing as chosen. */
  readonly requestedId: string;
  /** What a request should carry. Differs from `requestedId` only when replaced. */
  readonly effectiveId: string;
  /** `replaced` when the requested identifier is not one the catalogue offers. */
  readonly source: 'requested' | 'replaced';
}

/**
 * Resolve a requested identifier against the catalogue.
 *
 * The same three deliberate non-behaviours as the app's `resolveSelection`:
 *
 *  - **No catalogue — not loaded, or the request failed — leaves the choice
 *    alone.** Replacing on missing data changes the model under the user on any
 *    slow cold start, which is the same wrong answer as a retirement.
 *  - **An entry reported UNAVAILABLE is still honoured.** That is a health
 *    signal about the models behind an entry and the server already falls back
 *    among them; picking a different one is a product decision nobody made.
 *  - **`preferredId` is never trusted.** It is a build-time value, so it is
 *    checked against the catalogue like any other and falls through when the
 *    catalogue does not offer it.
 */
export function resolveSelection(
  requestedId: string,
  entries: readonly CatalogueEntry[] | undefined,
  preferredId?: string,
): ModelSelection {
  if (entries === undefined) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }

  const offered = entries.filter((entry) => entry.chatVisible);
  if (offered.some((entry) => entry.id === requestedId)) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }

  const replacement =
    (preferredId === undefined
      ? undefined
      : offered.find((entry) => entry.id === preferredId)) ??
    offered.find((entry) => !entry.unavailable) ??
    offered[0];
  if (replacement === undefined) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }
  return { requestedId, effectiveId: replacement.id, source: 'replaced' };
}

/**
 * The catalogue for one API base URL, fetched at most once per URL.
 *
 * The promise is cached rather than the result, so concurrent callers share one
 * request. A REJECTED promise is evicted, because caching a failure would make a
 * single cold-start network blip permanent for the life of the process.
 */
const inFlight = new Map<string, Promise<CatalogueEntry[]>>();

export function fetchCatalogue(apiUrl: string, accessToken?: string): Promise<CatalogueEntry[]> {
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
 * The identifier a request should carry, given what the caller asked for.
 *
 * Never throws: a catalogue that cannot be read leaves the requested identifier
 * alone, which is the same answer as "the catalogue has not loaded yet". A
 * consumer that wants to KNOW the catalogue is unreadable calls
 * {@link fetchCatalogue} directly.
 */
export async function resolveModelId(
  apiUrl: string,
  requestedId: string,
  accessToken?: string,
  preferredId?: string,
): Promise<string> {
  try {
    const entries = await fetchCatalogue(apiUrl, accessToken);
    return resolveSelection(requestedId, entries, preferredId).effectiveId;
  } catch {
    return requestedId;
  }
}
