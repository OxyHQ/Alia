import { describe, expect, it } from 'vitest';
import { OXY_KAANA_ROUTING_PROFILE_IDS } from '../../config/oxy-inference-routing-profile-ids.js';
import {
  agentRoutingReadinessReport,
  oxyRoutingReadinessReport,
} from '../check-agent-routing-profile-readiness.js';

describe('agent routing-profile rollout readiness', () => {
  it('is ready only when every active row carries a reviewed exact Oxy PK', () => {
    expect(agentRoutingReadinessReport([{
      id: 'agent-ready',
      routingProfileId: OXY_KAANA_ROUTING_PROFILE_IDS['route:auto'],
      allowedModels: ['legacy-display-only'],
    }])).toEqual({ ready: true, unresolvedCount: 0, unresolved: [] });
  });

  it.each([
    ['null', null],
    ['product name', 'route:auto'],
    ['leading whitespace', ` ${OXY_KAANA_ROUTING_PROFILE_IDS['route:auto']}`],
    ['trailing whitespace', `${OXY_KAANA_ROUTING_PROFILE_IDS['route:auto']} `],
    ['unknown opaque id', '01a06477-94f5-74f0-bc25-000000000000'],
  ])('reports %s without deriving a profile from legacy array order', (_label, routingProfileId) => {
    expect(agentRoutingReadinessReport([{
      id: 'agent-unresolved',
      routingProfileId,
      allowedModels: ['route:auto', 'route:instant'],
    }])).toEqual({
      ready: false,
      unresolvedCount: 1,
      unresolved: [{
        id: 'agent-unresolved',
        routingProfileId,
        legacyAllowedModels: ['route:auto', 'route:instant'],
        reason: routingProfileId === null ? 'missing' : 'unknown',
      }],
    });
  });

  it('still blocks when one reviewed agent is followed by another agent with no exact mapping', () => {
    expect(agentRoutingReadinessReport([
      {
        id: '01a03df0-2834-7309-80cb-cb1b1ce67dda',
        routingProfileId: OXY_KAANA_ROUTING_PROFILE_IDS['route:auto'],
        allowedModels: ['mode:auto', 'mode:pro'],
      },
      {
        id: 'another-agent',
        routingProfileId: null,
        allowedModels: ['mode:auto', 'mode:pro'],
      },
    ])).toEqual({
      ready: false,
      unresolvedCount: 1,
      unresolved: [{
        id: 'another-agent',
        routingProfileId: null,
        legacyAllowedModels: ['mode:auto', 'mode:pro'],
        reason: 'missing',
      }],
    });
  });
});

describe('live Oxy routing-profile readiness', () => {
  it('requires every reviewed primary key to be visible to Alia', () => {
    expect(oxyRoutingReadinessReport(Object.values(OXY_KAANA_ROUTING_PROFILE_IDS))).toEqual({
      ready: true,
      missingCount: 0,
      missing: [],
    });
  });

  it('reports the exact missing key instead of accepting matching slugs', () => {
    const ids = Object.values(OXY_KAANA_ROUTING_PROFILE_IDS).slice(1);
    expect(oxyRoutingReadinessReport(['route:instant', ...ids])).toEqual({
      ready: false,
      missingCount: 1,
      missing: [OXY_KAANA_ROUTING_PROFILE_IDS['route:instant']],
    });
  });
});
