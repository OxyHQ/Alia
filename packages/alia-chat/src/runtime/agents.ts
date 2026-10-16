import { useOxy } from '@oxy.so/services/ui/client';
import { useQuery } from '@tanstack/react-query';
import { useAliaApi } from './api';
import { aliaQueryKeys } from './query-keys';
import { API_ROUTES } from './routes';

/**
 * The agent a chat is opened on, as `GET /v1/agents/:id/profile` answers it
 * (`docs/agent-embedding.md` §1). Alia herself has no profile: she is the lead when no agent is
 * named.
 */
export interface AliaAgentProfile {
  id: string;
  name: string;
  handle?: string;
  /** Its look, as Oxy stores a character (JSON); drawn through `readAgentCharacter`. */
  character?: unknown;
  color?: string;
  description?: string;
  /** What the empty chat says; omitted, the chat's own greeting. */
  greeting?: string;
  /** The lines offered over the composer of an empty chat. */
  starters: AliaAgentStarter[];
  access?: 'private' | 'public';
  /** Which of Alia's features this agent gates behind an app's own check. */
  features: Array<{ key: string; gated: boolean }>;
}

export interface AliaAgentStarter {
  title: string;
  prompt: string;
}

/** One of Alia's features, for one agent and the person present (`GET /v1/agents/:id/features`). */
export interface AliaAgentFeature {
  key: string;
  state: 'available' | 'locked';
  /** How many uses are left, when the publishing app counts them. */
  remaining?: number;
}

/** The feature keys the chat itself reads: the attach menu's two rows. */
export const ALIA_FEATURES = {
  documents: 'attachments.documents',
  images: 'attachments.images',
} as const;

const FIVE_MINUTES = 1000 * 60 * 5;

/** A string, or nothing: the profile is read field by field rather than cast. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** The profile the server sent, kept only where it has the shape the contract names. */
export function readAgentProfile(value: unknown): AliaAgentProfile | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id);
  const name = text(raw.name);
  if (id === undefined || name === undefined) return null;
  const starters = Array.isArray(raw.starters)
    ? raw.starters.flatMap((starter): AliaAgentStarter[] => {
        if (starter === null || typeof starter !== 'object') return [];
        const { title, prompt } = starter as Record<string, unknown>;
        const line = text(prompt);
        return line === undefined ? [] : [{ title: text(title) ?? line, prompt: line }];
      })
    : [];
  const features = Array.isArray(raw.features)
    ? raw.features.flatMap((feature): Array<{ key: string; gated: boolean }> => {
        if (feature === null || typeof feature !== 'object') return [];
        const { key, gated } = feature as Record<string, unknown>;
        return typeof key === 'string' ? [{ key, gated: gated === true }] : [];
      })
    : [];
  return {
    id,
    name,
    handle: text(raw.handle),
    character: raw.character ?? undefined,
    color: text(raw.color),
    description: text(raw.description),
    greeting: text(raw.greeting),
    starters,
    access: raw.access === 'public' || raw.access === 'private' ? raw.access : undefined,
    features,
  };
}

/** The feature states the server sent; an entry of any other shape is not a state. */
export function readAgentFeatures(value: unknown): AliaAgentFeature[] {
  const list =
    value !== null && typeof value === 'object'
      ? (value as { features?: unknown }).features
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((feature): AliaAgentFeature[] => {
    if (feature === null || typeof feature !== 'object') return [];
    const { key, state, remaining } = feature as Record<string, unknown>;
    if (typeof key !== 'string' || (state !== 'available' && state !== 'locked')) return [];
    return [{ key, state, ...(typeof remaining === 'number' ? { remaining } : {}) }];
  });
}

/** The profile of the agent `agentId`, or nothing for Alia (no id) and while it loads. */
export function useAgentProfile(agentId: string | undefined) {
  const { isAuthenticated } = useOxy();
  const api = useAliaApi();
  return useQuery({
    queryKey: aliaQueryKeys.agents.profile(agentId ?? ''),
    queryFn: async () =>
      readAgentProfile((await api.get<unknown>(API_ROUTES.agents.profile(agentId ?? ''))).data),
    enabled: agentId !== undefined && isAuthenticated,
    staleTime: FIVE_MINUTES,
    retry: 1,
  });
}

/**
 * What of Alia's features the agent `agentId` offers the person present. Alia (no id) gates
 * nothing, so she has no answer to wait for; see `featureRows` for what the chat makes of it.
 */
export function useAgentFeatures(agentId: string | undefined) {
  const { isAuthenticated } = useOxy();
  const api = useAliaApi();
  return useQuery({
    queryKey: aliaQueryKeys.agents.features(agentId ?? ''),
    queryFn: async () =>
      readAgentFeatures((await api.get<unknown>(API_ROUTES.agents.features(agentId ?? ''))).data),
    enabled: agentId !== undefined && isAuthenticated,
    // A gate's state moves with the person's plan in another app: read it each time the chat opens.
    staleTime: 0,
    retry: 1,
  });
}

/** How an attachment feature is offered: attached, an upsell, or not at all. */
export type FeatureOffer = 'available' | 'locked' | 'absent';

/**
 * What the attach menu offers for `key`. Alia's own chat (`features === undefined`) offers every
 * attachment; an agent offers what its feature answer lists — `locked` is still offered, as the
 * host's upsell — and nothing it does not list.
 */
export function featureOffer(
  features: readonly AliaAgentFeature[] | undefined,
  key: string,
): FeatureOffer {
  if (features === undefined) return 'available';
  return features.find((feature) => feature.key === key)?.state ?? 'absent';
}
