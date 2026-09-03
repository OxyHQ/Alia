import { describe, expect, it } from 'vitest';

import {
  getOxyKaanaRoutingProfileId,
  OXY_KAANA_ROUTING_PROFILE_IDS,
} from '../oxy-inference-routing-profile-ids.js';

describe('reviewed Oxy Kaana routing-profile IDs', () => {
  it('pins every supported Alia product profile to its exact opaque Oxy primary key', () => {
    expect(OXY_KAANA_ROUTING_PROFILE_IDS).toEqual({
      'kaana-lite': '01a06477-94f5-74f0-bc25-4a1ff59d6945',
      'kaana-v1': '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
      'kaana-v1-codea': '01a06477-94f5-74f0-bc25-52437e0c724d',
      'kaana-v1-cowork': '01a06477-94f5-74f0-bc25-55ea2ebdb2b6',
      'kaana-v1-browser': '01a06477-94f5-74f0-bc25-5a78baecbef6',
      'kaana-v1-pro': '01a06477-94f5-74f0-bc25-5d796b49b616',
      'kaana-v1-thinking': '01a06477-94f5-74f0-bc25-628b5f45d802',
      'kaana-v1-pro-max': '01a06477-94f5-74f0-bc25-658eeb277737',
    });
    expect(new Set(Object.values(OXY_KAANA_ROUTING_PROFILE_IDS)).size).toBe(8);
  });

  it('fails closed instead of choosing a profile by name, order, or similarity', () => {
    expect(getOxyKaanaRoutingProfileId('kaana-v1')).toBe(
      '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
    );
    expect(getOxyKaanaRoutingProfileId('Kaana')).toBeNull();
    expect(getOxyKaanaRoutingProfileId('kaana-v1-vision')).toBeNull();
    expect(getOxyKaanaRoutingProfileId('kaana-v1-unknown')).toBeNull();
  });
});
