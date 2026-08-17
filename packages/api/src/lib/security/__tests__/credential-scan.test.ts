import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomBytes } from 'node:crypto';

import { API_KEY_PREFIX } from '../../api-key-crypto.js';
import { redactSecrets } from '../../agent/secret-scanner.js';
import {
  assertPatternsMatchTheirControls,
  CREDENTIAL_PATTERNS,
  scanGitHistory,
  scanText,
  type CredentialScanResult,
} from '../credential-scan.js';
import { findingKey, KNOWN_DISCLOSURES } from '../known-disclosures.js';

/**
 * The git-history credential audit, gated — epic #139 workstream 15, *"Audit git
 * history and deployment logs for exposed credentials; rotate where
 * necessary."*
 *
 * ## What each block is for
 *
 * A scanner reports "nothing found" for three reasons and only one is good news.
 * Every block below removes one of the other two:
 *
 *  1. **the patterns are broken** — every pattern is run against its own
 *     control, and the control mechanism is itself mutation-tested;
 *  2. **there was nothing to read** — a shallow clone must THROW, not return
 *     empty, and the real scan carries a floor on blobs and commits;
 *  3. **the pipeline does not work end to end** — a synthetic key is planted in
 *     a throwaway repository, DELETED in a later commit, and must still be found.
 *
 * Only then is the census itself asserted: the set of findings equals the ledger
 * in `known-disclosures.ts`, in BOTH directions, so a new credential fails the
 * build and a disclosure already made cannot be dropped from the record.
 *
 * ## Why this runs in `bun run --filter @alia/api test` rather than in a
 * dedicated workflow
 *
 * It needs the whole history, which is the one thing `actions/checkout` does not
 * fetch by default — `ci.yml` sets `fetch-depth: 0` on the job that runs this,
 * and the shallow-clone refusal is what turns a future removal of that line into
 * a red build instead of a silently vacuous pass.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const SECURITY_DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

/**
 * A key of the shape the planted-secret control uses.
 *
 * Random characters after a vendor prefix. It is not a credential and never was
 * one, which is the only reason a control can be written down at all.
 */
const PLANTED = `sk-ant-api03-${'Zq7Wn2Rb8Xt4Yu6Ip0Oa1Sd3Fg5Hj9Kl2Zx4Cv6Bn8M'}`;

/**
 * An `alia_sk_*` of the shape Alia's own credentials have.
 *
 * The MINTER is gone — #139 workstream 11 deleted `generateDeveloperApiKey` and
 * `lib/api-key-crypto.ts` says so, because ADR 0001 gives developer credentials
 * to Oxy and issuance is closed here. So this reproduces the format the deleted
 * generator produced (`API_KEY_PREFIX` plus 32 random bytes in unpadded
 * base64url, always 43 characters), and reproducing it is sound for exactly the
 * reason the generator could be deleted: **no new shape can appear.** Every
 * `alia_sk_*` in existence was issued by that function, and nothing will issue
 * another. What is still anchored to live code is the PREFIX, which
 * `middleware/auth.ts` screens on and which is asserted below.
 */
function issuedDeveloperKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=gate', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
}

/** A repository with the secret in an OLD commit and absent from `HEAD`. */
function plantedRepository(root: string): string {
  const repo = path.join(root, 'planted');
  execFileSync('mkdir', ['-p', repo]);
  git(repo, ['init', '-q', '-b', 'main']);

  writeFileSync(path.join(repo, 'README.md'), '# nothing here\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'first']);

  writeFileSync(path.join(repo, 'config.json'), `{\n  "apiKey": "${PLANTED}"\n}\n`);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'second: the mistake']);

  execFileSync('rm', ['-f', path.join(repo, 'config.json')]);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'third: the deletion that changes nothing']);

  return repo;
}

let workspace: string;
let planted: string;
let repoScan: CredentialScanResult;

beforeAll(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'alia-credential-scan-'));
  planted = plantedRepository(workspace);
  repoScan = await scanGitHistory(REPO_ROOT);
}, 120_000);

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/*  The patterns can fail                                                      */
/* -------------------------------------------------------------------------- */

describe('the patterns are checked against something (#139 ws15)', () => {
  it('every pattern matches its own control', () => {
    expect(() => {
      assertPatternsMatchTheirControls();
    }).not.toThrow();
    // The floor: there are patterns to check, and the list did not empty out.
    expect(CREDENTIAL_PATTERNS.length).toBeGreaterThanOrEqual(18);
  });

  it('the control mechanism reports a pattern that stopped matching', () => {
    // The mutation this whole file exists to survive: a regex edited by one
    // character reports a clean history. Applied to a COPY of the table, so the
    // module's own state is untouched and the assertion is about the mechanism.
    const broken = CREDENTIAL_PATTERNS.map((entry) =>
      entry.name === 'groq_api_key' ? { ...entry, pattern: /\bgsk_NEVER_MATCHES_THIS\b/g } : entry,
    );
    const failures = broken
      .filter((entry) => {
        entry.pattern.lastIndex = 0;
        const matched = entry.pattern.test(entry.control);
        entry.pattern.lastIndex = 0;
        return !matched;
      })
      .map((entry) => entry.name);
    expect(failures).toEqual(['groq_api_key']);
  });

  it('the Alia developer-key pattern matches what the minter actually mints', () => {
    // The prefix is still live code — `middleware/auth.ts` screens on it — so a
    // change to it fails here rather than leaving the audit blind to real keys.
    expect(API_KEY_PREFIX).toBe('alia_sk_');
    expect(
      readFileSync(path.join(REPO_ROOT, 'packages/api/src/middleware/auth.ts'), 'utf8'),
    ).toContain(`startsWith('${API_KEY_PREFIX}')`);

    // 25 draws, because base64url output varies and a pattern that happens to
    // match one sample is not a pattern that matches the format.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const minted = issuedDeveloperKey();
      expect(minted.length).toBe(API_KEY_PREFIX.length + 43);
      const found = scanText(`Authorization: Bearer ${minted}`);
      expect(found.map((f) => f.pattern), minted.length.toString()).toEqual(['alia_developer_key']);
    }
  });

  it('the same pattern ignores the documentation placeholders', () => {
    // The exact three shapes this repository's developer docs have used. A
    // looser floor matched 33 spans of them across history; the ledger they
    // would have filled is the failure mode, not the false positives.
    const placeholders = [
      'alia_sk_your_api_key_here',
      'alia_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      'alia_sk_1234567890abcdef1234567890abcdef',
    ];
    for (const placeholder of placeholders) {
      expect(scanText(`const key = "${placeholder}";`), placeholder).toEqual([]);
    }
    // The control for the control: the same call site DOES report a real one.
    expect(scanText(`const key = "${issuedDeveloperKey()}";`)).toHaveLength(1);
  });

  it('one credential is reported once, under the most specific pattern', () => {
    // `sk-ant-…` also satisfies the `sk-…` catch-all. Without the containment
    // pass every Anthropic key would occupy two ledger rows, and a reader
    // counting rows would count every such key twice.
    const found = scanText(`key=${PLANTED}`);
    expect(found.map((f) => f.pattern)).toEqual(['anthropic_api_key']);
    // Two DIFFERENT credentials side by side are still two findings.
    const google = `AIza${'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'}`;
    expect(scanText(`${PLANTED} ${google}`).map((f) => f.pattern)).toEqual([
      'anthropic_api_key',
      'google_api_key',
    ]);
  });

  it('every provider credential this scans for is one the runtime redactor censors', () => {
    /**
     * The two lists are separate on purpose — `lib/agent/secret-scanner.ts`
     * over-matches so an agent transcript is safe, this one under-matches so a
     * census stays readable — but they must not disagree about which VENDORS
     * exist. A provider whose key this scanner recognises and the redactor does
     * not is a provider whose 401 body quotes the key straight into the logs.
     *
     * Measured through the redactor's public behaviour rather than its table, so
     * a refactor of its internals cannot make this pass vacuously.
     */
    const withProvider = CREDENTIAL_PATTERNS.filter((entry) => entry.provider !== null);
    // The floor: there are provider entries to check.
    expect(withProvider.length).toBeGreaterThanOrEqual(11);

    const missed = withProvider
      .filter((entry) => redactSecrets(`token: ${entry.control}`).redacted.includes(entry.control))
      .map((entry) => entry.name);
    expect(missed).toEqual([]);

    // The control: a value with no vendor prefix is redacted by NEITHER, so the
    // assertion above is about agreement and not about the redactor saying yes
    // to everything.
    expect(redactSecrets('token: plain-english-not-a-key').redacted).toBe(
      'token: plain-english-not-a-key',
    );
  });

  it('every provider it claims is one the schema admits, and the rest say so', () => {
    // The `provider` field decides which patterns the assertion above applies
    // to, so an entry could be excused from it by writing `null`. This is the
    // check on that: a non-null slug must be one of the nineteen the CHECK
    // constraint admits, and the `null` set is an EXACT list rather than
    // "whatever is left", so adding a provider pattern and forgetting the
    // redactor cannot be hidden by marking it null.
    const migration = readFileSync(
      path.join(REPO_ROOT, 'packages/api/drizzle/0003_closed_black_queen.sql'),
      'utf8',
    );
    const admitted = new Set(
      [
        ...(/"provider_keys_provider_check" CHECK \("provider_keys"\."provider" in \(([^)]*)\)\)/
          .exec(migration)?.[1]
          .matchAll(/'([a-z]+)'/g) ?? []),
      ].map((match) => match[1]),
    );
    expect(admitted.size).toBe(19);

    for (const entry of CREDENTIAL_PATTERNS) {
      if (entry.provider === null) continue;
      expect(admitted.has(entry.provider), `${entry.name} -> ${entry.provider}`).toBe(true);
    }

    expect(
      CREDENTIAL_PATTERNS.filter((entry) => entry.provider === null).map((entry) => entry.name),
    ).toEqual([
      // Not providers Alia holds keys for. Each is scanned for because a person
      // can commit one, not because an upstream body can echo one.
      'huggingface_api_key',
      'nvidia_api_key',
      'alia_developer_key',
      'aws_access_key_id',
      'github_pat',
      'stripe_secret_key',
      'slack_token',
      'private_key_block',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  The pipeline can find a real leak                                          */
/* -------------------------------------------------------------------------- */

describe('the history scan finds a planted credential (#139 ws15)', () => {
  it('finds a key that was committed and then deleted', async () => {
    const result = await scanGitHistory(planted);
    expect(result.commitsReachable).toBe(3);
    expect(result.findings).toHaveLength(1);

    const [finding] = result.findings;
    expect(finding.pattern).toBe('anthropic_api_key');
    expect(finding.length).toBe(PLANTED.length);
    expect(finding.prefix).toBe(PLANTED.slice(0, 8));
    expect(finding.paths).toEqual(['config.json']);

    // The half a diff-based or working-tree scan gets wrong: the file is GONE at
    // HEAD, and the credential is still in every clone.
    expect(() => execFileSync('git', ['cat-file', '-e', 'HEAD:config.json'], { cwd: planted })).toThrow();
  });

  it('reports nothing once the planted commit is not in the history', async () => {
    // The negative control for the block above. Same scanner, same repository
    // shape, no secret — so "found one" is about the secret and not about the
    // scanner finding something in any repository at all.
    const clean = path.join(workspace, 'clean');
    execFileSync('mkdir', ['-p', clean]);
    git(clean, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(clean, 'README.md'), '# nothing here\n');
    git(clean, ['add', '.']);
    git(clean, ['commit', '-qm', 'first']);

    const result = await scanGitHistory(clean);
    expect(result.findings).toEqual([]);
    expect(result.blobsScanned).toBeGreaterThan(0);
  });

  it('refuses a shallow clone instead of calling it clean', async () => {
    // The failure this prevents is precise: `actions/checkout` fetches ONE
    // commit unless told otherwise, a one-commit scan of the planted repository
    // finds nothing, and nothing is exactly what a clean repository reports.
    const shallow = path.join(workspace, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${planted}`, shallow], {
      cwd: workspace,
    });
    expect(execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: shallow,
      encoding: 'utf8',
    }).trim()).toBe('true');

    await expect(scanGitHistory(shallow)).rejects.toThrow(/shallow/);

    // And the control: with the full history, the same clone finds the key. So
    // the refusal above is about depth rather than about clones.
    execFileSync('git', ['fetch', '-q', '--unshallow'], { cwd: shallow });
    const result = await scanGitHistory(shallow);
    expect(result.findings.map((f) => f.pattern)).toEqual(['anthropic_api_key']);
  });
});

/* -------------------------------------------------------------------------- */
/*  This repository's own history                                              */
/* -------------------------------------------------------------------------- */

describe("this repository's disclosures are exactly the ledger (#139 ws15)", () => {
  it('read a real history, not one commit', () => {
    // The vacuity floor. "I found less" and "there is less to find" print the
    // same clean result, and these two numbers are what tell them apart.
    expect(repoScan.commitsReachable).toBeGreaterThan(1_000);
    expect(repoScan.blobsScanned).toBeGreaterThan(5_000);
    expect(repoScan.bytesScanned).toBeGreaterThan(100_000_000);
  });

  it('every finding is ledgered and every ledger entry is found', () => {
    const found = [...new Set(repoScan.findings.map(findingKey))].sort();
    const ledgered = KNOWN_DISCLOSURES.map((entry) => entry.key).sort();

    // Exact, in both directions. A new credential in history fails here, and so
    // does a ledger entry whose blob the history no longer contains — which is
    // what a rewrite, or a wrong entry, looks like.
    expect(found).toEqual(ledgered);
    // The floor before the equality: the ledger is not empty and neither is the
    // scan, so `[] === []` cannot pass this test.
    expect(ledgered.length).toBeGreaterThan(0);
  });

  it('the ledger says what each disclosure is and what was decided', () => {
    for (const entry of KNOWN_DISCLOSURES) {
      expect(entry.key, entry.key).toMatch(/^[a-z0-9_]+:[0-9a-f]{12}$/);
      // A date or an explicit null. A free-text "soon" is the value this refuses.
      if (entry.rotatedAt !== null) expect(entry.rotatedAt, entry.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.note.length, entry.key).toBeGreaterThan(20);
      expect(entry.where.length, entry.key).toBeGreaterThan(10);
    }
    // Every commit the ledger's prose cites must exist, or it describes a
    // history nobody has. Read out of `where` and the module doc rather than
    // from a field, because a commit is context for a human and not part of a
    // finding's identity.
    const prose = readFileSync(path.join(SECURITY_DIR, 'known-disclosures.ts'), 'utf8');
    const commits = [...new Set([...prose.matchAll(/`([0-9a-f]{8})`/g)].map((m) => m[1]))];
    expect(commits.length).toBeGreaterThanOrEqual(4);
    for (const commit of commits) {
      expect(() =>
        execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: REPO_ROOT }),
      ).not.toThrow();
    }
  });

  it('a synthetic fixture is pinned to one exact value', () => {
    // The `synthetic_fixture` classification is the only one that says "this is
    // not a credential", so it is the one somebody could hide a real key behind.
    // The fingerprint is what stops that: it names ONE value, so swapping the
    // literal changes the key and this ledger stops matching the history.
    const fixtures = KNOWN_DISCLOSURES.filter((e) => e.classification === 'synthetic_fixture');
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const [, fingerprint] = fixture.key.split(':');
      expect(fingerprint, fixture.key).toMatch(/^[0-9a-f]{12}$/);
      // And the value it pins is really in a test file, not anywhere a runtime
      // path could read it.
      const found = repoScan.findings.filter((f) => findingKey(f) === fixture.key);
      expect(found.length, fixture.key).toBeGreaterThan(0);
      for (const finding of found) {
        for (const where of finding.paths) {
          expect(where, fixture.key).toMatch(/__tests__|\.test\.ts$/);
        }
      }
    }
  });

  it('neither the ledger nor the runbook carries a credential value', () => {
    // The obvious way to lose this argument is to document the leak by quoting
    // it. Run the scanner over the two files that describe the findings; both
    // must be clean, and the control proves the check is live.
    for (const file of [
      path.join(SECURITY_DIR, 'known-disclosures.ts'),
      path.join(SECURITY_DIR, 'credential-scan.ts'),
      path.join(REPO_ROOT, 'docs/runbooks/provider-credential-exposure.md'),
      path.join(REPO_ROOT, 'docs/runbooks/credential-rotation.md'),
    ]) {
      const text = readFileSync(file, 'utf8');
      expect(text.length, file).toBeGreaterThan(500);
      // `credential-scan.ts` carries the synthetic controls, which are the one
      // legitimate reason a file here matches: they are built by concatenation
      // from two literals, so the source text does not contain the whole value.
      expect(scanText(text).map((f) => f.prefix), file).toEqual([]);
    }
    // The control: the same call reports the planted key, so an empty list is
    // absence rather than a scanner that has stopped looking at files.
    expect(scanText(`a file that quoted it: ${PLANTED}`)).toHaveLength(1);
  });
});
