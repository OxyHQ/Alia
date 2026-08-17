/**
 * The model catalogue, read from the API rather than restated here.
 *
 * ## Why this hook exists at all
 *
 * `documentation/models.tsx` used to carry a `const models = [...]` naming four
 * `alia-*` identifiers, calling them "models", and quoting context windows and
 * output limits that matched nothing in the routing table — `alia-lite` was
 * documented at 8K context when its candidates carry far more. Every number on
 * that page was invented, and nothing could tell you, because there was nothing
 * to compare it against.
 *
 * Two defects in one, and they have one fix. #139 workstream 4 removed the
 * aliases from every served surface — `GET /v1/models` is an empty list and
 * `GET /catalogue` is keyed by routing profile — so a second hardcoded list in
 * the developer documentation was both *wrong* and *describing them as models*,
 * which is the thing the epic forbids in as many words.
 *
 * Reading the catalogue fixes both at once and cannot drift again: change the
 * routing and the page changes with it.
 *
 * ## Unauthenticated on purpose
 *
 * `GET /catalogue` is mounted with `optionalAuth`, and the documentation is
 * public. Without a caller the `entitlement` block reports `entitled: null` —
 * "nobody's entitlement is being described", which is not the same as "not
 * entitled" — so the page renders which plan grants an entry without claiming
 * anything about the reader.
 */

import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api/client';

/** How available a capability is across everything an entry can route to. */
export type CapabilityAvailability = 'always' | 'sometimes' | 'never' | 'unknown';

/** A token bound across the candidate set: the guaranteed minimum and the best case. */
export interface TokenBound {
  guaranteed: number;
  upTo: number;
}

export interface CatalogueCapabilities {
  tools: CapabilityAvailability;
  vision: CapabilityAvailability;
  audio: CapabilityAvailability;
  reasoning: CapabilityAvailability;
  structuredOutput: CapabilityAvailability;
  contextWindow: TokenBound | null;
  maxOutput: TokenBound | null;
}

export interface CatalogueEntry {
  id: string;
  /**
   * `routing_profile` when the entry selects among several models,
   * `model` when it resolves to exactly one. A client switches on this rather
   * than decoding the id, which is the whole reason the field exists.
   */
  kind: 'model' | 'routing_profile';
  displayName: string;
  description: string;
  category: string;
  capabilities: CatalogueCapabilities;
  available: boolean;
  legacy: boolean;
  creditMultiplier: number;
  /** Cheapest plan that grants it, or `null` when a free plan does. */
  requiredPlan: string | null;
  /** Distinct models the policy ranks over. `null` for a concrete model reference. */
  selectsAmong: number | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asAvailability(value: unknown): CapabilityAvailability {
  return value === 'always' || value === 'sometimes' || value === 'never' ? value : 'unknown';
}

function asBound(value: unknown): TokenBound | null {
  const raw = asObject(value);
  if (raw === null) return null;
  const guaranteed = raw.guaranteed;
  const upTo = raw.up_to;
  if (typeof guaranteed !== 'number' || typeof upTo !== 'number') return null;
  return { guaranteed, upTo };
}

/**
 * Parse one wire entry, or `null` when it is not one.
 *
 * Defensive rather than trusting, because this page is documentation: a
 * half-parsed entry rendered with blanks teaches a developer something false,
 * and dropping it teaches them nothing, which is the better failure.
 */
function parseEntry(raw: unknown): CatalogueEntry | null {
  const entry = asObject(raw);
  if (entry === null) return null;
  const { id, object } = entry;
  if (typeof id !== 'string' || (object !== 'model' && object !== 'routing_profile')) return null;

  const capabilities = asObject(entry.capabilities) ?? {};
  const availability = asObject(entry.availability) ?? {};
  const entitlement = asObject(entry.entitlement) ?? {};
  const pricing = asObject(entry.pricing) ?? {};

  return {
    id,
    kind: object,
    displayName: typeof entry.display_name === 'string' ? entry.display_name : id,
    description: typeof entry.description === 'string' ? entry.description : '',
    category: typeof entry.category === 'string' ? entry.category : 'general',
    capabilities: {
      tools: asAvailability(capabilities.tools),
      vision: asAvailability(capabilities.vision),
      audio: asAvailability(capabilities.audio),
      reasoning: asAvailability(capabilities.reasoning),
      structuredOutput: asAvailability(capabilities.structured_output),
      contextWindow: asBound(capabilities.context_window),
      maxOutput: asBound(capabilities.max_output),
    },
    available: availability.status === 'available',
    legacy: availability.legacy === true,
    creditMultiplier: typeof pricing.credit_multiplier === 'number' ? pricing.credit_multiplier : 1,
    requiredPlan: typeof entitlement.required_plan === 'string' ? entitlement.required_plan : null,
    selectsAmong: typeof entry.selects_among === 'number' ? entry.selects_among : null,
  };
}

export function useCatalogue() {
  return useQuery({
    queryKey: ['catalogue'],
    queryFn: async (): Promise<CatalogueEntry[]> => {
      const { data } = await apiClient.get('/catalogue');
      const entries = asObject(data)?.data;
      if (!Array.isArray(entries)) return [];
      return entries.map(parseEntry).filter((entry): entry is CatalogueEntry => entry !== null);
    },
    // Documentation, not a live dashboard: the catalogue changes on a deploy.
    staleTime: 5 * 60 * 1000,
  });
}
