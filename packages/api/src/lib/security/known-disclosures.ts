/**
 * The ledger of credential material already in this repository's git history —
 * epic #139 workstream 15.
 *
 * ## Why a ledger and not an empty expectation
 *
 * This repository is PUBLIC and its history is immutable in every clone that has
 * ever been made of it. `git filter-repo` rewrites what THIS remote serves; it
 * does not reach a fork, a CI cache, a mirror or an archive, and it breaks every
 * open branch. So "the scan reports nothing" is not a state this repository can
 * be returned to, and a gate whose expected value is zero would be red forever
 * and therefore ignored within a week.
 *
 * What can be true, and is what the gate asserts, is that the set of disclosures
 * is EXACTLY this list. A credential entering history fails the build. A
 * disclosure already made cannot be dropped from the record — an entry that
 * matches nothing fails just as loudly as a finding that matches no entry,
 * because a ledger only a human maintains is a ledger that silently rots.
 *
 * ## Rotation is the remedy; this file is the receipt
 *
 * `rotatedAt` is the only durable evidence that the value was replaced at its
 * provider. It stays `null` until someone with access to that provider's console
 * has done it, and `packages/api/src/scripts/scan-credential-history.ts` exits
 * `2` while any entry is pending, so "we will get to it" has a number attached.
 * The procedure is `docs/runbooks/credential-rotation.md` §
 * *Rotating the keys found in git history*.
 *
 * **No credential value appears in this file, and none may be added.** An entry
 * is identified by `pattern:blob:offset` — the offset inside an immutable blob —
 * which is unique, stable and carries nothing an attacker did not already have.
 */

import type { CredentialFinding } from './credential-scan.js';

/**
 * A finding's identity: the pattern that claimed it and a digest of the value.
 *
 * Neither the blob nor the path is part of it. A blob id changes on every edit
 * to its file, and a path changes on a rename — both would make this ledger go
 * red for reasons that are not "a credential entered the history", which is the
 * one thing it exists to say. Two files holding the same value are one entry,
 * because they are one credential.
 */
export function findingKey(finding: Pick<CredentialFinding, 'pattern' | 'fingerprint'>): string {
  return `${finding.pattern}:${finding.fingerprint}`;
}

export interface KnownDisclosure {
  /** `${pattern}:${fingerprint}`, from {@link findingKey}. */
  readonly key: string;
  /**
   * What the matched value actually is, which decides what "remediated" means.
   *
   * `credential` is a value that grants something and must be revoked at its
   * issuer; only these can be PENDING, and `rotatedAt` is the answer.
   * `firebase_client_config` is a Google client key that ships inside the
   * shipped app by design — it is not a secret, it is a value to RESTRICT, so
   * leaving `rotatedAt` null forever says nothing bad about it.
   * `synthetic_fixture` is a key-shaped literal a TEST needs as its own positive
   * control; four exist, and the redactor and sanitizer gates would be vacuous
   * without them.
   *
   * The `synthetic_fixture` member is not an escape hatch, and the FINGERPRINT
   * is what stops it being one: an entry names one exact value, so replacing a
   * synthetic key with a real one changes the key, leaves this entry matching
   * nothing, and fails the gate twice over. There is deliberately no
   * `false_positive` member — a value that is not credential-shaped belongs
   * outside the PATTERN, not inside an exception list.
   */
  readonly classification: 'credential' | 'firebase_client_config' | 'synthetic_fixture';
  /** Where it is, for a human. Not part of the identity: a rename is not a leak. */
  readonly where: string;
  /** ISO date the value was rotated at its provider, or `null` while pending. */
  readonly rotatedAt: string | null;
  /** What it is and what the decision was. One line, no value. */
  readonly note: string;
}

/**
 * Everything {@link import('./credential-scan.js').scanGitHistory} finds today.
 *
 * Discovered 2026-08-17 by the first run of that scanner over the commits
 * reachable from `main`. Six distinct values, of three kinds:
 *
 *  - **`keys.json`** was a provider-key fixture committed on 2026-01-14
 *    (`94a0ba8d`) and deleted the same day (`3ccbf430`). Three live upstream
 *    credentials, one per provider, each granting billable inference on the
 *    account that issued it. Deleting the file removed it from the tree and from
 *    nothing else.
 *  - **`google-services.json`** is a Firebase Android client configuration
 *    (`413ffa3f`, removed and gitignored in `042baefd`). Its `AIza…` value is a
 *    CLIENT key: Google ships it inside every APK and treats it as public, so
 *    its protection is API restrictions in the Cloud console rather than
 *    secrecy. It is recorded because it matches, and classified for what it is
 *    rather than filtered out — the judgement belongs here, not in the pattern.
 *  - **Two synthetic fixtures** other gates need. `sanitize.test.ts` proves
 *    `redactUnsafeDetail` removes a credential and `routing-policy.test.ts`
 *    proves a policy cannot render one back out; neither assertion can be
 *    written without a key-shaped literal to feed it.
 *
 * The developer-documentation placeholders that a looser `alia_sk_` pattern also
 * matched are deliberately NOT here; see that pattern's own note in
 * `credential-scan.ts` for why the fix was the pattern and not this list.
 */
export const KNOWN_DISCLOSURES: readonly KnownDisclosure[] = [
  {
    key: 'google_api_key:07e55bffe541',
    classification: 'credential',
    where: 'keys.json, added in 94a0ba8d and removed in 3ccbf430, both 2026-01-14',
    rotatedAt: null,
    note: 'Google Generative Language key for a Gemini model. Revoke in the Google Cloud console.',
  },
  {
    key: 'groq_api_key:2118d4a12bba',
    classification: 'credential',
    where: 'keys.json, added in 94a0ba8d and removed in 3ccbf430, both 2026-01-14',
    rotatedAt: null,
    note: 'Groq key for a Llama model. Revoke at console.groq.com.',
  },
  {
    key: 'openai_project_key:903e989da925',
    classification: 'credential',
    where: 'keys.json, added in 94a0ba8d and removed in 3ccbf430, both 2026-01-14',
    rotatedAt: null,
    note: 'OpenAI project key for a GPT-4o model. Revoke at platform.openai.com.',
  },
  {
    key: 'google_api_key:dc53650a7c03',
    classification: 'firebase_client_config',
    where: 'apps/app/google-services.json, added in 413ffa3f and removed in 042baefd, both 2026-03-11',
    rotatedAt: null,
    note: 'Firebase Android client key; ships in every APK by design. Restrict it in the Cloud console rather than rotating it.',
  },
  {
    key: 'openai_project_key:a4f3b2153f32',
    classification: 'synthetic_fixture',
    where: 'packages/api/src/lib/__tests__/sanitize.test.ts and lib/routing/__tests__/routing-policy.test.ts',
    rotatedAt: null,
    note: 'The `sk-proj-` literal those two gates feed to redactUnsafeDetail; without it neither assertion can fail.',
  },
  {
    key: 'github_pat:03aafb028d53',
    classification: 'synthetic_fixture',
    where: 'packages/api/src/lib/__tests__/sanitize.test.ts',
    rotatedAt: null,
    note: 'The `ghp_abcd…` literal the same file feeds the redactor, alongside the sk-proj- one.',
  },
];
