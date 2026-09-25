import type { EffortLevel } from '@/features/chat/runtime/use-catalogue';

/** What `migrateModelState` returns; the store's persisted half. */
export interface PersistedModelState {
  selectedModel: string | null;
  reasoningEffort: EffortLevel | null;
  webSearch: boolean;
  pinnedModels: string[];
}

/**
 * Alia's own invented choices — product modes (`mode:*`), routing profiles
 * (`route:*`, `profile:*`) and the retired `alia-*` aliases. None is a model.
 */
function isRetiredChoice(id: string): boolean {
  return id.startsWith('mode:') || id.startsWith('route:') || id.startsWith('profile:') || id.startsWith('alia-');
}

/**
 * v2 → v3: the efforts were `instant | medium | high | max` and are now the
 * provider scale `low | medium | high`. `instant` meant "don't think", which the
 * new scale has no word for, so it becomes the model's own default; `max` is
 * the top of the scale.
 */
function migrateEffort(stored: unknown): EffortLevel | null {
  if (stored === 'low' || stored === 'medium') return stored;
  if (stored === 'high' || stored === 'max') return 'high';
  return null;
}

/**
 * Any persisted state before v3, as v3.
 *
 * Every stored state before v3 names one of Alia's invented modes or routing
 * profiles (`mode:*`, `route:*`) or a retired alias. None is a model
 * any more, so each becomes `null` — the server's default — rather than a guess
 * at which real model it "meant". A real model or a device model survives.
 */
export function migrateModelState(persisted: unknown, version: number): PersistedModelState {
  const state = (typeof persisted === 'object' && persisted !== null ? persisted : {}) as Record<string, unknown>;
  const stored = state.selectedModel;
  const selectedModel = typeof stored === 'string' && stored !== '' && !isRetiredChoice(stored) ? stored : null;
  // v0/v1 kept a boolean; v1 → v2 made it `medium`, the smallest budget, and
  // it still is.
  const reasoningEffort =
    version < 2 ? (state.thinkingMode === true ? 'medium' : null) : migrateEffort(state.reasoningEffort);

  return {
    selectedModel,
    reasoningEffort,
    webSearch: typeof state.webSearch === 'boolean' ? state.webSearch : true,
    pinnedModels: Array.isArray(state.pinnedModels)
      ? state.pinnedModels.filter((id): id is string => typeof id === 'string' && !isRetiredChoice(id))
      : [],
  };
}
