import { describe, expect, it } from 'vitest';

import {
  KAANA_ROUTING_PROFILE_IDS,
  isKaanaRoutingProfileId,
} from '../../../lib/routing/kaana-profiles.js';

describe('voice uses canonical Kaana routing profiles', () => {
  it('registers both voice profiles as routing profiles', () => {
    expect(isKaanaRoutingProfileId('route:voice')).toBe(true);
    expect(isKaanaRoutingProfileId('route:voice-pro')).toBe(true);
  });

  it('does not accept the removed compatibility vocabularies', () => {
    expect(isKaanaRoutingProfileId('legacy-routing-alias')).toBe(false);
    expect(isKaanaRoutingProfileId('profile:voice')).toBe(false);
  });

  it('keeps the profile registry non-vacuous and unique', () => {
    expect(KAANA_ROUTING_PROFILE_IDS).toHaveLength(13);
    expect(new Set(KAANA_ROUTING_PROFILE_IDS).size).toBe(KAANA_ROUTING_PROFILE_IDS.length);
  });
});
