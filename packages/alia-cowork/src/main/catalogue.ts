/**
 * The model catalogue, as the Electron main process consumes it
 * (`GET /catalogue`, epic #139 workstream 5).
 *
 * Cowork used to read `GET /v1/models?category=coding` for its model list and
 * hardcode `route:cowork` in three places besides. `/v1/models` serializes
 * every entry with `object: "model"`, including the twelve that are routing
 * profiles — which is precisely the claim ADR 0003 invariant 1 forbids a client
 * from repeating to a user. `/catalogue` distinguishes them, so this reads that.
 *
 * A desktop binary is the worst place for a baked-in identifier: a retirement
 * breaks an installed application until its user takes an update.
 *
 * ## Why this is a copy rather than a shared module
 *
 * `packages/app`, `@alia.onl/sdk` and `@alia-codea/cli` parse the same surface.
 * A shared workspace package was measured and rejected: the SDK ships as RAW
 * SOURCE and the CLI is published, so neither can depend on an unpublished
 * workspace package — their consumers' resolvers would fail on `workspace:*`.
 * Cowork bundles everything with esbuild and could have consumed one, but a
 * shared module that only half its intended consumers can use is a copy with
 * extra ceremony.
 *
 * The parsing rules are stated once, at length, in
 * `packages/app/lib/hooks/use-catalogue.ts`. Both are about not inventing: an
 * entry whose `object` is neither known value is dropped, and a response whose
 * entries all fail to parse throws rather than reading as an empty catalogue.
 */

import { PREFERRED_CHAT_MODEL_ID } from './config';

export interface CatalogueEntry {
  readonly id: string;
  readonly displayName: string;
  readonly chatVisible: boolean;
  readonly unavailable: boolean;
  /**
   * Whether THIS caller may use the entry: `true`, `false`, or `null` for "the
   * server is not describing anybody's entitlement" (an unauthenticated read,
   * or `entitlement.state: 'unknown'`). The server's own answer in its own
   * vocabulary; `null` is not "not entitled" and must not cause a substitution.
   */
  readonly entitled: boolean | null;
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

export function parseCatalogue(payload: unknown): CatalogueEntry[] {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (!Array.isArray(data)) throw new Error('The model catalogue response could not be read.');

  const entries: CatalogueEntry[] = [];
  for (const value of data) {
    const raw = asObject(value);
    if (raw === null) continue;
    const id = asText(raw.id);
    const displayName = asText(raw.display_name);
    if (id === null || displayName === null) continue;
    if (raw.object !== 'model' && raw.object !== 'routing_profile') continue;
    const availability = asObject(raw.availability) ?? {};
    const entitlement = asObject(raw.entitlement) ?? {};
    entries.push({
      id,
      displayName,
      chatVisible: raw.chat_visible === true,
      unavailable: availability.status === 'unavailable',
      entitled: typeof entitlement.entitled === 'boolean' ? entitlement.entitled : null,
    });
  }
  if (data.length > 0 && entries.length === 0) {
    throw new Error('The model catalogue response could not be read.');
  }
  return entries;
}

export interface ModelSelection {
  readonly requestedId: string;
  readonly effectiveId: string;
  readonly source: 'requested' | 'replaced';
}

/**
 * Resolve a requested identifier against the catalogue.
 *
 * The deliberate non-behaviours, shared with every other client: no catalogue
 * leaves the choice alone, an entry reported unavailable is still honoured
 * because the server already falls back among the models behind it, and the
 * preference is checked rather than trusted.
 *
 * Two rules are Cowork's own, because Cowork has no picker:
 *
 *  - **A requested entry is honoured if the catalogue LISTS it**, not only if
 *    it would show it. `route:cowork` is published `chat_visible: false` — it
 *    is a surface preset, not something a person picks — and the previous
 *    "chat-visible only" test replaced it with the cheapest visible entry on
 *    every send, which is how this app ran on Instant for months.
 *  - **An entry the server says this caller is NOT entitled to is replaced**,
 *    by the preference if that is entitled, else by the first entitled
 *    chat-visible entry. Sending it would be answered `403 MODEL_NOT_IN_PLAN`,
 *    and with no picker there is nothing a person could do about it except
 *    stop using the app. `null` entitlement — an unauthenticated read, or a
 *    server that could not evaluate plans — is not a refusal and changes
 *    nothing.
 */
export function resolveSelection(
  requestedId: string,
  entries: readonly CatalogueEntry[] | undefined,
  preferredId: string = PREFERRED_CHAT_MODEL_ID,
): ModelSelection {
  if (entries === undefined) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }
  const usable = (entry: CatalogueEntry): boolean => entry.entitled !== false;
  const requested = entries.find((entry) => entry.id === requestedId);
  if (requested !== undefined && usable(requested)) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }
  const offered = entries.filter((entry) => entry.chatVisible && usable(entry));
  const replacement =
    entries.find((entry) => entry.id === preferredId && usable(entry)) ??
    offered.find((entry) => !entry.unavailable) ??
    offered[0];
  if (replacement === undefined) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }
  return { requestedId, effectiveId: replacement.id, source: 'replaced' };
}

const cache = new Map<string, Promise<CatalogueEntry[]>>();

/**
 * The catalogue for one API base URL, fetched at most once per URL.
 *
 * A rejected promise is evicted: a desktop application stays open for days, so
 * caching a failure would outlast the outage that caused it by a very long way.
 */
export function fetchCatalogue(apiBaseUrl: string, accessToken?: string): Promise<CatalogueEntry[]> {
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
 * The identifier a request should carry. Never throws: an unreadable catalogue
 * leaves the requested identifier alone and the server stays the authority.
 */
export async function resolveModelId(
  apiBaseUrl: string,
  requestedId: string,
  accessToken?: string,
): Promise<string> {
  try {
    const entries = await fetchCatalogue(apiBaseUrl, accessToken);
    return resolveSelection(requestedId, entries).effectiveId;
  } catch {
    return requestedId;
  }
}
