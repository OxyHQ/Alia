/**
 * The `alia/*` namespace reservation (ADR 0002).
 *
 * Two directions matter equally here and they fail differently. Letting an
 * `alia/*` identifier through occupies a namespace that is supposed to mean
 * something; refusing an `alia-*` alias breaks all thirteen live identifiers at
 * once. So the negative cases are as load-bearing as the positive ones, and the
 * hyphenated alias set is asserted whole rather than by example.
 */

import { describe, expect, it } from 'vitest';

import {
  ReservedNamespaceError,
  assertUnreservedModelIdentifier,
  isReservedModelNamespace,
} from '../reserved-namespace.js';
import { resolveModel } from '../chat-core.js';
import { KAANA_ROUTING_PROFILE_IDS } from '../routing/kaana-profiles.js';
import { UnregisteredModelError } from '../routing/policy.js';

describe('the alia/* publisher namespace is reserved', () => {
  const reserved = [
    'alia/atlas',
    'alia/atlas@2026-08-01',
    'alia/a',
    'alia/',
    'ALIA/Atlas',
    'Alia/atlas',
    '  alia/atlas  ',
    'alia/nested/path',
  ];

  for (const identifier of reserved) {
    it(`refuses ${JSON.stringify(identifier)}`, () => {
      expect(isReservedModelNamespace(identifier)).toBe(true);
      expect(() => assertUnreservedModelIdentifier(identifier)).toThrow(ReservedNamespaceError);
    });
  }

  it('names the offending identifier on the error, and no provider', () => {
    // The message reaches a tool result and a log line. A model identifier is
    // Alia-branded by construction here, so naming it leaks nothing; a provider
    // name would.
    let caught: unknown = null;
    try {
      assertUnreservedModelIdentifier('alia/atlas');
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReservedNamespaceError);
    expect((caught as ReservedNamespaceError).identifier).toBe('alia/atlas');
    expect((caught as ReservedNamespaceError).message).toContain('alia/atlas');
    expect((caught as ReservedNamespaceError).message).toMatch(/reserved/i);
  });
});

describe('the reservation does not touch anything that is not in it', () => {
  it('lets every canonical Kaana routing profile through', () => {
    expect(KAANA_ROUTING_PROFILE_IDS.length).toBe(13);
    for (const profileId of KAANA_ROUTING_PROFILE_IDS) {
      expect(isReservedModelNamespace(profileId)).toBe(false);
      expect(() => assertUnreservedModelIdentifier(profileId)).not.toThrow();
    }
  });

  const unreserved = [
    ['/alia/chat', 'a route this service mounts; its first segment is empty, not "alia"'],
    ['alia', 'a bare publisher with no model is not the <publisher>/<model> form'],
    ['aliases/atlas', 'a different publisher that merely starts with the same letters'],
    ['alia-atlas/x', 'first segment is "alia-atlas", not "alia"'],
    ['openai/gpt-4o', 'somebody else entirely'],
    ['xalia/atlas', 'suffix match, not a first segment'],
    ['', 'the empty string names nothing'],
  ] as const;

  for (const [identifier, why] of unreserved) {
    it(`allows ${JSON.stringify(identifier)} — ${why}`, () => {
      expect(isReservedModelNamespace(identifier)).toBe(false);
      expect(() => assertUnreservedModelIdentifier(identifier)).not.toThrow();
    });
  }
});

describe('the serving chokepoint refuses it, not just the validator', () => {
  /**
   * A validator with no caller is green and inert at once. This drives the real
   * entrypoint: `chat-core.resolveModel` is the one hosted-model resolver used
   * by product turns, so refusing there is refusing everywhere product code can
   * ask for inference.
   */
  it('rejects a reserved identifier before it can resolve to anything', async () => {
    await expect(resolveModel('alia/atlas')).rejects.toBeInstanceOf(ReservedNamespaceError);
    await expect(resolveModel('alia/atlas@2026-08-01')).rejects.toBeInstanceOf(ReservedNamespaceError);
  });

  it('translates a registered product profile to its exact reviewed Oxy ID', async () => {
    const outcome = await resolveModel('kaana-v1');
    expect(outcome?.oxyInferenceTarget).toEqual({
      kind: 'routing_profile_id',
      routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
    });
    expect(outcome?.modelId).toBe('kaana-v1');
  });

  it('refuses a local profile with no reviewed Oxy ID instead of falling back', async () => {
    await expect(resolveModel('kaana-v1-vision')).rejects.toBeInstanceOf(UnregisteredModelError);
  });
});
