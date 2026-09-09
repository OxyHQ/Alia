import { describe, expect, it } from 'vitest';

import {
  getOxyKaanaProductProfileId,
  getOxyKaanaRoutingProfileId,
  OXY_KAANA_ROUTING_PROFILE_IDS,
} from '../oxy-inference-routing-profile-ids.js';

describe('reviewed Oxy Kaana routing-profile IDs', () => {
  it('pins every supported Alia product profile to its exact opaque Oxy primary key', () => {
    expect(OXY_KAANA_ROUTING_PROFILE_IDS).toEqual({
      'route:instant': '01a06477-94f5-74f0-bc25-4a1ff59d6945',
      'route:auto': '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
      'route:code': '01a06477-94f5-74f0-bc25-52437e0c724d',
      'route:cowork': '01a06477-94f5-74f0-bc25-55ea2ebdb2b6',
      'route:research': '01a06477-94f5-74f0-bc25-5a78baecbef6',
      'route:pro-standard': '01a06477-94f5-74f0-bc25-5d796b49b616',
      'route:thinking': '01a06477-94f5-74f0-bc25-628b5f45d802',
      'route:pro': '01a06477-94f5-74f0-bc25-658eeb277737',
    });
    expect(new Set(Object.values(OXY_KAANA_ROUTING_PROFILE_IDS)).size).toBe(8);
  });

  it('fails closed instead of choosing a profile by name, order, or similarity', () => {
    expect(getOxyKaanaRoutingProfileId('route:auto')).toBe(
      '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
    );
    expect(getOxyKaanaRoutingProfileId('Kaana')).toBeNull();
    expect(getOxyKaanaRoutingProfileId('route:vision')).toBeNull();
    expect(getOxyKaanaRoutingProfileId('route:auto-unknown')).toBeNull();
  });

  it.each([
    ' route:auto',
    'route:auto ',
    '\troute:auto',
    'route:auto\n',
  ])('rejects a product profile whose bytes were padded: %j', (id) => {
    expect(getOxyKaanaRoutingProfileId(id)).toBeNull();
  });

  it('reverse-resolves only the byte-exact opaque primary key', () => {
    const exact = OXY_KAANA_ROUTING_PROFILE_IDS['route:auto'];
    expect(getOxyKaanaProductProfileId(exact)).toBe('route:auto');
    expect(getOxyKaanaProductProfileId(` ${exact}`)).toBeNull();
    expect(getOxyKaanaProductProfileId(`${exact} `)).toBeNull();
    expect(getOxyKaanaProductProfileId(exact.toUpperCase())).toBeNull();
  });
});
