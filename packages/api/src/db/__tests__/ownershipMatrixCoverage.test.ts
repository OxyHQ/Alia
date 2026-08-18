/**
 * The migration ownership matrix must keep describing THIS repository.
 *
 * `docs/migration/ownership-matrix.json` is the machine-readable answer to
 * "who owns this, and what has to be true before it leaves Alia" for every
 * package, table, route, screen and behaviour in issue #139's scope. A document
 * like that rots in one direction only: the repository moves, the matrix does
 * not, and it goes on reading as authoritative while naming files that were
 * deleted three PRs ago. Nothing else in this repo would notice.
 *
 * ## What each assertion is for
 *
 * **Existence.** Every `currentPath` names a real path, UNLESS the row records
 * the PR that removed it in `removedIn`. This is what catches drift as the
 * epic's deletions land: delete a file without touching its row and this goes
 * red, which is the moment to decide whether the row is done or merely stale.
 *
 * A removed row is annotated, never deleted. Deleting it would take the record
 * of why the code was safe to remove with it, and every `dependsOn` pointing at
 * it would dangle — the rows that survive cite the removed ones as the reason
 * they are unreachable. `removedIn` is checked in BOTH directions: a row that
 * claims removal while its file still exists is as wrong as an unannotated gap,
 * and without that half the field is just a way to silence this test.
 *
 * **Exact count on the removed set.** `REMOVED_ROW_COUNT` is asserted exactly,
 * for the same reason `NOT_APPLICABLE_COUNT` is. A gate whose input the
 * migration deletes erodes to vacuity one defensible decrement at a time,
 * ending at a check over nothing; the removed count is the number that has to
 * move, visibly, in the commit that does the removing. Its complement — the
 * rows whose file must STILL exist — carries a floor for the same reason.
 *
 * **Coverage of `internal/providers/**`.** That directory is what the epic
 * exists to dismantle, so every file in it must be a DECISION: mapped by a row,
 * or listed in `NOT_APPLICABLE` with a reason. Being in neither fails. A gate
 * that silently skips what is missing from a hand-maintained map is not a gate
 * — it reports clean for exactly the file nobody remembered.
 *
 * **Exact count on the exemptions.** `NOT_APPLICABLE` is asserted at its exact
 * length, not a floor. An exemption list with a floor is a gate switching
 * itself off one defensible line at a time; growing it has to be a visible
 * edit to a number, in the same commit as the entry.
 *
 * ## Vacuity
 *
 * Each half is floored. An empty matrix and a matrix with no gaps produce the
 * same "no unmapped files" verdict, and a `git ls-files` pathspec that matches
 * nothing produces the same verdict again — so the row count and the file count
 * are both asserted non-zero, and the enumeration is asserted to have seen a
 * file that is known to be there.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const MATRIX_PATH = 'docs/migration/ownership-matrix.json';

/** The subtree the epic dismantles, and therefore the one that must be fully classified. */
const GOVERNED_PREFIX = 'packages/api/src/internal/providers/';

/**
 * Files under {@link GOVERNED_PREFIX} that are deliberately NOT matrix rows.
 *
 * A test is not a migration item: it has no owner, no target path and no
 * removal gate of its own — it moves or dies with the module it exercises, and
 * that module IS mapped. Anything else in this directory is a decision somebody
 * has to write down.
 *
 * The count below is exact. Adding an entry here means editing that number in
 * the same commit, which is the point.
 */
const NOT_APPLICABLE: Readonly<Record<string, string>> = {
  'packages/api/src/internal/providers/lib/__tests__/fallback-engine-policy.test.ts':
    'Test of fallback-engine.ts, which is mapped (row `fallback-engine`). Moves or dies with it.',
  'packages/api/src/internal/providers/lib/__tests__/fallback-engine-preset.test.ts':
    'Test of fallback-engine.ts, which is mapped (row `fallback-engine`). Moves or dies with it.',
  'packages/api/src/internal/providers/lib/__tests__/fallback-engine-concrete-model.test.ts':
    'Test of fallback-engine.ts, which is mapped (row `fallback-engine`), against the catalogue’s own classifier. Moves or dies with it.',
  'packages/api/src/internal/providers/lib/__tests__/provider-health.test.ts':
    'Test of provider-health.ts, which is mapped (row `provider-health`). Moves or dies with it.',
  'packages/api/src/internal/providers/lib/__tests__/tts-providers.test.ts':
    'Test of tts-providers.ts, which is mapped (row `tts-providers`). Moves or dies with it.',
  'packages/api/src/internal/providers/lib/__tests__/routing-capability-coverage.test.ts':
    'Test of generate-model-mappings.ts and model-capabilities-data.ts, both mapped (rows `tier-mappings-generated` and `model-capabilities-data`). Moves or dies with them.',
  'packages/api/src/internal/providers/lib/__tests__/model-publishers.test.ts':
    'Test of model-publishers.ts and the publisher column in generate-model-mappings.ts, both mapped (rows `tuple-model-publishers` and `tier-mappings-generated`). Moves or dies with them.',
  'packages/api/src/internal/providers/lib/__tests__/credential-redaction.test.ts':
    'Test of provider-error-body.ts, which is mapped (row `provider-error-body`), and of lib/logger.ts, which is not in this subtree. Moves or dies with them.',
  'packages/api/src/internal/providers/lib/__tests__/key-expiry.test.ts':
    'Test of key-manager.ts, which is mapped (row `key-manager`). Moves or dies with it.',
};
const NOT_APPLICABLE_COUNT = 9;

interface MatrixRow {
  readonly id: string;
  readonly workstream: string;
  readonly domain: string;
  readonly kind: string;
  readonly currentPath: string;
  /** The PR that deleted `currentPath`. Present only on rows whose file is gone. */
  readonly removedIn?: string;
  readonly reachable: string;
  readonly owner: string;
  readonly targetPath: string;
  readonly dependsOn: readonly string[];
  readonly removalGate: string;
  readonly provenance: string;
  readonly evidence: string;
}

/**
 * Rows whose `currentPath` this repository no longer contains.
 *
 * Exact, not a floor. Removing more code means editing this number in the same
 * commit — which is the only thing standing between "the epic is deleting
 * things" and "the matrix has quietly stopped describing anything".
 *
 * 40 as of #139 ws7, over 37 distinct paths: 18 rows on 16 paths under
 * `internal/providers/**`, 20 rows on 19 paths under
 * `packages/alia-gateway-admin/`, one on
 * `packages/api/src/lib/tools/gateway-admin.ts` — the AI-callable tool that
 * proxied provider-key CRUD to the deleted gateway, removed by #166 — and one
 * on `packages/integrations/src/shared/model-resolver.ts`, the SECOND service's
 * copy of provider construction, removed by #184. Three paths carry two rows
 * each, because two separate migration subjects lived in one file.
 *
 * The row that did NOT move is `sdk-integrations-ai-sdk`: the three `@ai-sdk/*`
 * dependencies it covers went in the same commit, but its `currentPath` is a
 * `package.json` that still exists, so it may not claim `removedIn` — the
 * existence check would fail it, correctly. Gate 7 of
 * `src/__tests__/architectureGates.test.ts` verifies that row instead, by
 * asserting `packages/api` is the only manifest declaring a provider SDK. A
 * dependency row is the one shape this file's existence check cannot see.
 */
const REMOVED_ROW_COUNT = 40;

const OWNERS = new Set(['alia', 'oxy', 'relay', 'delete']);
const REACHABLE = new Set(['live', 'dead', 'unverified', 'loaded-not-invoked']);

/**
 * Parse without `as` and without trusting the file's shape.
 *
 * A cast would make a malformed matrix — a truncated write, a row missing
 * `currentPath` — read as a matrix with fewer properties, and every assertion
 * below would then quietly measure `undefined`.
 */
function readMatrix(): MatrixRow[] {
  const parsed: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, MATRIX_PATH), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('rows' in parsed)) {
    throw new Error(`${MATRIX_PATH} has no "rows"`);
  }
  const { rows } = parsed as { rows: unknown };
  if (!Array.isArray(rows)) throw new Error(`${MATRIX_PATH} "rows" is not an array`);
  return rows.map((row, index) => {
    if (typeof row !== 'object' || row === null) throw new Error(`row ${index} is not an object`);
    const r = row as Record<string, unknown>;
    for (const field of ['id', 'workstream', 'domain', 'kind', 'currentPath', 'reachable',
      'owner', 'targetPath', 'removalGate', 'provenance', 'evidence']) {
      if (typeof r[field] !== 'string' || r[field] === '') {
        throw new Error(`row ${index} (${String(r.id)}): missing ${field}`);
      }
    }
    if (!Array.isArray(r.dependsOn)) throw new Error(`row ${index}: dependsOn is not an array`);
    // Optional, but not free-form: an empty or non-string `removedIn` would
    // satisfy `'removedIn' in row` and exempt the row from the existence check
    // while recording nothing about who removed it.
    if (r.removedIn !== undefined && (typeof r.removedIn !== 'string' || r.removedIn === '')) {
      throw new Error(`row ${index} (${String(r.id)}): removedIn is present but not a non-empty string`);
    }
    return row as MatrixRow;
  });
}

/** Every tracked file under the governed subtree, read off git rather than a hand list. */
function governedFiles(): string[] {
  return execFileSync('git', ['ls-files', GOVERNED_PREFIX], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '');
}

const matrix = readMatrix();
const governed = governedFiles();
const mappedPaths = new Set(matrix.map((r) => r.currentPath));

describe('the ownership matrix still describes this repository', () => {
  it('found a matrix and a subtree at all', () => {
    /**
     * The vacuity floor for both halves. An empty `rows` array satisfies every
     * "no bad row" assertion below, and a pathspec that matches nothing
     * satisfies every "every file is classified" assertion.
     *
     * 300 rather than 356 (the count at the time of writing) so that ordinary
     * consolidation does not fail the build; it goes DOWN only when a whole
     * domain has finished migrating, which is a deliberate edit.
     *
     * The governed floor was 50 against 60 files. #141 deleted 16 of them,
     * leaving 44, so the floor moves to 40 — a deliberate edit in the commit
     * that removed the files, which is the only way it is allowed to move. It
     * cannot be decremented to nothing: the 22 adapter files under
     * `lib/providers/` are the last thing this epic retires, so a floor below
     * that is measuring a subtree that has already finished migrating.
     */
    expect(matrix.length).toBeGreaterThanOrEqual(300);
    expect(governed.length).toBeGreaterThanOrEqual(40);

    // Positive control on the enumeration: a file known to be in that subtree.
    // Without it, a renamed directory reads as "everything is classified".
    expect(governed).toContain('packages/api/src/internal/providers/lib/providers/openai.ts');
  });

  it('every currentPath still exists, unless the row says which PR removed it', () => {
    const exists = (r: MatrixRow) => existsSync(path.join(REPO_ROOT, r.currentPath));
    const fmt = (r: MatrixRow) => `${r.id} -> ${r.currentPath}`;

    // A file that vanished without anybody annotating the row. This is the
    // drift the gate exists to catch.
    expect(matrix.filter((r) => r.removedIn === undefined && !exists(r)).map(fmt)).toEqual([]);

    // The other direction, which is what stops `removedIn` from becoming a way
    // to switch this test off: a row may only claim removal if the file really
    // is gone.
    expect(matrix.filter((r) => r.removedIn !== undefined && exists(r)).map(fmt)).toEqual([]);

    // Exact, so removing more code has to move a number in the same commit.
    expect(matrix.filter((r) => r.removedIn !== undefined)).toHaveLength(REMOVED_ROW_COUNT);

    /**
     * Floors, both halves. The first assertion above is satisfied by a matrix
     * in which every row is annotated as removed, which is precisely the end
     * state this gate must not slide into; the floor on rows whose file must
     * still exist is what makes that visible. 250 rather than the 318 of the
     * day, so ordinary consolidation does not fail the build.
     */
    expect(matrix.filter((r) => r.removedIn === undefined).length).toBeGreaterThanOrEqual(250);
    expect(new Set(matrix.map((r) => r.currentPath)).size).toBeGreaterThanOrEqual(150);
  });

  it('every file under internal/providers is mapped or explicitly not applicable', () => {
    const unclassified = governed.filter(
      (f) => !mappedPaths.has(f) && NOT_APPLICABLE[f] === undefined,
    );

    expect(unclassified).toEqual([]);
  });

  it('the not-applicable list is exactly as long as it says, and every entry is real', () => {
    // Exact, not a floor: an exemption list that may grow silently is the gate
    // disarming itself.
    expect(Object.keys(NOT_APPLICABLE)).toHaveLength(NOT_APPLICABLE_COUNT);

    // An exemption for a file that no longer exists, or for one that lives
    // outside the governed subtree, exempts nothing and hides the fact.
    const stale = Object.keys(NOT_APPLICABLE).filter(
      (f) => !governed.includes(f) || !f.startsWith(GOVERNED_PREFIX),
    );
    expect(stale).toEqual([]);

    // The two lists partition: a file that is both mapped and exempt would let
    // a row be deleted without the coverage check noticing.
    const both = Object.keys(NOT_APPLICABLE).filter((f) => mappedPaths.has(f));
    expect(both).toEqual([]);
  });

  it('rows are unique, sorted by id, and depend only on ids that exist', () => {
    /**
     * Sortedness is not cosmetic: the matrix is regenerated, and an unsorted
     * regeneration buries the semantic diff under a reshuffle, which is how a
     * changed owner or a weakened gate gets reviewed as "just noise".
     */
    const ids = matrix.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);

    const known = new Set(ids);
    const dangling = matrix.flatMap((r) =>
      r.dependsOn.filter((d) => !known.has(d)).map((d) => `${r.id} -> ${d}`),
    );
    expect(dangling).toEqual([]);
  });

  it('every row carries a legal owner and reachability verdict', () => {
    const bad = matrix
      .filter((r) => !OWNERS.has(r.owner) || !REACHABLE.has(r.reachable))
      .map((r) => `${r.id}: owner=${r.owner} reachable=${r.reachable}`);

    expect(bad).toEqual([]);
  });
});
