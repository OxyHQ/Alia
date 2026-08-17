/**
 * Scanning this repository's git history for credential material — epic #139
 * workstream 15, *"Audit git history and deployment logs for exposed
 * credentials; rotate where necessary."*
 *
 * ## Why a scanner in this repository rather than `gitleaks` in a workflow
 *
 * The checkbox asks for two things a one-off run cannot give: a finding a human
 * acts on, and a check that fails the NEXT time a credential is committed. A
 * hosted scanner gives the second and not the first, because its verdict lives
 * in a service's UI rather than beside the rotation decision it implies. What is
 * here instead is the scanner, the LEDGER of what it already found
 * ({@link ./known-disclosures.ts}), and a test that holds the two to an exact
 * equality — so a new credential in history fails a build, and a disclosure
 * already made cannot be quietly forgotten.
 *
 * ## What it reads
 *
 * Every BLOB reachable from `HEAD`, not the working tree and not the diff. A
 * credential that was committed and then deleted is still in every clone of the
 * repository, and a diff-based scan of a pull request reports exactly nothing
 * about it — which is the state this scanner was written to discover and did.
 *
 * Reachability from `HEAD` rather than `--all` is what makes the result the SAME
 * locally and in CI. A developer checkout carries other people's topic branches
 * and, in a shared clone, unreachable objects that no clone ever receives; `HEAD`
 * is the one starting point both have, and its ancestry contains everything the
 * branch publishes.
 *
 * ## The floors, and what each one is for
 *
 * A scanner reports "clean" for three different reasons and only one of them is
 * good news: nothing is there, the patterns are broken, or there was nothing to
 * read. {@link scanGitHistory} refuses to answer at all in the third case — a
 * SHALLOW clone throws rather than returning an empty list, because
 * `actions/checkout` fetches depth 1 by default and a depth-1 scan of this
 * repository finds none of what a full one does. The second case is the
 * positive control in `__tests__/credential-scan.test.ts`, which plants a
 * synthetic key in a throwaway repository and requires this code to find it.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * A provider credential prefix, and the shape that follows it.
 *
 * These are deliberately NOT `lib/agent/secret-scanner.ts`'s patterns, and the
 * distinction is the point rather than duplication. That module redacts agent
 * output, where over-matching costs a few stars in a transcript, so it also
 * carries `postgres://…`, bare `Bearer …` and a generic
 * `password = "…"` heuristic. Run over 3 800 historical paths those produce
 * hundreds of hits from documentation, fixtures and connection strings, and a
 * gate whose expected value is "hundreds of things a human already looked at" is
 * a gate nobody reads.
 *
 * What must not drift is the PREFIX SET — the two lists disagreeing is how a
 * provider ends up redacted at runtime and invisible to the audit, or the
 * reverse. `__tests__/credential-scan.test.ts` asserts the agreement rather than
 * sharing one table, so each list stays free to serve its own job.
 *
 * Every entry has a length floor, because the prefix alone matches prose. `sk-`
 * appears in `sk-ant-`, in `sk_live_`, and in the word "risk-averse" at a line
 * break; the floor is what separates a credential from a sentence.
 */
interface CredentialPattern {
  /** Stable across runs: it is half of a finding's identity in the ledger. */
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * A synthetic value of this shape, used as the pattern's own positive control.
   *
   * Not a real credential and not derived from one: random characters after the
   * vendor's documented prefix. {@link assertPatternsMatchTheirControls} runs
   * every pattern against every control, which is what makes a broken regex a
   * loud failure instead of a clean scan.
   */
  readonly control: string;
  /**
   * The `provider_keys.provider` slug this credential belongs to, or `null` when
   * Alia stores no key of that kind.
   *
   * This is what makes the agreement with the runtime redactor decidable. A
   * credential for one of the nineteen providers the CHECK constraint admits
   * (`drizzle/0003_closed_black_queen.sql`) can come back in an upstream error
   * body, so `lib/agent/secret-scanner.ts` MUST know how to censor it. The
   * `null` entries — a HuggingFace token, an AWS key, a private key block —
   * cannot arrive that way and are scanned for because a developer can still
   * commit one; requiring the redactor to carry them would be requiring it to
   * over-match for no runtime reason.
   */
  readonly provider: string | null;
}

export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  {
    name: 'anthropic_api_key',
    provider: 'anthropic',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{40,}/g,
    control: 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6',
  },
  {
    name: 'openai_project_key',
    provider: 'openai',
    pattern: /\bsk-proj-[A-Za-z0-9_-]{40,}/g,
    control: 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6',
  },
  {
    name: 'openrouter_api_key',
    provider: 'openrouter',
    pattern: /\bsk-or-v1-[A-Za-z0-9]{32,}/g,
    control: 'sk-or-v1-' + '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829',
  },
  {
    // Every OpenAI-compatible gateway (DeepSeek, Novita, a self-hosted proxy)
    // issues `sk-…` with no vendor marker, so this is the catch-all and is
    // listed after the specific three: a `sk-ant-…` value matches both, and the
    // ledger records the finding under each pattern that claims it rather than
    // silently picking one.
    name: 'openai_compatible_key',
    provider: 'deepseek',
    pattern: /\bsk-[A-Za-z0-9_-]{32,}/g,
    control: 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0',
  },
  {
    name: 'google_api_key',
    provider: 'google',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    control: 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
  },
  {
    name: 'groq_api_key',
    provider: 'groq',
    pattern: /\bgsk_[A-Za-z0-9]{40,}/g,
    control: 'gsk_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2',
  },
  {
    name: 'xai_api_key',
    provider: 'xai',
    pattern: /\bxai-[A-Za-z0-9]{40,}/g,
    control: 'xai-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2',
  },
  {
    name: 'cerebras_api_key',
    provider: 'cerebras',
    pattern: /\bcsk-[A-Za-z0-9]{40,}/g,
    control: 'csk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2',
  },
  {
    name: 'replicate_api_key',
    provider: 'replicate',
    pattern: /\br8_[A-Za-z0-9]{32,}/g,
    control: 'r8_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  },
  {
    name: 'digitalocean_api_key',
    provider: 'digitalocean',
    pattern: /\bdop_v1_[a-f0-9]{64}\b/g,
    control:
      'dop_v1_' + '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
  },
  {
    name: 'huggingface_api_key',
    provider: null,
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
    control: 'hf_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  },
  {
    name: 'perplexity_api_key',
    provider: 'perplexity',
    pattern: /\bpplx-[A-Za-z0-9]{40,}/g,
    control: 'pplx-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2',
  },
  {
    name: 'fireworks_api_key',
    provider: 'fireworks',
    pattern: /\bfw_[A-Za-z0-9]{24,}/g,
    control: 'fw_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
  },
  {
    name: 'nvidia_api_key',
    provider: null,
    pattern: /\bnvapi-[A-Za-z0-9_-]{60,}/g,
    control:
      'nvapi-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A1b2C3d4E5',
  },
  {
    /**
     * Alia's own developer credential, matched at the EXACT length the minter
     * produces: `lib/api-key-crypto.ts` is `alia_sk_` plus 32 random bytes in
     * unpadded base64url, which is always 43 characters.
     *
     * The exactness is load-bearing rather than tidy. A `{16,}` floor matched
     * 33 spans across this repository's history, every one of them a
     * documentation placeholder — `alia_sk_your_api_key_here`,
     * `alia_sk_xxxxxxxx…` — and a ledger holding 33 fake keys that grows on
     * every edit to the developer docs is a ledger nobody reads and a gate
     * everybody silences. Length 43 is not a heuristic about what looks fake; it
     * is the format the code mints, and `__tests__/credential-scan.test.ts`
     * holds this pattern to a key from `generateDeveloperApiKey()` so the two
     * cannot drift apart.
     */
    name: 'alia_developer_key',
    provider: null,
    pattern: /\balia_sk_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
    control: 'alia_sk_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v',
  },
  {
    name: 'aws_access_key_id',
    provider: null,
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    control: 'AKIA' + 'IOSFODNN7EXAMPLE',
  },
  {
    name: 'github_pat',
    provider: null,
    pattern: /\bghp_[A-Za-z0-9]{36}\b/g,
    control: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  },
  {
    name: 'stripe_secret_key',
    provider: null,
    pattern: /\bsk_live_[A-Za-z0-9]{24,}/g,
    control: 'sk_live_' + 'A1b2C3d4E5f6G7h8I9j0K1l2',
  },
  {
    name: 'slack_token',
    provider: null,
    pattern: /\bxox[bpras]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{20,}/g,
    control: 'xoxb-' + '1234567890-0987654321-A1b2C3d4E5f6G7h8I9j0',
  },
  {
    // Matched on the ARMOUR HEADER alone rather than on a whole block. A key
    // truncated by an editor, or one committed with its body on a single line,
    // is still a key; requiring the closing line would let either through.
    //
    // The control is split across a concatenation for the same reason every
    // other control here is: this file is itself scanned by
    // `__tests__/credential-scan.test.ts`, and a control written as one literal
    // would make the scanner report its own source. That is the
    // census-reads-its-own-explanation trap, and the repair is to make the text
    // not match rather than to exempt the file.
    name: 'private_key_block',
    provider: null,
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    control: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  },
];

/** One credential-shaped span in one blob. */
export interface CredentialFinding {
  /** Which {@link CREDENTIAL_PATTERNS} entry claimed the span. */
  readonly pattern: string;
  /** The blob's object id, in full. Immutable, so it identifies the content. */
  readonly blob: string;
  /** Byte offset of the match inside the blob. With `blob`, a unique identity. */
  readonly offset: number;
  /** How many characters the matched span is. Never the span itself. */
  readonly length: number;
  /**
   * The first eight characters and nothing else.
   *
   * Enough for a human to recognise the vendor and to match the value against
   * `provider_keys.key_prefix`, which `docs/runbooks/credential-rotation.md`
   * stores in the same form.
   */
  readonly prefix: string;
  /**
   * The first twelve hex characters of `sha256(value)`. The finding's IDENTITY.
   *
   * Not the blob and not the offset, and the difference decides whether this
   * mechanism is usable. A blob id changes every time its file is edited, so a
   * ledger keyed on one goes red on an unrelated edit to any file containing a
   * key-shaped literal — and this repository has four such literals in TEST
   * fixtures, each a positive control some other gate needs. Keyed on the VALUE,
   * editing the prose around a fixture changes nothing, adding a new key-shaped
   * literal is a reviewed line, and REPLACING a synthetic value with a real one
   * — the failure that matters — still fails.
   *
   * A digest of a credential is an exact-match oracle, and
   * `docs/runbooks/credential-rotation.md` says so about
   * `provider_keys.key_hash`. It is sound HERE and not there because of who can
   * read it: this file sits in the same repository as the blob it points at, so
   * anyone who can read the digest can already `git grep` the value. The
   * database column is readable by people who cannot read the credential, which
   * is what makes it an oracle rather than a pointer.
   */
  readonly fingerprint: string;
  /** Every path this blob has ever been committed at, sorted. */
  readonly paths: readonly string[];
}

/** What {@link scanGitHistory} read, so a caller can tell empty from broken. */
export interface CredentialScanResult {
  readonly findings: readonly CredentialFinding[];
  readonly blobsScanned: number;
  readonly bytesScanned: number;
  readonly commitsReachable: number;
}

/**
 * A blob larger than this is not read.
 *
 * Lockfiles and bundled assets dominate the byte count and hold no credentials;
 * the cap keeps a scan of this repository under five seconds. It is a real
 * limitation and is stated in the runbook rather than hidden here.
 */
const MAX_BLOB_BYTES = 2_000_000;

/**
 * Every pattern matches its own control.
 *
 * Run before every scan, not only in the test suite: a regex edited by one
 * character reports a clean history, and a clean history is what this whole
 * mechanism is trying to distinguish from a broken one. All failures are
 * collected rather than thrown on the first, so a bad edit to three patterns is
 * one round trip instead of three.
 */
export function assertPatternsMatchTheirControls(): void {
  const broken: string[] = [];
  for (const entry of CREDENTIAL_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (!entry.pattern.test(entry.control)) broken.push(entry.name);
    entry.pattern.lastIndex = 0;
  }
  if (broken.length > 0) {
    throw new Error(`credential patterns that no longer match their controls: ${broken.join(', ')}`);
  }
}

/**
 * Findings in one string, one per credential, ordered by offset.
 *
 * The catch-all `openai_compatible_key` claims the same span as `sk-ant-…` and
 * `sk-proj-…`, so a raw pass reports one credential twice under two names. The
 * containment pass below keeps the FIRST pattern in list order that claims a
 * span and drops anything inside it, which makes the specific vendor entries
 * authoritative and the catch-all what is left over. Two credentials that merely
 * sit near each other have disjoint spans and both survive.
 */
export function scanText(text: string): Omit<CredentialFinding, 'blob' | 'paths'>[] {
  const raw: (Omit<CredentialFinding, 'blob' | 'paths'> & { readonly rank: number })[] = [];
  CREDENTIAL_PATTERNS.forEach((entry, rank) => {
    entry.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = entry.pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        entry.pattern.lastIndex += 1;
        continue;
      }
      raw.push({
        pattern: entry.name,
        offset: match.index,
        length: match[0].length,
        prefix: match[0].slice(0, 8),
        fingerprint: createHash('sha256').update(match[0]).digest('hex').slice(0, 12),
        rank,
      });
    }
    entry.pattern.lastIndex = 0;
  });

  // Most specific first at a given position, then longest, so the survivor of an
  // overlap is the entry that names the vendor.
  raw.sort((a, b) => a.offset - b.offset || a.rank - b.rank || b.length - a.length);

  const kept: Omit<CredentialFinding, 'blob' | 'paths'>[] = [];
  let coveredTo = -1;
  for (const { rank: _rank, ...finding } of raw) {
    if (finding.offset < coveredTo) continue;
    kept.push(finding);
    coveredTo = finding.offset + finding.length;
  }
  return kept;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
}

/**
 * Every blob reachable from `HEAD`, scanned.
 *
 * Throws on a shallow clone. That is the whole reason this function can be
 * trusted in CI: `actions/checkout` fetches one commit unless told otherwise, a
 * one-commit scan of this repository finds nothing, and nothing is what a clean
 * repository also reports. Refusing is the only answer that tells those apart.
 */
export async function scanGitHistory(repoRoot: string): Promise<CredentialScanResult> {
  assertPatternsMatchTheirControls();

  if (git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error(
      'refusing to scan a shallow clone: it holds none of the history this check exists to read. ' +
        'Fetch with depth 0 (actions/checkout: `fetch-depth: 0`).',
    );
  }

  const commitsReachable = Number(git(repoRoot, ['rev-list', '--count', 'HEAD']).trim());

  // `<sha> <path>` for blobs and trees, a bare `<sha>` for commits and tags.
  // The path is kept because a finding without one is a finding nobody can act
  // on, and a blob can have been committed at several paths over its life.
  const pathsByBlob = new Map<string, string[]>();
  for (const line of git(repoRoot, ['rev-list', '--objects', 'HEAD']).split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const sha = line.slice(0, space);
    const filePath = line.slice(space + 1);
    const existing = pathsByBlob.get(sha);
    if (existing === undefined) pathsByBlob.set(sha, [filePath]);
    else if (!existing.includes(filePath)) existing.push(filePath);
  }

  return await readBlobs(repoRoot, pathsByBlob, commitsReachable);
}

/**
 * Stream the candidate objects through one `git cat-file` and scan each blob.
 *
 * One long-lived process rather than one per object: this repository has ~10 000
 * of them, and a process launch each would dominate the runtime by two orders of
 * magnitude.
 */
function readBlobs(
  repoRoot: string,
  pathsByBlob: ReadonlyMap<string, string[]>,
  commitsReachable: number,
): Promise<CredentialScanResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch', '--buffer'], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const findings: CredentialFinding[] = [];
    let blobsScanned = 0;
    let bytesScanned = 0;
    let pending = Buffer.alloc(0);
    let stderr = '';

    const consume = (): void => {
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) return;
        const header = pending.subarray(0, newline).toString('utf8');
        const [sha, type, sizeText] = header.split(' ');
        if (type === undefined || sizeText === undefined) {
          // `<sha> missing` — impossible for an id git itself just listed, so
          // it is a real failure rather than something to skip past.
          reject(new Error(`git cat-file could not read an object it listed: ${header}`));
          child.kill();
          return;
        }
        const size = Number(sizeText);
        // header + '\n' + body + '\n'
        if (pending.length < newline + 1 + size + 1) return;
        const body = pending.subarray(newline + 1, newline + 1 + size);
        pending = pending.subarray(newline + 1 + size + 1);

        if (type !== 'blob') continue;
        blobsScanned += 1;
        bytesScanned += size;
        // A blob holding a NUL byte is not source: scanning a PNG or a font for
        // `sk-…` produces matches that mean nothing and cost a human an hour.
        if (size > MAX_BLOB_BYTES || body.includes(0)) continue;

        const paths = [...(pathsByBlob.get(sha) ?? [])].sort();
        for (const hit of scanText(body.toString('utf8'))) {
          findings.push({ ...hit, blob: sha, paths });
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      consume();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file exited ${String(code)}: ${stderr.trim()}`));
        return;
      }
      findings.sort(
        (a, b) =>
          a.blob.localeCompare(b.blob) || a.offset - b.offset || a.pattern.localeCompare(b.pattern),
      );
      resolve({ findings, blobsScanned, bytesScanned, commitsReachable });
    });

    child.stdin.end([...pathsByBlob.keys()].join('\n') + '\n');
  });
}
