import { describe, expect, it } from 'vitest';
import { OXY_KAANA_ROUTING_PROFILE_IDS } from '../../config/oxy-inference-routing-profile-ids.js';
import { agentRoutingReadinessReport } from '../check-agent-routing-profile-readiness.js';

describe('agent routing-profile rollout readiness', () => {
  it('is ready only when every active row carries a reviewed exact Oxy PK', () => {
    expect(agentRoutingReadinessReport([{
      id: 'agent-ready',
      routingProfileId: OXY_KAANA_ROUTING_PROFILE_IDS['kaana-v1'],
      allowedModels: ['legacy-display-only'],
    }])).toEqual({ ready: true, unresolvedCount: 0, unresolved: [] });
  });

  it.each([
    ['null', null],
    ['product name', 'kaana-v1'],
    ['leading whitespace', ` ${OXY_KAANA_ROUTING_PROFILE_IDS['kaana-v1']}`],
    ['trailing whitespace', `${OXY_KAANA_ROUTING_PROFILE_IDS['kaana-v1']} `],
    ['unknown opaque id', '01a06477-94f5-74f0-bc25-000000000000'],
  ])('reports %s without deriving a profile from legacy array order', (_label, routingProfileId) => {
    expect(agentRoutingReadinessReport([{
      id: 'agent-unresolved',
      routingProfileId,
      allowedModels: ['kaana-v1', 'kaana-lite'],
    }])).toEqual({
      ready: false,
      unresolvedCount: 1,
      unresolved: [{
        id: 'agent-unresolved',
        routingProfileId,
        legacyAllowedModels: ['kaana-v1', 'kaana-lite'],
        reason: routingProfileId === null ? 'missing' : 'unknown',
      }],
    });
  });
});
