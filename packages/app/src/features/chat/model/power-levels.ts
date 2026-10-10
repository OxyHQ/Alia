/**
 * Power levels — what a person chooses in Alia instead of a model.
 *
 * A level is one of Oxy's routing profiles (a slug with no `/`). The app sends
 * it as the request's `model`; Oxy picks an available model of that level for
 * each request, cheapest first, and fails over inside the level. The app never
 * names a hosted model. The one exception is a model running on one of the
 * person's OWN devices (`local/<runtime>/<model>`): that is their machine, not
 * a model Alia offers, and it stays selectable while the device is connected.
 *
 * The seven slugs are Oxy's fixed vocabulary, so the app can put words to
 * each one in every language it speaks.
 */

export const POWER_LEVELS = ['auto', 'instant', 'medium', 'high', 'xhigh', 'pro', 'ultra'] as const;
export type PowerLevel = (typeof POWER_LEVELS)[number];

/** Where everyone starts, and what any choice the app no longer offers becomes. */
export const DEFAULT_POWER_LEVEL: PowerLevel = 'auto';

export function isPowerLevel(value: unknown): value is PowerLevel {
  return typeof value === 'string' && (POWER_LEVELS as readonly string[]).includes(value);
}

/** A model served by one of the person's own devices. */
export function isDeviceModelId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('local/') && value.length > 'local/'.length;
}

export interface ModeSelection {
  /** What the selector shows as chosen: a level, or a connected device model. */
  readonly shown: string;
  /** What a request carries as `model`. Always present: the app always says. */
  readonly send: string;
  /**
   * `requested`: the stored choice is sent. `replaced`: it is not offered right
   * now (a device that is not connected, or a value from an older app), so
   * `auto` answers and the selector says so.
   */
  readonly source: 'requested' | 'replaced';
}

/**
 * Resolve a stored choice against what can be sent now.
 *
 * `deviceModelIds` is `undefined` while the person's devices are still being
 * listed: a device model is then kept rather than replaced, so a slow cold
 * start never moves the person off their own machine.
 */
export function resolveModeSelection(
  stored: string | null | undefined,
  deviceModelIds: readonly string[] | undefined,
): ModeSelection {
  if (isPowerLevel(stored)) return { shown: stored, send: stored, source: 'requested' };
  if (
    isDeviceModelId(stored) &&
    (deviceModelIds === undefined || deviceModelIds.includes(stored))
  ) {
    return { shown: stored, send: stored, source: 'requested' };
  }
  return {
    shown: DEFAULT_POWER_LEVEL,
    send: DEFAULT_POWER_LEVEL,
    source: stored === null || stored === undefined || stored === '' ? 'requested' : 'replaced',
  };
}
