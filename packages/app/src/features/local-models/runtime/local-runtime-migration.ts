export type LocalRuntimeConsent = 'unasked' | 'granted' | 'declined';

type PersistedLocalRuntimeState = Record<string, unknown> & {
  enabled?: boolean;
  consent?: LocalRuntimeConsent;
};

/**
 * Convert the v1 automatic-probing flag into v2's explicit consent state.
 *
 * `enabled: false` could only be persisted after the person turned discovery
 * off, so asking again would erase an opt-out. `true` was the automatic
 * default, and an absent value carries no decision, so both still need the new
 * consent prompt.
 */
export function migrateLocalRuntimeState(persisted: unknown): PersistedLocalRuntimeState {
  const state: PersistedLocalRuntimeState =
    persisted !== null && typeof persisted === 'object' && !Array.isArray(persisted)
      ? { ...(persisted as Record<string, unknown>) }
      : {};
  const consent: LocalRuntimeConsent = state.enabled === false ? 'declined' : 'unasked';

  delete state.enabled;
  return { ...state, consent };
}
