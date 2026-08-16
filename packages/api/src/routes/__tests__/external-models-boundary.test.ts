import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The external-models leaderboard — epic #139 workstream 10, *"External models
 * leaderboard"*, two of its four boxes:
 *
 *  - *"Keep it explicitly separate from executable deployments"*
 *  - *"Never route based solely on leaderboard rows"*
 *
 * `external_models` is a read-only mirror of a third-party benchmark table
 * (`scripts/sync-zeroeval.ts`). It says which models exist in the world and how
 * they score. It says nothing about which of them Alia can call, with whose key,
 * through which provider — that is `model_configs`, `alia_models` and
 * `provider_keys`, and the two sets barely overlap.
 *
 * ## What was measured before this file was written
 *
 * Nothing routes on it today. Five source files reference it: the repository,
 * the schema, the read-only route, that route's mount, and the sync script.
 * Nothing under `lib/routing`, `lib/chat-core.ts` or `internal/providers` names
 * it at all.
 *
 * So this is a guard on a property that HOLDS, and the whole risk is that a
 * clean result means nothing. A census that reads the wrong file list, or a
 * pattern that matches nothing, prints exactly the reassuring answer below. Both
 * assertions therefore carry a positive control in the same currency: the same
 * pipeline, pointed at the ROUTING catalogue, must find the routing modules —
 * because if it cannot see a reader that is there, its silence about a reader
 * that is not there is worth nothing.
 *
 * ## Why the temptation is real rather than hypothetical
 *
 * The table carries `inputPrice`, `outputPrice`, `throughput`, `latency` and
 * eighteen benchmark columns. Those are precisely the inputs a "route to the
 * cheapest model that scores above X" feature would want, and workstream 14
 * describes latency/cost/quality optimisation as routing policy. The rows are
 * about models Alia may have no key for, no mapping for and no permission to
 * serve — a route chosen from them alone is a route to nothing.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const API_SRC = path.join(REPO_ROOT, 'packages/api/src');

/** Source with comments stripped, so a census cannot read this repo's prose. */
function code(relative: string): string {
  const text = readFileSync(path.join(API_SRC, relative), 'utf8');
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      ranges.push([comment.pos, comment.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

/**
 * Every tracked, non-test source file under the API.
 *
 * `git ls-files` is blind to an UNTRACKED file, which is how a census like this
 * stays green while the very thing it forbids sits in the working tree. Measured
 * while writing this file: a `lib/routing/leaderboard-router.ts` that picks a
 * model by benchmark score left all six tests GREEN until it was `git add`-ed,
 * at which point the five-file equality went red. So a clean run of this file is
 * a statement about the INDEX, not about the working tree. The floor below
 * catches the other half, a pathspec that matched nothing.
 */
function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'packages/api/src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'))
    .map((file) => path.relative(API_SRC, path.join(REPO_ROOT, file)));
}

/** Files whose CODE (not prose) names any of the given identifiers. */
function referencing(needles: readonly string[]): string[] {
  return sourceFiles()
    .filter((relative) => {
      const source = code(relative);
      return needles.some((needle) => source.includes(needle));
    })
    .sort();
}

/**
 * Every file allowed to know the leaderboard exists, and why.
 *
 * Exact, not a subset. A sixth file fails here, and the fix at that moment is to
 * ask what it is doing rather than to add a line.
 */
const LEADERBOARD_READERS: Readonly<Record<string, string>> = {
  'db/providers/externalModelRepository.ts': 'the repository itself',
  'db/schema/providers.ts': 'the table definition',
  'index.ts': 'mounts the read-only route',
  'routes/external-models.ts': 'the read-only route',
  'scripts/sync-zeroeval.ts': 'the one-shot mirror sync, not part of the serving process',
};

/**
 * The modules a request passes through between `model` and a provider call.
 *
 * Derived by following `resolveModel`: `lib/chat-core.ts` delegates to
 * `internal/providers/lib/model-resolver.ts`, which reads the candidate list
 * from `alia-models.ts` and hands it to `fallback-engine.ts`, which picks a key
 * through `key-manager.ts` and checks `provider-health.ts`. `lib/routing/*` is
 * the policy those consult, and `lib/gateway-client.ts` is the seam in front of
 * the whole thing.
 *
 * This list is hand-maintained and therefore cannot catch a NEW routing module —
 * a check that skips what is missing from its map is not a check. It earns its
 * place by naming the offending module in the failure; the exhaustive backstop
 * is the five-file census above, which is repo-wide and has no map to fall out
 * of. Measured: a new `lib/routing/leaderboard-router.ts` is invisible to this
 * loop and is caught by that equality.
 */
const ROUTING_PATH = [
  'lib/chat-core.ts',
  'lib/gateway-client.ts',
  'lib/routing/policy.ts',
  'lib/routing/presets.ts',
  'internal/providers/lib/model-resolver.ts',
  'internal/providers/lib/fallback-engine.ts',
  'internal/providers/lib/alia-models.ts',
  'internal/providers/lib/key-manager.ts',
  'internal/providers/lib/provider-health.ts',
] as const;

const LEADERBOARD_NEEDLES = ['externalModel', 'external_models', 'external-models'] as const;
/** The routing catalogue, used as the positive control for every census here. */
const CATALOGUE_NEEDLES = ['aliaModelRepository', 'ALIA_MODELS'] as const;

describe('nothing routes on the leaderboard (#139 ws10)', () => {
  it('the census sees the whole tree, and can see a real reader', () => {
    // Two floors and a control, before any negative claim is made.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(400);
    // It found the leaderboard where the leaderboard is.
    expect(referencing(LEADERBOARD_NEEDLES)).toContain('routes/external-models.ts');
    // And it finds the ROUTING catalogue in routing modules — the control that
    // makes the empty result below evidence of absence rather than of blindness.
    const catalogueReaders = referencing(CATALOGUE_NEEDLES);
    expect(catalogueReaders).toContain('internal/providers/lib/model-resolver.ts');
    expect(catalogueReaders).toContain('internal/providers/lib/fallback-engine.ts');
    expect(catalogueReaders.length).toBeGreaterThanOrEqual(3);
  });

  it('is referenced by exactly the five files that mirror and serve it', () => {
    expect(referencing(LEADERBOARD_NEEDLES)).toEqual(Object.keys(LEADERBOARD_READERS).sort());
  });

  it('no module on the request path between a model id and a provider names it', () => {
    // Per-file rather than as a set difference, so a red run says WHICH module
    // started reading benchmark rows.
    for (const module of ROUTING_PATH) {
      const source = code(module);
      // The floor, per file: it was read and it is the module it claims to be.
      expect(source.length, `${module} read as empty`).toBeGreaterThan(200);
      for (const needle of LEADERBOARD_NEEDLES) {
        expect(source.includes(needle), `${module} routes on leaderboard rows`).toBe(false);
      }
    }

    // The control for the loop above, in the same currency: these same files DO
    // name the routing catalogue, so "does not contain" is a fact about the
    // needle and not about a loop that never ran or a `code()` returning blanks.
    expect(code('internal/providers/lib/model-resolver.ts')).toContain('ALIA_MODELS');
    expect(code('internal/providers/lib/fallback-engine.ts')).toContain('TIER_MODEL_MAPPINGS');
    expect(ROUTING_PATH.length).toBeGreaterThanOrEqual(9);
  });

  it('the resolver takes its candidates from the executable catalogue', () => {
    // The positive statement behind the negative one. "Never route SOLELY on
    // leaderboard rows" is satisfied trivially while nothing reads them; what
    // keeps it satisfied is that the candidate list has an owner, and the owner
    // is the table that knows about keys and mappings.
    const resolver = code('internal/providers/lib/model-resolver.ts');
    expect(resolver).toContain("from './alia-models'");
    expect(resolver).toMatch(/isAliaModel|getAliaModel/);

    const models = code('internal/providers/lib/alia-models.ts');
    expect(models).toContain("from '../../../db/providers/aliaModelRepository.js'");
  });
});

describe('the leaderboard is separate from executable deployments (#139 ws10)', () => {
  it('its table joins nothing — no foreign key out of it', () => {
    const schema = code('db/schema/providers.ts');

    /** The body of one `pgTable` declaration, up to the next export. */
    const tableBody = (name: string): string => {
      const start = schema.indexOf(`export const ${name} = pgTable(`);
      expect(start, `${name} is not where this test looks`).toBeGreaterThan(-1);
      const end = schema.indexOf('export const', start + 10);
      return end === -1 ? schema.slice(start) : schema.slice(start, end);
    };

    const table = tableBody('externalModels');
    // The floor: a real table body was sliced, not an empty string.
    expect(table).toContain("'external_models'");
    expect(table).toContain('modelId: text().notNull()');
    expect(table.length).toBeGreaterThan(1_000);

    // `canonicalModelId` is a plain text column and must stay one: making it a
    // reference is the single edit that would turn a benchmark mirror into part
    // of the routing catalogue's graph.
    expect(table).toContain('canonicalModelId: text()');
    expect(table).not.toContain('references(');

    // The control, taken from the SAME file with the SAME slicer: `providerKeys`
    // does have a foreign key, so "no references" is a property of
    // `external_models` and not of a slice that came back blank or of a search
    // that never matches.
    expect(tableBody('providerKeys')).toContain('references(() => organizations.id');
  });

  it('its route is read-only, and mounted outside the catalogue', () => {
    const route = code('routes/external-models.ts');
    // Only GET. A write route here would make the mirror editable, and an edited
    // mirror is no longer a mirror of anything.
    expect([...route.matchAll(/router\.(get|post|put|patch|delete)\(/g)].map((m) => m[1])).toEqual([
      'get',
      'get',
      'get',
    ]);
    // And the repository it reaches for exposes no writer to this route: the
    // one writer, `upsertExternalModels`, belongs to the sync script
    // (`routes/__tests__/inference-boundary.test.ts` holds that map).
    expect(route).not.toContain('upsertExternalModels');

    const index = code('index.ts');
    expect(index).toContain("app.use('/external-models', externalModelsRouter)");
    // Not under `/v1`, which is the generic inference surface: the leaderboard
    // is not part of the model catalogue a client routes against.
    expect(index).not.toContain("'/v1/external-models'");
  });
});
