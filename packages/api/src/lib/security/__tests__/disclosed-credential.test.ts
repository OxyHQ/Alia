import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { KNOWN_DISCLOSURES, disclosedCredentialMatching } from '../known-disclosures.js';

/**
 * The refusal that stops a published credential being written back into service.
 *
 * `scripts/provider-key.ts` is the caller, and it cannot be imported: it runs
 * `main()` on load, opens a database connection and calls SSM. So the predicate
 * lives in the module that owns the ledger and is tested here directly — the
 * same reason `lib/boot-guards.ts` exists apart from `src/index.ts`.
 *
 * **No credential appears in this file, and none may be added.** Every case is
 * built from a ledger FINGERPRINT, which is `sha256(value)[0..12]` and is
 * already committed in `known-disclosures.ts`. A hash prefix is not a
 * credential and cannot be turned back into one.
 */

/** A full-length sha256-shaped hex string whose first 12 characters are `prefix`. */
const hashStartingWith = (prefix: string): string => prefix + 'f'.repeat(64 - prefix.length);

describe('disclosedCredentialMatching', () => {
  /**
   * The fixture is derived from the ledger rather than retyped, so it cannot
   * drift from it — and the assertion below proves the ledger still contains
   * what this test assumes, rather than passing vacuously if it were emptied.
   */
  const credentials = KNOWN_DISCLOSURES.filter((entry) => entry.classification === 'credential');

  it('the ledger still holds the credentials this test is about', () => {
    // A floor with a reason: three real provider keys entered this repository's
    // public history on 2026-01-14. If this drops, the cases below stop meaning
    // anything and would otherwise still pass.
    expect(credentials.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses every disclosed credential in the ledger', () => {
    for (const entry of credentials) {
      const fingerprint = entry.key.slice(entry.key.indexOf(':') + 1);
      expect(fingerprint).toHaveLength(12);
      expect(disclosedCredentialMatching(hashStartingWith(fingerprint))).toBe(entry.key);
    }
  });

  it('admits a hash that matches nothing — the vacuity floor', () => {
    // Without this the function could `return entry.key` unconditionally and
    // every assertion above would still pass.
    expect(disclosedCredentialMatching(hashStartingWith('0123456789ab'))).toBeNull();
    expect(disclosedCredentialMatching('a'.repeat(64))).toBeNull();
  });

  it('does NOT refuse a Firebase client config or a synthetic fixture', () => {
    // Both are in the ledger and neither is a secret being placed in service.
    // Refusing them would be noise that teaches a caller to bypass this.
    const others = KNOWN_DISCLOSURES.filter((entry) => entry.classification !== 'credential');
    expect(others.length).toBeGreaterThanOrEqual(2);
    for (const entry of others) {
      const fingerprint = entry.key.slice(entry.key.indexOf(':') + 1);
      expect(disclosedCredentialMatching(hashStartingWith(fingerprint))).toBeNull();
    }
  });

  it('ignores `rotatedAt`, which is stricter than the ledger', () => {
    // A rotated credential is still refused: writing it produces upstream 401s
    // that read as an outage rather than as a paste error. Asserted against a
    // ledger entry rather than a contrived one, so it tracks the real data.
    const entry = credentials[0];
    const fingerprint = entry.key.slice(entry.key.indexOf(':') + 1);
    expect(disclosedCredentialMatching(hashStartingWith(fingerprint))).toBe(entry.key);
  });

  it('cannot be defeated by a short or empty hash', () => {
    // `''.slice(0, 12)` is `''`, and `key.endsWith(':')` is false for every
    // entry — but a future edit could make it true, so the length floor is
    // explicit rather than incidental.
    expect(disclosedCredentialMatching('')).toBeNull();
    expect(disclosedCredentialMatching('abc')).toBeNull();
  });
});

/**
 * A correct predicate that nothing calls refuses nothing.
 *
 * Everything above would still pass with the check deleted from the one-shot,
 * which is the green-and-inert shape this repository has been caught by before.
 * `scripts/provider-key.ts` cannot be imported — it runs `main()` on load — so
 * this is a source-text assertion, and it is the residue that cannot be closed
 * without making that file importable.
 */
describe('the one-shot actually consults it', () => {
  const script = readFileSync(
    fileURLToPath(new URL('../../../scripts/provider-key.ts', import.meta.url)),
    'utf8',
  );

  it('reads the real file, not an empty or unrelated one', () => {
    // Positive control: without this, a renamed or emptied script would make
    // every assertion below pass against an empty string.
    expect(script.length).toBeGreaterThan(2_000);
    expect(script).toContain('provider_keys');
  });

  it('calls the refusal, and refuses rather than warns', () => {
    expect(script).toContain('disclosedCredentialMatching(');
    // It must THROW. A version that logged and continued would satisfy a
    // grep for the call and still write the disclosed credential — the exact
    // substitution that left a boot guard green while it stopped exiting.
    const call = script.slice(script.indexOf('disclosedCredentialMatching('));
    const block = call.slice(0, call.indexOf('const keyPrefix'));
    expect(block).toMatch(/throw new Error\(/);
    expect(block).not.toMatch(/logger\.(warn|info)\(/);
  });

  it('checks BEFORE it writes', () => {
    // Order is the property: a refusal after the insert is not a refusal.
    expect(script.indexOf('disclosedCredentialMatching(')).toBeLessThan(
      script.indexOf('createProviderKey('),
    );
    expect(script.indexOf('disclosedCredentialMatching(')).toBeLessThan(
      script.indexOf('rotateProviderKey('),
    );
  });
});
