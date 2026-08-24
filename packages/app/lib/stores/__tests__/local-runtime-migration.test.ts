import { describe, expect, it } from 'vitest';
import { migrateLocalRuntimeState } from '../local-runtime-migration';

describe('local runtime persisted-state migration', () => {
  it('preserves an explicit v1 opt-out as declined consent', () => {
    const persisted = { enabled: false, endpoint: 'http://localhost:11434/v1' };

    expect(migrateLocalRuntimeState(persisted)).toEqual({
      consent: 'declined',
      endpoint: 'http://localhost:11434/v1',
    });
    expect(persisted).toHaveProperty('enabled', false);
  });

  it.each([
    { enabled: true, label: 'Studio' },
    { label: 'Studio' },
  ])('asks once when v1 stored no opt-out: %o', (persisted) => {
    const migrated = migrateLocalRuntimeState(persisted);

    expect(migrated).toEqual({
      consent: 'unasked',
      label: 'Studio',
    });
    expect(migrated).not.toHaveProperty('enabled');
  });

  it('fails closed to an unasked state for malformed persisted data', () => {
    expect(migrateLocalRuntimeState(null)).toEqual({ consent: 'unasked' });
    expect(migrateLocalRuntimeState([])).toEqual({ consent: 'unasked' });
  });
});
