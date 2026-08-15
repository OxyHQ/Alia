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
import { resolveAliaModel } from '../gateway-client.js';
import { DEPRECATED_ALIASES } from '../../middleware/alias-deprecation.js';

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
  it('lets every one of the thirteen frozen aliases through', () => {
    // The whole set, not an example. The hyphen form and the slash form are
    // one character apart, and refusing the wrong one takes the product down.
    expect(DEPRECATED_ALIASES.length).toBe(13);
    for (const alias of DEPRECATED_ALIASES) {
      expect(isReservedModelNamespace(alias)).toBe(false);
      expect(() => assertUnreservedModelIdentifier(alias)).not.toThrow();
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
   * entrypoint: `gateway-client.resolveAliaModel` is the only door into model
   * resolution from outside `internal/providers/` — which is not an assumption,
   * it is what gate 1's frozen importer list in `architectureGates.test.ts`
   * measures — so refusing there is refusing everywhere product code can ask.
   */
  it('rejects a reserved identifier before it can resolve to anything', async () => {
    await expect(resolveAliaModel('alia/atlas')).rejects.toBeInstanceOf(ReservedNamespaceError);
    await expect(resolveAliaModel('alia/atlas@2026-08-01')).rejects.toBeInstanceOf(ReservedNamespaceError);
  });

  it('does not refuse a registered alias on its way through', async () => {
    // The negative control the assertion above needs. Without it, a guard that
    // threw `ReservedNamespaceError` for EVERY identifier would pass the test
    // above and take down all thirteen aliases. Resolution legitimately fails
    // here for want of a database and provider keys; what matters is the shape
    // of the failure, not that there is one.
    const outcome: unknown = await resolveAliaModel('alia-v1').then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).not.toBeInstanceOf(ReservedNamespaceError);
  });
});
