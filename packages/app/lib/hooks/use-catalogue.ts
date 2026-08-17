/**
 * The model catalogue, as the app consumes it (`GET /catalogue`, epic #139
 * workstream 5).
 *
 * The picker used to read `GET /v1/models`, which serializes every entry as
 * `object: "model"`. ADR 0003 invariant 1 says a routing profile is never
 * presented as a model, and `docs/migration/alias-migration-map.json` records
 * that all thirteen `alia-*` identifiers are routing profiles — so the old
 * surface told the picker the one thing it must not repeat to a user.
 * `/v1/models` is frozen for external callers and stays as it is; this module
 * reads the truthful surface instead.
 *
 * Two rules govern the parsing below, and both are about not inventing:
 *
 *  - **An entry whose `object` is neither known value is dropped.** Defaulting
 *    it to either kind would break invariant 1 in one direction or the other.
 *  - **A capability value we do not recognise becomes `unknown`, never
 *    `never`.** They are different claims: greying out a working feature is a
 *    bug, and reporting absence for something merely unmeasured produces
 *    exactly that.
 */

import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import apiClient from '../api/client';
import { queryKeys } from './query-keys';
import { DEFAULT_MODEL_ID } from '../config';

/**
 * How available a capability is across everything an entry can route to.
 *
 * Four states rather than a boolean because a routing profile answers from a
 * different model each time, so "does it support vision" genuinely has three
 * true answers plus "we do not know".
 */
export type CapabilityAvailability = 'always' | 'sometimes' | 'never' | 'unknown';

/** A token bound across an entry's candidates. Equal ends for a concrete model. */
export interface TokenBound {
  readonly guaranteed: number;
  readonly upTo: number;
}

export interface CatalogueCapabilities {
  readonly tools: CapabilityAvailability;
  readonly vision: CapabilityAvailability;
  readonly audio: CapabilityAvailability;
  readonly reasoning: CapabilityAvailability;
  readonly structuredOutput: CapabilityAvailability;
  /** `null` means unknown, and must render as unknown rather than as absent. */
  readonly contextWindow: TokenBound | null;
  readonly maxOutput: TokenBound | null;
}

interface CatalogueEntryCommon {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly emoji: string | null;
  /** Product policy: whether the chat picker surfaces this entry. */
  readonly chatVisible: boolean;
  readonly capabilities: CatalogueCapabilities;
  /** The server states this as a claim; an entry that omits it is not called unavailable. */
  readonly unavailable: boolean;
  readonly legacy: boolean;
  /** Name of the cheapest plan that grants this entry, or `null` when free or unknown. */
  readonly requiredPlan: string | null;
  /**
   * The date the identifier stops working, when one has been announced.
   *
   * All thirteen identifiers carry a deprecation today and none carries a
   * sunset date, so the deprecation itself says nothing an end user can act on
   * — the compatibility window keeps every one of them working. The date is
   * the part worth showing, so the date is the part kept.
   */
  readonly sunsetAt: string | null;
}

/** A product-owned policy that picks a model on the product's behalf, per request. */
export interface RoutingProfileEntry extends CatalogueEntryCommon {
  readonly kind: 'routing_profile';
  /** Distinct models the policy ranks over, or `null` when the server did not say. */
  readonly selectsAmong: number | null;
}

/**
 * A reference to one named model.
 *
 * `publisher` and `model` are both `null` for every entry the catalogue serves
 * today: publisher attribution does not exist in Alia's data, and the migration
 * map records that as a finding rather than an omission. They are rendered when
 * present and nothing is substituted when absent.
 */
export interface ModelEntry extends CatalogueEntryCommon {
  readonly kind: 'model';
  readonly publisher: string | null;
  readonly model: string | null;
}

export type CatalogueEntry = RoutingProfileEntry | ModelEntry;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asCapability(value: unknown): CapabilityAvailability {
  if (value === 'always' || value === 'sometimes' || value === 'never') return value;
  return 'unknown';
}

function asTokenBound(value: unknown): TokenBound | null {
  const bound = asObject(value);
  if (bound === null) return null;
  const { guaranteed, up_to: upTo } = bound;
  if (typeof guaranteed !== 'number' || typeof upTo !== 'number') return null;
  return { guaranteed, upTo };
}

function parseEntry(value: unknown): CatalogueEntry | null {
  const raw = asObject(value);
  if (raw === null) return null;

  const id = asText(raw.id);
  const displayName = asText(raw.display_name);
  if (id === null || displayName === null) return null;

  const capabilities = asObject(raw.capabilities) ?? {};
  const availability = asObject(raw.availability) ?? {};
  const entitlement = asObject(raw.entitlement);
  const deprecation = asObject(raw.deprecation);

  const common: CatalogueEntryCommon = {
    id,
    displayName,
    description: asText(raw.description) ?? '',
    emoji: asText(raw.emoji),
    chatVisible: raw.chat_visible === true,
    capabilities: {
      tools: asCapability(capabilities.tools),
      vision: asCapability(capabilities.vision),
      audio: asCapability(capabilities.audio),
      reasoning: asCapability(capabilities.reasoning),
      structuredOutput: asCapability(capabilities.structured_output),
      contextWindow: asTokenBound(capabilities.context_window),
      maxOutput: asTokenBound(capabilities.max_output),
    },
    unavailable: availability.status === 'unavailable',
    legacy: availability.legacy === true,
    requiredPlan: entitlement?.state === 'known' ? asText(entitlement.required_plan) : null,
    sunsetAt: deprecation === null ? null : asText(deprecation.sunset_at),
  };

  if (raw.object === 'model') {
    return { ...common, kind: 'model', publisher: asText(raw.publisher), model: asText(raw.model) };
  }
  if (raw.object === 'routing_profile') {
    const selectsAmong = raw.selects_among;
    return {
      ...common,
      kind: 'routing_profile',
      selectsAmong: typeof selectsAmong === 'number' ? selectsAmong : null,
    };
  }
  return null;
}

/**
 * Turn a catalogue response into entries, or throw.
 *
 * Throwing rather than returning an empty list is the point: an empty
 * catalogue and a catalogue we failed to read look identical to every consumer
 * below, and one of them means "offer the user nothing". A response whose
 * entries all fail to parse is a shape break, not an empty product.
 */
function parseCatalogue(payload: unknown): CatalogueEntry[] {
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

/**
 * The catalogue for the current caller.
 *
 * Unauthenticated on purpose — the picker renders signed out, and the route
 * takes optional auth. The token the api client attaches when there is one is
 * what makes the entitlement annotations describe THIS user, which is why the
 * cache is keyed by user id: a signed-out list must not survive a sign-in.
 */
export function useCatalogue() {
  const { user } = useOxy();
  return useQuery<CatalogueEntry[]>({
    queryKey: queryKeys.catalogue.list(user?.id ?? null),
    queryFn: async () => parseCatalogue((await apiClient.get('/catalogue')).data),
    staleTime: 1000 * 60 * 5,
    retry: 2,
  });
}

export interface ModelSelection {
  /** What the user chose, which is what the picker keeps showing as chosen. */
  readonly requestedId: string;
  /** What a request should carry. Differs from `requestedId` only when replaced. */
  readonly effectiveId: string;
  /** The catalogue entry behind `effectiveId`, or `null` while the catalogue is not readable. */
  readonly entry: CatalogueEntry | null;
  /** `replaced` when the requested identifier is not one the catalogue offers. */
  readonly source: 'requested' | 'replaced';
}

/**
 * Resolve a stored selection against the catalogue.
 *
 * The selection is persisted and the catalogue is not, so a selection can name
 * an identifier the product no longer offers — a retired one, or one this
 * build's configured default points at before the catalogue has loaded. Sending
 * an identifier the server does not register is a 400, so the case has to have
 * a defined answer rather than a hope.
 *
 * What it does NOT do, deliberately:
 *
 *  - **No catalogue yet — loading, or the request failed — leaves the choice
 *    alone.** Replacing on missing data would change the model under the user
 *    on any slow cold start, which is the same wrong answer as a retirement.
 *  - **An entry the catalogue reports UNAVAILABLE is still honoured.** That is
 *    a health signal about the models behind an entry, and the server already
 *    falls back among them; picking a different entry on the user's behalf is a
 *    product decision nobody made. The picker shows the state instead.
 *  - **An entry the caller's plan does not cover is still honoured.** Sending
 *    it answers with `MODEL_NOT_IN_PLAN` and the existing upgrade dialog, which
 *    is a working product flow; silently downgrading the model would replace it
 *    with a quieter one.
 */
export function resolveSelection(
  requestedId: string,
  entries: readonly CatalogueEntry[] | undefined,
): ModelSelection {
  if (entries === undefined) {
    return { requestedId, effectiveId: requestedId, entry: null, source: 'requested' };
  }

  // Validity is membership of what this surface offers, not of the whole
  // catalogue: the picker and the `switchModel` tool are the only writers of a
  // selection and both are already confined to chat-visible entries.
  const offered = entries.filter((entry) => entry.chatVisible);
  const requested = offered.find((entry) => entry.id === requestedId);
  if (requested !== undefined) {
    return { requestedId, effectiveId: requestedId, entry: requested, source: 'requested' };
  }

  const replacement =
    offered.find((entry) => entry.id === DEFAULT_MODEL_ID) ??
    offered.find((entry) => !entry.unavailable) ??
    offered[0];
  if (replacement === undefined) {
    return { requestedId, effectiveId: requestedId, entry: null, source: 'requested' };
  }
  return { requestedId, effectiveId: replacement.id, entry: replacement, source: 'replaced' };
}
