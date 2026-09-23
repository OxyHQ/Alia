import { describe, expect, it } from 'vitest';
import { OXY_KAANA_ROUTING_PROFILE_IDS, OXY_KAANA_SPEECH_ROUTING_PROFILE_ID } from '../../config/oxy-inference-routing-profile-ids.js';
import {
  agentRoutingReadinessReport,
  oxyRoutingReadinessReport,
  speechReadinessReport,
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
    expect(oxyRoutingReadinessReport([...Object.values(OXY_KAANA_ROUTING_PROFILE_IDS)])).toEqual({
      ready: true,
      missingCount: 0,
      missing: [],
    });
  });

  it('reports the exact missing key instead of accepting matching slugs', () => {
    const ids = Object.values(OXY_KAANA_ROUTING_PROFILE_IDS).filter((id) => id !== OXY_KAANA_ROUTING_PROFILE_IDS['route:instant']);
    expect(oxyRoutingReadinessReport(['route:instant', ...ids])).toEqual({
      ready: false,
      missingCount: 1,
      missing: [OXY_KAANA_ROUTING_PROFILE_IDS['route:instant']],
    });
  });

  /**
   * The regression this file exists to stop repeating. #576 put the speech id
   * into the blocking set, and every deploy after it failed — the profile is
   * reserved in Oxy but deliberately not provisioned yet, so nothing Alia
   * shipped could satisfy it.
   */
  it('does not block the deploy on the unprovisioned speech profile', () => {
    const chatOnly = Object.values(OXY_KAANA_ROUTING_PROFILE_IDS);
    expect(chatOnly).not.toContain(OXY_KAANA_SPEECH_ROUTING_PROFILE_ID);
    expect(oxyRoutingReadinessReport(chatOnly).ready).toBe(true);
  });
});

describe('speech profile provisioning, reported but never blocking', () => {
  it('says it is unprovisioned when Oxy does not expose it to Alia', () => {
    expect(speechReadinessReport(Object.values(OXY_KAANA_ROUTING_PROFILE_IDS))).toEqual({
      provisioned: false,
      routingProfileId: OXY_KAANA_SPEECH_ROUTING_PROFILE_ID,
    });
  });

  it('says it is provisioned once Oxy exposes that exact id', () => {
    expect(speechReadinessReport([OXY_KAANA_SPEECH_ROUTING_PROFILE_ID])).toEqual({
      provisioned: true,
      routingProfileId: OXY_KAANA_SPEECH_ROUTING_PROFILE_ID,
    });
  });

  it('reads the exact id rather than any speech-shaped profile', () => {
    expect(speechReadinessReport(['cc2471c8-807e-46ec-b5da-000000000000']).provisioned).toBe(false);
  });
});
