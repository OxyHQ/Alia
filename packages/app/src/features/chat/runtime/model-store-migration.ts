import {
  DEFAULT_POWER_LEVEL,
  isDeviceModelId,
  isPowerLevel,
  type PowerLevel,
} from '@/features/chat/model/power-levels';

/** What `migrateModelState` returns; the store's persisted half. */
export interface PersistedModelState {
  /** A power level, or a model on one of the person's own devices (`local/…`). */
  selectedLevel: PowerLevel | string;
  webSearch: boolean;
}

/**
 * The level an older store's effort choice stood for, when it stood for one.
 *
 * Before v3 the effort scale was `instant | medium | high | max`, and v3
 * collapsed `instant` into "the model's own default" and `max` into `high`.
 * Those two ends are exactly what the levels now name: `instant` is the
 * fastest, cheapest level and `max` the most capable one, `ultra`. Everything
 * in between was a knob on a model the person no longer picks, so it carries
 * no level of its own.
 */
function levelOfRetiredEffort(stored: unknown): PowerLevel | null {
  if (stored === 'instant') return 'instant';
  if (stored === 'max') return 'ultra';
  return null;
}

/**
 * Any persisted state before v4, as v4.
 *
 * v4 replaced the model picker with power levels: the person chooses how much
 * power a turn gets, and Oxy chooses the model. So:
 *
 *  - **Any stored model** — a real `publisher/model` (v3), one of Alia's old
 *    invented modes or routing profiles (`mode:*`, `route:*`, `profile:*`), a
 *    retired `alia-*` alias, or nothing — becomes `auto`. None is guessed into
 *    a level: a model's name says nothing reliable about its power.
 *  - **The old `instant` / `max` efforts** (stores before v3) become `instant`
 *    and `ultra`, the two ends they named.
 *  - **A model on the person's own device** (`local/…`) survives: it is their
 *    machine, not a model Alia offers.
 *  - A v4 level survives as itself. The effort and the pinned models are
 *    dropped: a level carries its own effort, and there are no models to pin.
 */
export function migrateModelState(persisted: unknown, version: number): PersistedModelState {
  const state = (typeof persisted === 'object' && persisted !== null ? persisted : {}) as Record<string, unknown>;
  const webSearch = typeof state.webSearch === 'boolean' ? state.webSearch : true;

  if (version >= 4 && (isPowerLevel(state.selectedLevel) || isDeviceModelId(state.selectedLevel))) {
    return { selectedLevel: state.selectedLevel, webSearch };
  }
  if (isDeviceModelId(state.selectedModel)) {
    return { selectedLevel: state.selectedModel, webSearch };
  }
  const fromEffort = version < 3 ? levelOfRetiredEffort(state.reasoningEffort) : null;
  return { selectedLevel: fromEffort ?? DEFAULT_POWER_LEVEL, webSearch };
}
