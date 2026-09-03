/**
 * Product modes — the language a person picks in (`GET /catalogue/modes`, epic
 * #139 workstream 5).
 *
 * ## What this is for
 *
 * The picker used to label a routing profile with the display name of the alias
 * it came from — "Kaana V1 Pro Max", "Kaana Lite". Those are model names for
 * things that are not models, which is the habit ADR 0003 exists to end. A
 * product mode is where the product's own words live: Automatic, Fast,
 * Balanced, Maximum quality, Coding, Deep research.
 *
 * ## A mode is a LABEL for a profile, not a selectable identifier
 *
 * This is the distinction that decides the whole design, and it is measured
 * rather than assumed: `lib/chat/request-context.ts` accepts a `profile:*` id
 * or a legacy `alia-*` id and refuses anything else with `unknown_routing_profile`.
 * Nothing in the request path consumes a `mode:*` id — `PRODUCT_MODES` is
 * published by `routes/catalogue.ts` and read by nobody else. So a picker that
 * sent `mode:fast` would 400.
 *
 * The modes therefore supply WORDS for the profiles the picker already offers.
 * `mode:fast` says "the profile `profile:lite` is what Fast means"; the picker
 * renders "Fast" and still sends `profile:lite`.
 *
 * Every mode carries one exact profile identity. Automatic and Deep research
 * are found by their exact `mode:*` IDs when their own labels are needed; they
 * are never inferred from array position or a `default` discriminant.
 */

import { useQuery } from '@tanstack/react-query';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';
import type { CatalogueEntry } from './use-catalogue';

/** Which routing profile a request made in this mode goes through. */
export type ProductModeRouting = { readonly kind: 'profile'; readonly profileId: string };

export interface ProductMode {
  /** `mode:*`. Never sent as a request `model` — see the note above. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly routing: ProductModeRouting;
  /** The `deepResearch` request flag this mode sets. */
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

function parseRouting(value: unknown): ProductModeRouting | null {
  const raw = asObject(value);
  if (raw === null) return null;
  if (raw.kind === 'profile') {
    const profileId = asText(raw.profile_id);
    if (profileId !== null && profileId !== '' && profileId.trim() === profileId) {
      return { kind: 'profile', profileId };
    }
  }
  return null;
}

function parseMode(value: unknown): ProductMode | null {
  const raw = asObject(value);
  if (raw === null) return null;
  if (raw.object !== 'product_mode') return null;

  const id = asText(raw.id);
  const label = asText(raw.label);
  const routing = parseRouting(raw.routing);
  if (
    id === null || id === '' || id.trim() !== id || !id.startsWith('mode:')
    || label === null || label === '' || label.trim() !== label
    || routing === null
  ) return null;

  return {
    id,
    label,
    description: asText(raw.description) ?? '',
    routing,
    deepResearch: raw.deep_research === true,
  };
}

/**
 * Turn a modes response into entries, or throw.
 *
 * Throwing beats returning an empty list for the same reason it does in
 * `use-catalogue.ts`: "no modes" and "we failed to read the modes" are
 * indistinguishable to every consumer, and one of them means the picker shows a
 * profile its own product has words for.
 */
export function parseModes(payload: unknown): ProductMode[] {
  const body = asObject(payload);
  const data = body === null ? null : body.data;
  if (!Array.isArray(data)) throw new Error('The product modes response could not be read.');

  const modes: ProductMode[] = [];
  for (const value of data) {
    const mode = parseMode(value);
    if (mode === null) throw new Error('The product modes response could not be read.');
    modes.push(mode);
  }
  return modes;
}

/**
 * The product modes.
 *
 * Unauthenticated and unfiltered, because a mode is the same for everybody —
 * what a given caller may USE is entitlement, and that is annotated on the
 * catalogue entries a mode routes through, not on the mode. So this is cached
 * globally rather than per user, unlike `useCatalogue`.
 */
export function useProductModes() {
  return useQuery<ProductMode[]>({
    queryKey: queryKeys.catalogue.modes(),
    queryFn: async () => parseModes((await apiClient.get('/catalogue/modes')).data),
    staleTime: 1000 * 60 * 60,
    retry: 2,
  });
}

const PRESENTATION_MODE_IDS: ReadonlySet<string> = new Set([
  'mode:fast',
  'mode:balanced',
  'mode:maximum-quality',
  'mode:coding',
]);

/**
 * The product's word for a routing profile, or `null` when it has none.
 *
 * `null` rather than a fallback, so the caller decides what an unnamed profile
 * looks like. Substituting the profile id here would put `profile:v1-vision` in
 * front of a person as though it were a product name, which is the same
 * category error as the alias display names this replaces.
 */
export function modeForProfile(
  profileId: string,
  modes: readonly ProductMode[] | undefined,
): ProductMode | null {
  if (modes === undefined) return null;
  let match: ProductMode | null = null;
  for (const mode of modes) {
    if (!PRESENTATION_MODE_IDS.has(mode.id) || mode.routing.profileId !== profileId) continue;
    if (match !== null) return null;
    match = mode;
  }
  return match;
}

/** Resolve a product concept by its exact committed identity. */
export function modeById(
  id: string,
  modes: readonly ProductMode[] | undefined,
): ProductMode | null {
  return modes?.find((mode) => mode.id === id) ?? null;
}

/**
 * What a person reads for an entry: the product's word for it, or the
 * catalogue's own.
 *
 * A routing profile that a product mode selects is shown as that mode —
 * "Fast", "Balanced", "Maximum quality", "Coding" — because those are the
 * product's words for the decision a person is actually making. The alias
 * display names this replaces ("Kaana V1 Pro Max", "Kaana Lite") were model names
 * for things that are not models, which is the habit ADR 0003 ends.
 *
 * The catalogue's own `displayName` remains the fallback, and it is a real
 * fallback rather than a formality: `profile:v1-vision` and the other
 * capability profiles have no mode, and inventing one for them would be the
 * same invention in the other direction.
 */
export function presentation(
  entry: CatalogueEntry,
  modes: readonly ProductMode[] | undefined,
): { label: string; description: string } {
  const mode = entry.kind === 'routing_profile' ? modeForProfile(entry.id, modes) : null;
  if (mode === null) return { label: entry.displayName, description: entry.description };
  return { label: mode.label, description: mode.description };
}
