/**
 * The model catalogue, as the CLI consumes it (`GET /catalogue`, epic #139
 * workstream 5).
 *
 * The CLI used to bake `kaana-v1-codea` into four command definitions, a session
 * fallback and a shorthand expander. A retired identifier therefore became a 400
 * inside a version somebody had already installed, and `codea --model pro`
 * expanded to `kaana-v1-pro` whether or not such a thing existed. This module is
 * how the CLI asks the server what it offers instead.
 *
 * ## A third implementation of one contract, and why it is not shared
 *
 * `packages/app/lib/hooks/use-catalogue.ts` and
 * `packages/alia-chat/src/lib/catalogue.ts` parse the same surface. Sharing one
 * module across all of them was measured and rejected: `@alia.onl/sdk` ships as
 * RAW SOURCE and `@alia-codea/cli` is a published package (`version` 2.0.2, no
 * `private` flag), so neither can depend on an unpublished workspace package —
 * a consumer's resolver would fail on `workspace:*`. The alternative, publishing
 * a fourth package to hold sixty lines, buys a release process rather than
 * safety.
 *
 * The parsing RULES are the shared thing, and they are stated once, in the app's
 * module. Both rules matter and both are about not inventing: an entry whose
 * `object` is neither known value is dropped, and a response whose entries all
 * fail to parse throws rather than reading as an empty catalogue.
 */

import { config } from './config.js';
import { accessToken } from './oxy-session.js';

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

/** Which routing profile a request made in this mode goes through. */
export type ProductModeRouting =
  | { readonly kind: 'profile'; readonly profileId: string }
  | { readonly kind: 'default' };

/**
 * A product mode — the words a person reads for a routing profile.
 *
 * A mode LABELS a profile; it is never a selectable identifier, because nothing
 * in the request path consumes a `mode:*` id. The rule is stated once, at
 * length, in `packages/app/lib/hooks/use-product-modes.ts`.
 */
export interface ProductMode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly routing: ProductModeRouting;
  readonly deepResearch: boolean;
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
 * The CLI printed `Model: Kaana Lite` — the display name of the alias a routing
 * profile came from, under the word "model". #139's non-negotiable invariant
 * says a routing policy is never presented as an Alia-owned model, and that was
 * both halves of the prohibition at once. `displayName` remains the fallback for
 * a profile no mode names, because inventing one for the capability profiles
 * would be the same category error in the other direction.
 */
export function presentation(
  entry: CatalogueEntry,
  modes: readonly ProductMode[],
): { readonly label: string; readonly description: string } {
  const mode =
    modes.find((m) => m.routing.kind === 'profile' && m.routing.profileId === entry.id) ?? null;
  if (mode === null) return { label: entry.displayName, description: '' };
  return { label: mode.label, description: mode.description };
}

let cachedModes: Promise<ProductMode[]> | null = null;

/**
 * The product modes, fetched at most once per process.
 *
 * Unauthenticated, because a mode is the same for everybody: what a caller may
 * USE is entitlement, annotated on the catalogue entries a mode routes through
 * rather than on the mode. Rejections evict, as above.
 */
export function fetchModes(): Promise<ProductMode[]> {
  if (cachedModes !== null) return cachedModes;
  const request = (async () => {
    const response = await fetch(`${config.get('apiBaseUrl')}/catalogue/modes`);
    if (!response.ok) throw new Error(`The product modes request failed (${response.status}).`);
    return parseModes(await response.json());
  })();
  cachedModes = request;
  request.catch(() => {
    cachedModes = null;
  });
  return request;
}

/**
 * The product's word for an identifier, or the identifier itself.
 *
 * Never throws and never blocks a command: an unreadable catalogue leaves the
 * identifier showing, which is honest rather than pretty — the same rule the
 * `selection` state in `app.tsx` already follows before the catalogue arrives.
 */
export async function labelFor(id: string): Promise<string> {
  try {
    const [entries, modes] = await Promise.all([fetchCatalogue(), fetchModes()]);
    const entry = entries.find((candidate) => candidate.id === id);
    return entry === undefined ? id : presentation(entry, modes).label;
  } catch {
    return id;
  }
}

let cached: Promise<CatalogueEntry[]> | null = null;

/**
 * The catalogue, fetched at most once per process.
 *
 * A rejected promise is evicted, so one cold-start network failure does not
 * make the CLI permanently blind for the rest of its run.
 */
export function fetchCatalogue(): Promise<CatalogueEntry[]> {
  if (cached !== null) return cached;
  const request = (async () => {
    // The catalogue takes optional auth: signed out it still lists what the
    // product offers, and the entitlement annotations simply describe nobody.
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

export interface ModelSelection {
  readonly requestedId: string;
  readonly effectiveId: string;
  readonly source: 'requested' | 'replaced';
}

/**
 * Resolve a requested identifier against the catalogue.
 *
 * Same three deliberate non-behaviours as every other implementation of this:
 * no catalogue leaves the choice alone, an entry reported unavailable is still
 * honoured because the server already falls back among the models behind it,
 * and the configured preference is checked like any other identifier rather than
 * trusted.
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
    (preferredId === undefined ? undefined : offered.find((e) => e.id === preferredId)) ??
    offered.find((entry) => !entry.unavailable) ??
    offered[0];
  if (replacement === undefined) {
    return { requestedId, effectiveId: requestedId, source: 'requested' };
  }
  return { requestedId, effectiveId: replacement.id, source: 'replaced' };
}

/**
 * What the user typed after `/model`, turned into an identifier the server knows.
 *
 * This replaces `args[0].startsWith('alia-') ? args[0] : \`kaana-v1-${args[0]}\``,
 * which hardcoded the naming SCHEME rather than a single identifier — worse than
 * a hardcoded default, because it silently produced identifiers that had never
 * existed. Matching is: exact id, then case-insensitive display name, then a
 * unique suffix match, so `pro` still finds the entry actually called
 * `kaana-v1-pro` WITHOUT the CLI knowing that name in advance. An ambiguous or
 * unknown shorthand returns `null` and the caller says so, rather than sending a
 * guess.
 */
export function matchShorthand(
  shorthand: string,
  entries: readonly CatalogueEntry[],
): CatalogueEntry | null {
  const offered = entries.filter((entry) => entry.chatVisible);
  const needle = shorthand.trim().toLowerCase();
  if (needle === '') return null;

  const exact = offered.find((entry) => entry.id.toLowerCase() === needle);
  if (exact !== undefined) return exact;

  const byName = offered.filter((entry) => entry.displayName.toLowerCase() === needle);
  if (byName.length === 1 && byName[0] !== undefined) return byName[0];

  const bySuffix = offered.filter((entry) => entry.id.toLowerCase().endsWith(`-${needle}`));
  if (bySuffix.length === 1 && bySuffix[0] !== undefined) return bySuffix[0];

  return null;
}

/**
 * The identifier a request should carry. Never throws — an unreadable catalogue
 * leaves the requested identifier alone, which is the same answer as "not loaded
 * yet", and the server remains the authority either way.
 */
export async function resolveModelId(requestedId: string): Promise<string> {
  try {
    const entries = await fetchCatalogue();
    return resolveSelection(requestedId, entries, config.get('defaultModel')).effectiveId;
  } catch {
    return requestedId;
  }
}

/** How an entry should be shown, falling back to the identifier itself. */
export async function displayNameFor(modelId: string): Promise<string> {
  try {
    const entries = await fetchCatalogue();
    return entries.find((entry) => entry.id === modelId)?.displayName ?? modelId;
  } catch {
    return modelId;
  }
}
