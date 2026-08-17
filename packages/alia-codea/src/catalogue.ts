/**
 * The model catalogue, as the VS Code extension consumes it (`GET /catalogue`,
 * epic #139 workstream 5).
 *
 * Three providers each carried `config.get('model', 'alia-v1-codea')`, so a
 * retired identifier became a failed completion inside an extension version
 * already installed from the marketplace — the slowest possible thing to fix.
 * The `codea.model` setting still wins when a user sets one; what changed is
 * that an identifier nobody chose is now resolved against the server rather than
 * baked into three files.
 *
 * ## A fourth implementation, and why sharing was measured and rejected
 *
 * `packages/app`, `@alia.onl/sdk` and `@alia-codea/cli` parse the same surface.
 * One shared workspace package would be better and is not available: the SDK
 * ships as RAW SOURCE and the CLI is published, so neither can depend on an
 * unpublished workspace package. This extension bundles with esbuild and could
 * have consumed one — but a shared module only two of four consumers can use is
 * not a shared module, it is a third copy with extra ceremony.
 *
 * The parsing rules are stated once, at length, in
 * `packages/app/lib/hooks/use-catalogue.ts`. Both are about not inventing: an
 * entry whose `object` is neither known value is dropped, and a response whose
 * entries all fail to parse throws rather than reading as an empty catalogue.
 */

import { PREFERRED_MODEL_ID } from './config';

export interface CatalogueEntry {
  readonly id: string;
  readonly displayName: string;
  readonly chatVisible: boolean;
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
    entries.push({
      id,
      displayName,
      chatVisible: raw.chat_visible === true,
      unavailable: availability.status === 'unavailable',
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
 * The three deliberate non-behaviours, identical to every other client: no
 * catalogue leaves the choice alone, an entry reported unavailable is still
 * honoured because the server already falls back among the models behind it,
 * and the preference is checked rather than trusted.
 */
export function resolveSelection(
  requestedId: string,
  entries: readonly CatalogueEntry[] | undefined,
  preferredId: string = PREFERRED_MODEL_ID,
): ModelSelection {
  if (entries === undefined) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }
  const offered = entries.filter((entry) => entry.chatVisible);
  if (offered.some((entry) => entry.id === requestedId)) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }
  const replacement =
    offered.find((entry) => entry.id === preferredId) ??
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
 * A rejected promise is evicted: an extension host lives for days, so caching a
 * failure would outlast the outage that caused it by a very long way.
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
