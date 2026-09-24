import { describe, expect, it } from 'vitest';
import { OXY_KAANA_ROUTING_PROFILE_IDS, OXY_KAANA_SPEECH_ROUTING_PROFILE_ID } from '../../config/oxy-inference-routing-profile-ids.js';
import {
  agentRoutingReadinessReport,
  oxyRoutingReadinessReport,
} from '../check-agent-routing-profile-readiness.js';

describe('agent routing-profile rollout readiness', () => {
  it('is ready only when every active row carries a reviewed exact Oxy PK', () => {
    expect(agentRoutingReadinessReport([{
      id: 'agent-ready',
      routingProfileId: OXY_KAANA_ROUTING_PROFILE_IDS['route:auto'],
    }])).toEqual({ ready: true, unresolvedCount: 0, unresolved: [] });
  });

  it.each([
    ['null', null],
    ['product name', 'route:auto'],
    ['leading whitespace', ` ${OXY_KAANA_ROUTING_PROFILE_IDS['route:auto']}`],
    ['trailing whitespace', `${OXY_KAANA_ROUTING_PROFILE_IDS['route:auto']} `],
    ['unknown opaque id', '01a06477-94f5-74f0-bc25-000000000000'],
  ])('reports %s as unresolved', (_label, routingProfileId) => {
    expect(agentRoutingReadinessReport([{
      id: 'agent-unresolved',
      routingProfileId,
    }])).toEqual({
      ready: false,
      unresolvedCount: 1,
      unresolved: [{
        id: 'agent-unresolved',
        routingProfileId,
        reason: routingProfileId === null ? 'missing' : 'unknown',
      }],
    });
  });

  it('still blocks when one reviewed agent is followed by another agent with no exact mapping', () => {
    expect(agentRoutingReadinessReport([
      {
        id: '01a03df0-2834-7309-80cb-cb1b1ce67dda',
        routingProfileId: OXY_KAANA_ROUTING_PROFILE_IDS['route:auto'],
      },
      {
        id: 'another-agent',
        routingProfileId: null,
      },
    ])).toEqual({
      ready: false,
      unresolvedCount: 1,
      unresolved: [{
        id: 'another-agent',
        routingProfileId: null,
        reason: 'missing',
      }],
    });
  });
});

describe('live Oxy routing-profile readiness', () => {
  it('requires every reviewed primary key to be visible to Alia', () => {
    expect(oxyRoutingReadinessReport([
      ...Object.values(OXY_KAANA_ROUTING_PROFILE_IDS),
      OXY_KAANA_SPEECH_ROUTING_PROFILE_ID,
    ])).toEqual({
      ready: true,
      missingCount: 0,
      missing: [],
    });
  });

  it('reports the exact missing key instead of accepting matching slugs', () => {
    const ids = Object.values(OXY_KAANA_ROUTING_PROFILE_IDS).filter((id) => id !== OXY_KAANA_ROUTING_PROFILE_IDS['route:instant']);
    expect(oxyRoutingReadinessReport(['route:instant', ...ids, OXY_KAANA_SPEECH_ROUTING_PROFILE_ID])).toEqual({
      ready: false,
      missingCount: 1,
      missing: [OXY_KAANA_ROUTING_PROFILE_IDS['route:instant']],
    });
  });

  /**
   * Speech is required again now that Oxy provisions it (OxyHQ/oxy #1360).
   * #576 made it blocking before Oxy could serve it and every deploy failed;
   * the difference now is that the profile exists, so a missing one is a real
   * read-aloud outage rather than a capability nobody built yet.
   */
  it('blocks the deploy when the provisioned speech profile is not visible', () => {
    const chatOnly = Object.values(OXY_KAANA_ROUTING_PROFILE_IDS);
    expect(chatOnly).not.toContain(OXY_KAANA_SPEECH_ROUTING_PROFILE_ID);
    expect(oxyRoutingReadinessReport(chatOnly)).toEqual({
      ready: false,
      missingCount: 1,
      missing: [OXY_KAANA_SPEECH_ROUTING_PROFILE_ID],
    });
    expect(oxyRoutingReadinessReport([...chatOnly, OXY_KAANA_SPEECH_ROUTING_PROFILE_ID]).ready).toBe(true);
  });

  it('reads the exact speech id rather than any speech-shaped profile', () => {
    const chatOnly = Object.values(OXY_KAANA_ROUTING_PROFILE_IDS);
    expect(oxyRoutingReadinessReport([...chatOnly, 'cc2471c8-807e-46ec-b5da-000000000000']).ready).toBe(false);
  });
});
