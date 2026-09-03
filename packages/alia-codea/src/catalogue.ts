/**
 * The model catalogue, as the VS Code extension consumes it (`GET /catalogue`,
 * epic #139 workstream 5).
 *
 * Three providers each carried `config.get('model', 'kaana-v1-codea')`, so a
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
  readonly description: string;
  readonly chatVisible: boolean;
  readonly unavailable: boolean;
}

/** Which routing profile a request made in this mode goes through. */
export type ProductModeRouting =
  | { readonly kind: 'profile'; readonly profileId: string }
  | { readonly kind: 'default' };

/**
 * A product mode — the words the picker shows.
 *
 * A mode is a LABEL for a profile, never a selectable identifier: nothing in
 * the request path consumes a `mode:*` id, so a webview that sent one would get
 * a 400. `packages/app/lib/hooks/use-product-modes.ts` states that at length.
 */
export interface ProductMode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly routing: ProductModeRouting;
  readonly deepResearch: boolean;
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
      description: asText(raw.description) ?? '',
      chatVisible: raw.chat_visible === true,
      unavailable: availability.status === 'unavailable',
    });
  }
  if (data.length > 0 && entries.length === 0) {
    throw new Error('The model catalogue response could not be read.');
  }
  return entries;
}

function parseRouting(value: unknown): ProductModeRouting {
  const raw = asObject(value);
  if (raw === null) return { kind: 'default' };
  if (raw.kind === 'profile') {
    const profileId = asText(raw.profile_id);
    // A `profile` routing with no id is a shape break, not a default. Reading
    // it as `default` would silently move the mode's meaning.
    if (profileId !== null) return { kind: 'profile', profileId };
  }
  return { kind: 'default' };
}

/** Turn a modes response into modes, or throw — same reasoning as {@link parseCatalogue}. */
export function parseModes(payload: unknown): ProductMode[] {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (!Array.isArray(data)) throw new Error('The product modes response could not be read.');

  const modes: ProductMode[] = [];
  for (const value of data) {
    const raw = asObject(value);
    if (raw === null) continue;
    if (raw.object !== 'product_mode') continue;
    const id = asText(raw.id);
    const label = asText(raw.label);
    if (id === null || label === null) continue;
    modes.push({
      id,
      label,
      description: asText(raw.description) ?? '',
      routing: parseRouting(raw.routing),
      deepResearch: raw.deep_research === true,
    });
  }
  if (data.length > 0 && modes.length === 0) {
    throw new Error('The product modes response could not be read.');
  }
  return modes;
}

/**
 * What a person reads for an entry: the product's word for it, or the
 * catalogue's own.
 *
 * The picker used to label a routing profile with the display name of the alias
 * it came from — "Kaana Lite", "Codea" — which are model names for things that
 * are not models. The catalogue's `displayName` stays as the fallback for a
 * profile no mode names, because inventing a mode for those would be the same
 * category error in the other direction.
 */
export function presentation(
  entry: CatalogueEntry,
  modes: readonly ProductMode[],
): { readonly label: string; readonly description: string } {
  const mode =
    modes.find((m) => m.routing.kind === 'profile' && m.routing.profileId === entry.id) ?? null;
  if (mode === null) return { label: entry.displayName, description: entry.description };
  return { label: mode.label, description: mode.description };
}

/** One row of the webview picker: an identifier to send, and the words for it. */
export interface OfferedMode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/**
 * What the picker offers, in the product's words.
 *
 * `chat_visible` is the product's own visibility decision, read off the
 * response rather than reimplemented here.
 */
export function offeredModes(
  entries: readonly CatalogueEntry[],
  modes: readonly ProductMode[],
): OfferedMode[] {
  return entries
    .filter((entry) => entry.chatVisible)
    .map((entry) => ({ id: entry.id, ...presentation(entry, modes) }));
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

const modeCache = new Map<string, Promise<ProductMode[]>>();

/**
 * The product modes for one API base URL, fetched at most once per URL.
 *
 * Unauthenticated, because a mode is the same for everybody: what a given
 * caller may USE is entitlement, and that is annotated on the catalogue entries
 * a mode routes through rather than on the mode. Rejections evict, for the same
 * reason they do above.
 */
export function fetchProductModes(apiBaseUrl: string): Promise<ProductMode[]> {
  const cached = modeCache.get(apiBaseUrl);
  if (cached !== undefined) return cached;

  const request = (async () => {
    const response = await fetch(`${apiBaseUrl}/catalogue/modes`);
    if (!response.ok) throw new Error(`The product modes request failed (${response.status}).`);
    return parseModes(await response.json());
  })();

  modeCache.set(apiBaseUrl, request);
  request.catch(() => modeCache.delete(apiBaseUrl));
  return request;
}

/**
 * What the webview picker should show, in the product's words.
 *
 * Empty on failure rather than a built-in list: a picker with nothing in it
 * leaves the extension's own preference in charge (`chatProvider` falls back to
 * the `codea.model` setting and then to `PREFERRED_MODEL_ID`), where a built-in
 * list would put a stale name in front of somebody and let them select it.
 */
export async function fetchOfferedModes(
  apiBaseUrl: string,
  accessToken?: string,
): Promise<OfferedMode[]> {
  try {
    const [entries, modes] = await Promise.all([
      fetchCatalogue(apiBaseUrl, accessToken),
      fetchProductModes(apiBaseUrl),
    ]);
    return offeredModes(entries, modes);
  } catch {
    return [];
  }
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
