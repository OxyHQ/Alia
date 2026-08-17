/**
 * The availability-scope decision (#139 workstream 17).
 *
 * ## What this file would report if the thing it measures were absent
 *
 * That is the question worth asking of a check written against a fact nobody
 * has yet, and it has three answers here, one per group.
 *
 * The **vocabulary** group would report a clean pass if `AVAILABILITY_SCOPES`
 * were an empty array, because "every scope is decided" is trivially true of no
 * scopes. So the vocabulary is asserted equal to the five the contract
 * publishes, read out of `@oxyhq/contracts` a second time rather than retyped —
 * a copy of a copy would agree with itself while both drifted from the package.
 *
 * The **decision** group is a full cross product of scope by audience with
 * every cell named. A table with holes is how a scope ends up inheriting a
 * neighbour's answer, and a loop that skipped an undecided pair would pass by
 * measuring nothing.
 *
 * The **audience** group is the one that catches an ordering bug the catalogue
 * cannot see. `internal_alia` refuses a session and a developer key alike, so
 * swapping the two branches of `resolveCallerAudience` changes no response
 * today — and would change every response the moment a scope treats them
 * differently. It is measured here, at the resolver, where the difference is
 * observable.
 */

import type { Request } from 'express';
import { availabilityScopeSchema } from '@oxyhq/contracts';
import { describe, expect, it } from 'vitest';

import {
  AVAILABILITY_SCOPES,
  CALLER_AUDIENCES,
  admitEntry,
  admitsAudience,
  resolveCallerAudience,
  type AvailabilityScope,
  type CallerAudience,
} from '../availability-scope.js';

describe('the vocabulary is the contract’s, not a copy of it', () => {
  it('is exactly the five scopes @oxyhq/contracts publishes', () => {
    // The five epic #139 names, spelled out so a contract release that dropped
    // or renamed one is a failure here rather than a silent behaviour change.
    expect([...AVAILABILITY_SCOPES].sort()).toEqual([
      'byok_only',
      'enterprise',
      'internal_alia',
      'oxy_hosted',
      'public_payg',
    ]);
    // And it is the schema's own list, so a sixth scope arrives without an edit
    // — at which point `admitsAudience` stops compiling until it is decided.
    expect(AVAILABILITY_SCOPES).toEqual(availabilityScopeSchema.options);
  });

  it('covers every credential kind that can reach a route', () => {
    expect([...CALLER_AUDIENCES].sort()).toEqual(['api_key', 'internal', 'public', 'user']);
  });
});

describe('every scope has a decision for every audience', () => {
  /**
   * The whole cross product, written out. A loop that derived the expected
   * answer from the same switch it is testing would re-implement the code under
   * test and measure the re-implementation.
   */
  const EXPECTED: Readonly<Record<AvailabilityScope, Readonly<Record<CallerAudience, string>>>> = {
    internal_alia: {
      public: 'refused',
      user: 'refused',
      api_key: 'refused',
      internal: 'admitted',
    },
    public_payg: { public: 'admitted', user: 'admitted', api_key: 'admitted', internal: 'admitted' },
    oxy_hosted: { public: 'admitted', user: 'admitted', api_key: 'admitted', internal: 'admitted' },
    enterprise: {
      public: 'undecidable',
      user: 'undecidable',
      api_key: 'undecidable',
      internal: 'undecidable',
    },
    byok_only: {
      public: 'undecidable',
      user: 'undecidable',
      api_key: 'undecidable',
      internal: 'undecidable',
    },
  };

  it('decides all twenty pairs, and the table is total over both vocabularies', () => {
    // The floor: a table missing a scope, or a scope missing an audience, is a
    // hole a `toMatchObject` would walk straight past.
    expect(Object.keys(EXPECTED).sort()).toEqual([...AVAILABILITY_SCOPES].sort());
    for (const scope of AVAILABILITY_SCOPES) {
      expect(Object.keys(EXPECTED[scope]).sort()).toEqual([...CALLER_AUDIENCES].sort());
    }

    let decided = 0;
    for (const scope of AVAILABILITY_SCOPES) {
      for (const audience of CALLER_AUDIENCES) {
        expect(admitsAudience(scope, audience).state, `${scope} × ${audience}`).toBe(
          EXPECTED[scope][audience],
        );
        decided += 1;
      }
    }
    expect(decided).toBe(20);
  });

  it('says which fact it is missing when it cannot decide', () => {
    // A withholding whose reason is not carried is indistinguishable from a
    // refusal, and the two say opposite things about whether a decision exists.
    const enterprise = admitsAudience('enterprise', 'internal');
    expect(enterprise).toEqual({ state: 'undecidable', missing: 'enterprise_contract' });
    const byok = admitsAudience('byok_only', 'user');
    expect(byok).toEqual({ state: 'undecidable', missing: 'byok_credential' });
  });
});

describe('an entry’s verdict comes from the routes behind it', () => {
  it('is unscoped only when no route declared a scope', () => {
    expect(admitEntry([], 'public')).toEqual({ state: 'unscoped' });
    expect(admitEntry([null, null], 'public')).toEqual({ state: 'unscoped' });
    // One classified route is enough to leave that state, whatever it says.
    expect(admitEntry([null, 'public_payg'], 'public')).toEqual({
      state: 'admitted',
      scopes: ['public_payg'],
    });
  });

  it('publishes only the scopes that admitted this caller', () => {
    // A caller must not be told a route is theirs because some other route on
    // the same entry is.
    expect(admitEntry(['internal_alia', 'public_payg'], 'public')).toEqual({
      state: 'admitted',
      scopes: ['public_payg'],
    });
    expect(admitEntry(['internal_alia', 'public_payg'], 'internal')).toEqual({
      state: 'admitted',
      scopes: ['internal_alia', 'public_payg'],
    });
  });

  it('withholds only when nothing admits, and says which kind of nothing', () => {
    expect(admitEntry(['internal_alia'], 'user')).toEqual({ state: 'withheld', reason: 'refused' });
    expect(admitEntry(['enterprise'], 'user')).toEqual({ state: 'withheld', reason: 'undecidable' });
    // A refusal outranks an undecidable: the caller learns the more specific
    // of the two things that happened.
    expect(admitEntry(['internal_alia', 'enterprise'], 'user')).toEqual({
      state: 'withheld',
      reason: 'refused',
    });
  });

  it('keeps an entry reachable through an unclassified route', () => {
    // The residual the module documents, pinned so a later change that made
    // unclassified routes exclusive would be a deliberate act.
    expect(admitEntry(['internal_alia', null], 'public')).toEqual({ state: 'admitted', scopes: [] });
  });
});

describe('a credential is classified by its strongest half', () => {
  /** Just the three fields `resolveCallerAudience` reads. */
  const request = (fields: Record<string, unknown>): Request => fields as unknown as Request;

  it('reads a service token, a developer key and a session apart', () => {
    expect(resolveCallerAudience(request({}))).toBe('public');
    expect(resolveCallerAudience(request({ user: { id: 'u' } }))).toBe('user');
    expect(resolveCallerAudience(request({ apiKey: { id: 'k' } }))).toBe('api_key');
    expect(resolveCallerAudience(request({ serviceApp: { appId: 'a' } }))).toBe('internal');
  });

  it('calls a developer key a developer key even though it also sets req.user', () => {
    // `middleware/auth.ts` `authenticateApiKey` sets BOTH, so this ordering is
    // the only thing standing between an `alia_sk_` key and a session's
    // admissions. The catalogue cannot see the difference today, because no
    // scope distinguishes the two — which is exactly why it is measured here.
    expect(resolveCallerAudience(request({ apiKey: { id: 'k' }, user: { id: 'owner' } }))).toBe('api_key');
  });

  it('treats a null user as no user, not as a session', () => {
    // `createOptionalOxyAuth` leaves `req.user` null on an unauthenticated
    // request, and `null` is present-but-empty rather than absent.
    expect(resolveCallerAudience(request({ user: null }))).toBe('public');
  });
});
